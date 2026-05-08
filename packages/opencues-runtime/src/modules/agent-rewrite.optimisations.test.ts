/**
 * AgentRewrite efficiency-optimisation scenarios.
 *
 * The four optimisations under test (May 2026):
 *   1. Skip-on-stable: when the snapshot equals the last-stable buffer
 *      AND the task hasn't changed, no LLM call.
 *   2. (snapshot, task, cursor, window) → rewrite cache: identical input
 *      reuses the prior LLM result. Bounded LRU.
 *   3. Event-driven scheduler: ticks fire only after onTextChange,
 *      debounced. Idle = no calls.
 *   4. Sliding-window mode: when windowWords > 0 and the doc has more
 *      words than the window, only cursor-centred N words go to the LLM;
 *      the rewrite is spliced back into the unchanged surrounding text
 *      before the merge.
 *
 * Each test asserts on the LLM call count so a regression that re-adds
 * an unnecessary call is caught immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRewrite, computeWindow } from './agent-rewrite';
import { AgentTaskState } from '../state/agent-task';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function llmResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

describe('AgentRewrite — skip-on-stable (no LLM call when buffer is stable)', () => {
  it('second tick on same buffer + task = no LLM call', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I write stuff.', 14);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        // LLM returns the buffer unchanged (already correct).
        return llmResponse('REWRITTEN:\nI write stuff.\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(calls).toBe(1);
    // Round 1 detected no-op (rewrite identical to snapshot) → marked stable.
    await r.tick();
    expect(calls).toBe(1);                        // no second LLM call
    await r.tick();
    expect(calls).toBe(1);                        // and no third
  });

  it('user edit invalidates the stable marker — next tick calls LLM', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I write stuff.', 14);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        const live = adapter.getText();
        return llmResponse(`REWRITTEN:\n${live}\nEND`);
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(calls).toBe(1);
    await r.tick();
    expect(calls).toBe(1);                        // still stable

    adapter.pushText('I write more stuff.', 19);  // user edit
    await r.tick();
    expect(calls).toBe(2);                        // stable marker invalidated → LLM called
  });

  it('task change invalidates the stable marker — next tick calls LLM', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I write stuff.', 14);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        return llmResponse('REWRITTEN:\nI write stuff.\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(calls).toBe(1);
    state.arm('translate to German');             // task changed
    await r.tick();
    expect(calls).toBe(2);
  });
});

describe('AgentRewrite — (snapshot, task, cursor) → rewrite cache', () => {
  it('repeating an exact (snapshot, task, cursor) reuses cached rewrite', async () => {
    // Backspace + retype scenario: user types A, agent rewrites to B,
    // user backspaces back to A's exact char-by-char state. Cache hit.
    const adapter = new MockAdapter({});
    adapter.pushText('I rite', 6);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        return llmResponse('REWRITTEN:\nI write\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(adapter.getText()).toBe('I write');
    expect(calls).toBe(1);
    // Roll back to "I rite" — same snapshot+task+cursor as the very first round.
    adapter.pushText('I rite', 6);
    await r.tick();
    // Cache hit: no second LLM call. (Anti-oscillation may suppress
    // re-applying since "I write" was the prior applied state — that's
    // a separate guarantee. The cache contract here is only about the
    // call count.)
    expect(calls).toBe(1);
  });

  it('different cursor positions are cached separately', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('hello world', 5);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        return llmResponse('REWRITTEN:\nhello world\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(calls).toBe(1);
    // Same buffer + task, but cursor moved. Different cache key.
    adapter.setCursorOffset(11);
    state.arm('fix typos');                       // re-arm to reset stable marker
    await r.tick();
    expect(calls).toBe(2);
  });
});

describe('AgentRewrite — event-driven scheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start() arms a tick on initial schedule', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('hello', 5);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => { calls += 1; return llmResponse('REWRITTEN:\nhello\nEND'); },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter, cadenceMs: 100,
    });
    r.start();
    expect(calls).toBe(0);                        // debounced — not fired yet
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(1);                        // initial tick fired
    r.stop();
  });

  it('idle (no text-change) after start = no further ticks', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('hello', 5);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => { calls += 1; return llmResponse('REWRITTEN:\nhello\nEND'); },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter, cadenceMs: 100,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(1);                        // initial tick
    // Sit idle for several cadence windows. No timer fires now —
    // event-driven scheduler waits for text changes.
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);                        // still 1; old setInterval would have made 5
    r.stop();
  });

  it('text-change debounces a pending tick — burst fires once after settle', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('a', 1);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => { calls += 1; const live = adapter.getText(); return llmResponse(`REWRITTEN:\n${live}\nEND`); },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter, cadenceMs: 100,
    });
    r.start();
    // Drain the initial tick.
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(1);
    // Burst of typing within the debounce window.
    adapter.pushText('ab', 2);
    await vi.advanceTimersByTimeAsync(40);
    adapter.pushText('abc', 3);
    await vi.advanceTimersByTimeAsync(40);
    adapter.pushText('abcd', 4);
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toBe(1);                        // none of these have settled yet
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(2);                        // single tick after the burst settled
    r.stop();
  });

  it('stop() cancels a pending debounce', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('hi', 2);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => { calls += 1; return llmResponse('REWRITTEN:\nhi\nEND'); },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter, cadenceMs: 100,
    });
    r.start();
    r.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(0);
  });
});

describe('AgentRewrite — sliding-window mode', () => {
  it('computeWindow returns full range when windowWords is 0', () => {
    const w = computeWindow('one two three four five', 10, 0);
    expect(w).toEqual({ start: 0, end: 23 });
  });

  it('computeWindow returns full range when buffer has fewer words than window', () => {
    const w = computeWindow('one two three', 5, 100);
    expect(w).toEqual({ start: 0, end: 13 });
  });

  it('computeWindow returns the cursor’s paragraph (paragraphs are atomic)', () => {
    const text = 'paragraph one alpha bravo.\n\nparagraph two charlie delta echo foxtrot golf.\n\nparagraph three hotel india juliet.';
    const cursorIdx = text.indexOf('echo');
    const w = computeWindow(text, cursorIdx, 4);
    expect(text.slice(w.start, w.end)).toBe('paragraph two charlie delta echo foxtrot golf.');
  });

  it('computeWindow handles cursor at start (no preceding break)', () => {
    const text = 'first para.\n\nsecond para.';
    const w = computeWindow(text, 3, 1);
    expect(text.slice(w.start, w.end)).toBe('first para.');
  });

  it('computeWindow handles cursor in last paragraph (no following break)', () => {
    const text = 'first para.\n\nsecond para extends here.';
    const w = computeWindow(text, text.length - 5, 1);
    expect(text.slice(w.start, w.end)).toBe('second para extends here.');
  });

  it('windowed callLLM splices rewrite back into surrounding text', async () => {
    // Three paragraphs. Cursor in middle. windowWords pulls the middle
    // one only. LLM rewrites it; outer paragraphs survive untouched.
    const text = 'first para untouched.\n\nthe middle para has typoo.\n\nthird para untouched.';
    const adapter = new MockAdapter({});
    adapter.pushText(text, text.indexOf('typoo') + 5);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let receivedDoc = '';
    const httpAdapter = {
      post: async (_url: string, body: string) => {
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
        receivedDoc = parsed.messages[1].content;
        // LLM only sees the middle paragraph; rewrites typoo→typo.
        return llmResponse('REWRITTEN:\nthe middle para has typo.\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
      windowWords: () => 4,
    });
    await r.tick();
    // LLM input was windowed (didn't include first/third paragraphs).
    expect(receivedDoc).not.toContain('first para untouched');
    expect(receivedDoc).not.toContain('third para untouched');
    expect(receivedDoc).toContain('typoo');
    // Final buffer has the typo fixed AND the outer paragraphs preserved.
    expect(adapter.getText()).toBe('first para untouched.\n\nthe middle para has typo.\n\nthird para untouched.');
  });

  it('windowWords=0 sends full buffer (back-compat for the default config)', async () => {
    const text = 'alpha bravo charlie delta echo foxtrot.';
    const adapter = new MockAdapter({});
    adapter.pushText(text, text.length);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let receivedDoc = '';
    const httpAdapter = {
      post: async (_url: string, body: string) => {
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
        receivedDoc = parsed.messages[1].content;
        return llmResponse(`REWRITTEN:\n${text}\nEND`);
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
      // windowWords omitted entirely.
    });
    await r.tick();
    expect(receivedDoc).toContain('alpha bravo');
    expect(receivedDoc).toContain('foxtrot');
  });
});
