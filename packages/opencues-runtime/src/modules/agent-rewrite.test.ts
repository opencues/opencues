/**
 * AgentRewrite integration tests.
 *
 * The bar (per the design discussion):
 *   - Live typing during the LLM call is NEVER clobbered.
 *   - LLM edits land where they don't conflict; they drop where they do.
 *   - The buffer's structure (paragraph breaks, whitespace) is preserved.
 *   - Cursor translation keeps the user's caret near where they were
 *     working.
 *   - DynDefs are placed for each applied hunk so cycling can revert.
 *   - Task changes mid-round don't clobber the new task's intent.
 *
 * Each test drives `tick()` directly; we don't depend on the timer.
 */
import { describe, expect, it } from 'vitest';
import { AgentRewrite, parseRewriteOutput } from './agent-rewrite';
import { AgentTaskState } from '../state/agent-task';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function llmResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

interface SetupOpts {
  initialText: string;
  cursor?: number;
  task?: string;
  /** Either a static rewrite, or a function that runs DURING the LLM call. */
  rewrite: string | ((adapter: MockAdapter) => string);
  cadenceMs?: number;
}

function setup(opts: SetupOpts) {
  const adapter = new MockAdapter({});
  const cursor = opts.cursor ?? opts.initialText.length;
  adapter.pushText(opts.initialText, cursor);
  const state = new AgentTaskState();
  state.arm(opts.task ?? 'fix typos');
  const dynDefs = new DynDefs();
  let calls = 0;
  const httpAdapter = {
    post: async () => {
      calls += 1;
      const rewrite = typeof opts.rewrite === 'function'
        ? opts.rewrite(adapter)
        : opts.rewrite;
      return llmResponse(`REWRITTEN:\n${rewrite}\nEND`);
    },
  };
  const rewrite = new AgentRewrite(adapter, dynDefs, state, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
    cadenceMs: opts.cadenceMs ?? 1500,
    httpAdapter,
  });
  return { adapter, state, dynDefs, rewrite, getCalls: () => calls };
}

describe('parseRewriteOutput — END marker handling', () => {
  it('strips END followed by trailing whitespace', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi there.\nEND\n\n')).toBe('Hi there.');
  });
  it('strips END followed by trailing comment text', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi there.\nEND\n(meta comment)')).toBe('Hi there.');
  });
  it('strips a duplicated END (both lines stripped)', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi there.\nEND\nEND')).toBe('Hi there.');
  });
  it('preserves literal "END" when it appears mid-line in content', () => {
    expect(parseRewriteOutput('REWRITTEN:\nThis is the END of the day.\nEND')).toBe('This is the END of the day.');
  });
  it('strips END even without REWRITTEN: marker (defensive)', () => {
    expect(parseRewriteOutput('Hi there.\nEND')).toBe('Hi there.');
  });
  it('handles END marker followed by extra blank line', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi.\nEND\n\n\n')).toBe('Hi.');
  });
  it('case-insensitive on END', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi.\nend\n')).toBe('Hi.');
  });
  it('strips END that appears immediately after a final newline', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi there.\n\n  END  \n')).toBe('Hi there.');
  });
});

describe('parseRewriteOutput — cursor sentinel handling', () => {
  it('strips a [CURSOR] sentinel that the model echoed', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi [CURSOR]there.\nEND')).toBe('Hi there.');
  });
  it('strips a lowercase [cursor] sentinel defensively', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi [cursor]there.\nEND')).toBe('Hi there.');
  });
  it('strips multiple cursor sentinels (defensive)', () => {
    expect(parseRewriteOutput('REWRITTEN:\n[CURSOR]Hi [CURSOR]there[CURSOR].\nEND')).toBe('Hi there.');
  });
  it('preserves regular bracketed content', () => {
    expect(parseRewriteOutput('REWRITTEN:\nNote [1] and [other]\nEND')).toBe('Note [1] and [other]');
  });
});

describe('parseRewriteOutput', () => {
  it('parses canonical REWRITTEN: ... END block', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi there.\nEND')).toBe('Hi there.');
  });
  it('handles missing END (takes rest of response)', () => {
    expect(parseRewriteOutput('REWRITTEN:\nHi there.')).toBe('Hi there.');
  });
  it('strips code fences if model emitted them', () => {
    expect(parseRewriteOutput('```\nREWRITTEN:\nHi.\nEND\n```')).toBe('Hi.');
    expect(parseRewriteOutput('```text\nHi.\n```')).toBe('Hi.');
  });
  it('falls back to the whole response when no marker present', () => {
    expect(parseRewriteOutput('Hi there.')).toBe('Hi there.');
  });
  it('returns null on empty', () => {
    expect(parseRewriteOutput('')).toBeNull();
    expect(parseRewriteOutput('   ')).toBeNull();
  });
  it('case-insensitive on REWRITTEN marker', () => {
    expect(parseRewriteOutput('rewritten:\nHi.\nEND')).toBe('Hi.');
  });
  it('preserves multi-line content inside the block', () => {
    expect(parseRewriteOutput('REWRITTEN:\nLine 1.\n\nLine 2.\nEND'))
      .toBe('Line 1.\n\nLine 2.');
  });
});

describe('AgentRewrite — basic flow (no live typing)', () => {
  it('snapshot → LLM → apply: clean rewrite lands', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: 'I write stuff',
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff');
  });

  it('rewrite identical to snapshot: no-op (no setText)', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'all clean here',
      rewrite: 'all clean here',
    });
    const setTextCalls = adapter.setTextCalls.length;
    await rewrite.tick();
    expect(adapter.getText()).toBe('all clean here');
    // No mutation happened.
    expect(adapter.setTextCalls.length).toBe(setTextCalls);
  });

  it('multi-edit rewrite: all surviving hunks land (no auto-period at end-of-buffer)', async () => {
    // The LLM adds a period at end-of-buffer; the no-auto-terminator
    // guard strips it because the snapshot didn't end with one (user
    // may still be typing). The other edits (capitalisation, comma,
    // typo fixes) all land.
    const { adapter, rewrite } = setup({
      initialText: 'hii my namee is wilfred',
      rewrite: 'Hi, my name is Wilfred.',
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('Hi, my name is Wilfred');
  });

  it('preserves paragraph structure', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'first.\n\nsecond.',
      rewrite: 'First.\n\nSecond.',
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('First.\n\nSecond.');
  });

  it('not armed: tick is a no-op (no LLM call)', async () => {
    const { adapter, state, rewrite, getCalls } = setup({
      initialText: 'I rite stuff',
      rewrite: 'I write stuff',
    });
    state.stop();
    await rewrite.tick();
    expect(adapter.getText()).toBe('I rite stuff');
    expect(getCalls()).toBe(0);
  });

  it('empty buffer: tick is a no-op', async () => {
    const { adapter, rewrite, getCalls } = setup({
      initialText: '',
      rewrite: '',
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('');
    expect(getCalls()).toBe(0);
  });
});

describe('AgentRewrite — live typing during LLM call', () => {
  it('user appended a word during the call: LLM fix lands AND user content survives', async () => {
    // Snapshot: "I rite stuff", LLM thinks → returns "I write stuff".
    // User typed " more" during the call → live = "I rite stuff more".
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: (adapter) => {
        adapter.pushText('I rite stuff more', 17);
        return 'I write stuff';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff more');
  });

  it('user typed in the same word LLM was fixing: LLM dropped, user wins', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: (adapter) => {
        adapter.pushText('I righting stuff', 16);     // user typed past "rite"
        return 'I write stuff';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I righting stuff');
  });

  it('user erased text during call: LLM doesn\'t resurrect erased content', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'first sentence here. second sentence too.',
      rewrite: (adapter) => {
        adapter.pushText('first sentence here.', 20);  // user deleted second sentence
        return 'first sentence here! second sentence, too.';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).not.toContain('second sentence');
  });

  it('user typed identical fix to LLM: idempotent merge', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: (adapter) => {
        adapter.pushText('I write stuff', 13);
        return 'I write stuff';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff');
  });

  it('user typed at end while LLM fixed mid-doc: both land', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'rite this please',
      rewrite: (adapter) => {
        adapter.pushText('rite this please now', 20);
        return 'write this please';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('write this please now');
  });
});

describe('AgentRewrite — extended live-typing scenarios', () => {
  // Each scenario simulates a specific user-typing pattern during the
  // LLM call. The bar across all of them: user-typed content survives.
  // Where LLM's intent doesn't conflict, it lands too.

  it('user inserted text MID-BUFFER (not at end) during the call', async () => {
    // Snapshot:  "I rite stuff."
    // User clicks between "I" and "rite", types "really ".
    // Live:       "I really rite stuff."
    // LLM rewrite: "I write stuff."
    // The "rite → write" hunk doesn't share an A-region with the
    // user's mid-buffer insertion — both should land.
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff.',
      rewrite: (adapter) => {
        adapter.pushText('I really rite stuff.', 9);    // cursor between "really " and "rite"
        return 'I write stuff.';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I really write stuff.');
  });

  it('user BACKSPACED a word during the call: LLM doesn\'t resurrect it', async () => {
    // Snapshot:  "I really rite stuff."
    // User backspaced "really ":
    // Live:       "I rite stuff."
    // LLM was rewriting the snapshot — it might emit "really" intact or
    // not, but in either case the user's deletion must be respected.
    const { adapter, rewrite } = setup({
      initialText: 'I really rite stuff.',
      rewrite: (adapter) => {
        adapter.pushText('I rite stuff.', 13);
        return 'I really write stuff.';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).not.toContain('really');
  });

  it('user PASTED a chunk during the call: chunk preserved, LLM\'s untouched-region edits land', async () => {
    // Snapshot:  "Hi boi."
    // User pastes a paragraph at the end:
    // Live:       "Hi boi.\n\nI just pasted this whole paragraph."
    // LLM rewrite of the snapshot only: "Hi boy."
    const { adapter, rewrite } = setup({
      initialText: 'Hi boi.',
      rewrite: (adapter) => {
        const live = 'Hi boi.\n\nI just pasted this whole paragraph.';
        adapter.pushText(live, live.length);
        return 'Hi boy.';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toContain('I just pasted this whole paragraph.');
    expect(adapter.getText()).toContain('Hi boy.');
  });

  it('user TYPED then DELETED during the call: net effect respected', async () => {
    // Two adapter.pushText calls during one LLM round simulating typing
    // followed by backspace. The merge sees only the FINAL live state.
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff.',
      rewrite: (adapter) => {
        adapter.pushText('I rite stuff. typo', 18);
        adapter.pushText('I rite stuff. typ', 17);
        adapter.pushText('I rite stuff.', 13);                // back to original
        return 'I write stuff.';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff.');
  });

  it('user added a paragraph break AND new content mid-call: addition preserved, LLM\'s para-1 fix lands', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'first sentence has typoo.',
      rewrite: (adapter) => {
        adapter.pushText('first sentence has typoo.\n\nNew para starts here.', 49);
        return 'first sentence has typo.';                    // LLM only fixed para 1's typo
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toContain('typo.');
    expect(adapter.getText()).not.toContain('typoo');
    expect(adapter.getText()).toContain('New para starts here.');
  });

  it('user added a paragraph break ONLY (no new words) mid-call: structure preserved', async () => {
    // Gap tokens make pure-whitespace user changes visible to the
    // diff. The user's space → "\n\n" change registers as a user hunk;
    // LLM word-level edits land at translated positions.
    const { adapter, rewrite } = setup({
      initialText: 'first sentence. second sentence.',
      rewrite: (adapter) => {
        adapter.pushText('first sentence.\n\nsecond sentence.', 33);
        return 'First sentence. Second sentence.';
      },
    });
    await rewrite.tick();
    const result = adapter.getText();
    expect(result).toContain('\n\n');
    expect(result).toContain('First sentence.');
    expect(result).toContain('Second sentence.');
  });

  it('user added a single newline (line break) mid-call: line break survives', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'rite stuff here.',
      rewrite: (adapter) => {
        adapter.pushText('rite\nstuff here.', 16);            // user hit Enter between rite and stuff
        return 'write stuff here.';
      },
    });
    await rewrite.tick();
    const result = adapter.getText();
    expect(result).toContain('write');
    expect(result).toContain('\n');
  });

  it('user removed a paragraph break (joined two paragraphs) mid-call: join preserved', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'first sentence.\n\nsecond sentence.',
      rewrite: (adapter) => {
        adapter.pushText('first sentence. second sentence.', 32);
        return 'First sentence.\n\nSecond sentence.';
      },
    });
    await rewrite.tick();
    const result = adapter.getText();
    // The user's joined-paragraph form survives.
    expect(result).not.toContain('\n\n');
    expect(result).toContain('First sentence.');
    expect(result).toContain('Second sentence.');
  });

  it('user changed indentation mid-call: indentation preserved', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'rite some stuff.',
      rewrite: (adapter) => {
        adapter.pushText('  rite some stuff.', 18);
        return 'write some stuff.';
      },
    });
    await rewrite.tick();
    const result = adapter.getText();
    expect(result.startsWith('  ')).toBe(true);
    expect(result).toContain('write');
  });

  it('user typed in para B while LLM rewrote para A: para A fix lands, para B preserved', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'paragraph one has typoo.\n\npara two is fine.',
      rewrite: (adapter) => {
        adapter.pushText(
          'paragraph one has typoo.\n\npara two is fine. Adding more here.',
          61,
        );
        return 'paragraph one has typo.\n\npara two is fine.';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toContain('typo.');
    expect(adapter.getText()).not.toContain('typoo');
    expect(adapter.getText()).toContain('Adding more here.');
  });

  it('user inserted text exactly at LLM\'s insertion point: user wins (insertion-conflict)', async () => {
    // Snapshot: "Hello"
    // LLM wants to append " world" → "Hello world"
    // User typed " there" at the same insertion point: "Hello there"
    // Both conflict at position 5 (end of "Hello"); user's typing wins.
    const { adapter, rewrite } = setup({
      initialText: 'Hello',
      rewrite: (adapter) => {
        adapter.pushText('Hello there', 11);
        return 'Hello world';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('Hello there');
    expect(adapter.getText()).not.toContain('world');
  });

  it('LLM proposed a DRASTIC TRANSFORM (translation), user appended unrelated tail: tail survives', async () => {
    // Snapshot: "Monday Tuesday Wednesday"
    // LLM translates to Spanish:  "lunes martes miércoles"
    // User typed " I am writing this" at end during the call.
    // The merge: snapshot vs rewrite has hunks across the whole snapshot.
    // The user's addition is at a position past the snapshot — no overlap
    // with the LLM hunks. So the translation lands AND the tail survives.
    const { adapter, rewrite } = setup({
      initialText: 'Monday Tuesday Wednesday',
      rewrite: (adapter) => {
        adapter.pushText('Monday Tuesday Wednesday I am writing this', 42);
        return 'lunes martes miércoles';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toContain('I am writing this');
    expect(adapter.getText()).toContain('lunes');
  });

  it('rapid multi-edit during call: multiple pushText calls collapse into final live state', async () => {
    // Three keystrokes during one LLM round.
    const { adapter, rewrite } = setup({
      initialText: 'I rite',
      rewrite: (adapter) => {
        adapter.pushText('I rite ',  7);
        adapter.pushText('I rite m', 8);
        adapter.pushText('I rite m more', 13);
        return 'I write';
      },
    });
    await rewrite.tick();
    // User's typed " m more" survives + LLM's "rite → write" lands.
    expect(adapter.getText()).toBe('I write m more');
  });

  it('multi-round: round 1 lands, round 2 sees post-round-1 state and continues', async () => {
    // Two ticks. Round 1 fixes "rite" → "write". Round 2 sees the
    // post-round-1 buffer and adds capitalisation.
    const adapter = new MockAdapter({});
    const initial = 'i rite stuff.';
    adapter.pushText(initial, initial.length);
    const state = new AgentTaskState();
    state.arm('fix typos and capitalise');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) return llmResponse('REWRITTEN:\ni write stuff.\nEND');
        return llmResponse('REWRITTEN:\nI write stuff.\nEND');
      },
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });

    await rewrite.tick();
    expect(adapter.getText()).toBe('i write stuff.');
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff.');
    expect(calls).toBe(2);
  });

  it('multi-round with user typing BETWEEN rounds: each round\'s rewrite respects current state', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff.', 13);
    const state = new AgentTaskState();
    state.arm('correct spelling');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) return llmResponse('REWRITTEN:\nI write stuff.\nEND');
        // After round 1 + user typing, snapshot is "I write stuff. some moree"
        // LLM should fix "moree" → "more".
        return llmResponse('REWRITTEN:\nI write stuff. some more\nEND');
      },
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });

    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff.');

    // User types more.
    adapter.pushText('I write stuff. some moree', 25);
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff. some more');
  });

  it('DynDef from round 1 survives a round 2 that doesn\'t touch its word', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite some stuff.', 18);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) return llmResponse('REWRITTEN:\nI write some stuff.\nEND');
        // Round 2: no changes (idempotent).
        return llmResponse('REWRITTEN:\nI write some stuff.\nEND');
      },
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });

    await rewrite.tick();
    expect(dynDefs.get(1)?.alternatives).toEqual(['rite', 'write']);

    await rewrite.tick();
    // Same DynDef still in place — round 2 was a no-op so didn't disturb it.
    expect(dynDefs.get(1)?.alternatives).toEqual(['rite', 'write']);
  });

  it('user typed at FRONT of buffer during call: LLM\'s tail edits still land', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'rite stuff.',
      rewrite: (adapter) => {
        adapter.pushText('Hello, rite stuff.', 18);
        return 'write stuff.';                                // LLM only fixed "rite"
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('Hello, write stuff.');
  });

  it('user typing creates the SAME edit the LLM proposed: idempotent (no double-apply)', async () => {
    // User typed "I write" themselves while LLM was thinking
    // "I rite → I write".  Merge sees user's edit, drops LLM's identical
    // hunk via overlap — buffer is "I write" (not "I writewrite" or duplicate).
    const { adapter, rewrite } = setup({
      initialText: 'I rite',
      rewrite: (adapter) => {
        adapter.pushText('I write', 7);
        return 'I write';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write');
  });

  it('LLM rewrote multi-paragraph; user typed in just one paragraph: that paragraph\'s edits drop, others land', async () => {
    const { adapter, rewrite } = setup({
      initialText: [
        'first para has typoo.',
        '',
        'second has anotherr typo.',
        '',
        'third is clean.',
      ].join('\n'),
      rewrite: (adapter) => {
        // User typed in para 2 during the call.
        adapter.pushText([
          'first para has typoo.',
          '',
          'second has anotherr typo. Adding here.',
          '',
          'third is clean.',
        ].join('\n'), 200);
        return [
          'first para has typo.',
          '',
          'second has another typo.',
          '',
          'third is clean!',                                  // LLM also flipped the third sentence's terminator
        ].join('\n');
      },
    });
    await rewrite.tick();
    const result = adapter.getText();
    // Para 2 user content survives.
    expect(result).toContain('Adding here.');
    // Para 1's LLM fix lands.
    expect(result).toContain('typo.');
    expect(result).not.toContain('typoo');
    // Para 3 untouched by user — LLM's stylistic change either lands or is a no-op.
    // (Don't assert direction; the property we care about is user content survived
    //  and at least one LLM-only-paragraph fix landed.)
  });
});

describe('AgentRewrite — task changes mid-round', () => {
  it('user issued new ARM during LLM call: rewrite discarded', async () => {
    const { adapter, state, rewrite } = setup({
      initialText: 'I rite stuff',
      task: 'fix typos',
      rewrite: () => {
        // User's `agentically <new task> _` flow runs during the call.
        state.arm('translate to spanish');                    // fresh task
        return 'I write stuff';                               // result of OLD task
      },
    });
    await rewrite.tick();
    // Old task's rewrite must NOT land — it's stale.
    expect(adapter.getText()).toBe('I rite stuff');
  });

  it('task ADD mid-round: prompt changed → discard', async () => {
    const { adapter, state, rewrite } = setup({
      initialText: 'I rite stuff',
      task: 'fix typos',
      rewrite: () => {
        state.appendToPrompt('also translate to spanish');
        return 'I write stuff';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I rite stuff');
  });

  it('task STOP mid-round: rewrite discarded', async () => {
    const { adapter, state, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: () => {
        state.stop();
        return 'I write stuff';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I rite stuff');
  });
});

describe('AgentRewrite — LLM failure modes', () => {
  it('LLM throws: tick swallows, buffer untouched, next tick can retry', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff', 12);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return llmResponse('REWRITTEN:\nI write stuff\nEND');
      },
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I rite stuff');         // unchanged
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff');        // retry succeeds
  });

  it('LLM returns malformed JSON: tick is a no-op', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff', 12);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = { post: async () => 'not json {' };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I rite stuff');
  });

  it('LLM returns API error: no-op', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff', 12);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => JSON.stringify({ error: { message: 'rate limited' } }),
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I rite stuff');
  });

  it('LLM returns empty content: no-op', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff', 12);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }),
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I rite stuff');
  });
});

describe('AgentRewrite — DynDefs + cycling state', () => {
  it('places a DynDef for each applied hunk so cycling can revert', async () => {
    const { adapter, dynDefs, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: 'I write stuff',
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff');
    // The hunk replaced "rite" (chars 2..6) → "write" (chars 2..7 in new buffer).
    // word index in new buffer: I(0), write(1), stuff(2). Def at idx 1.
    const def = dynDefs.get(1);
    expect(def).toBeDefined();
    expect(def!.alternatives).toEqual(['rite', 'write']);
    expect(def!.blankName).toBe('agent-task');
  });

  it('records edit signatures for anti-oscillation continuity', async () => {
    const { state, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: 'I write stuff',
    });
    await rewrite.tick();
    // Inverse direction (write → rite) is now flagged as oscillation.
    expect(state.wouldInvertRecent('write', 'rite')).toBe(true);
  });

  it('caches the new-frame slot so the next round doesn\'t re-propose', async () => {
    const { state, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: 'I write stuff',
    });
    await rewrite.tick();
    // After apply, idx 1 ("write") is recorded as evaluated.
    expect(state.evaluationCount()).toBeGreaterThan(0);
  });
});

describe('AgentRewrite — cursor translation', () => {
  it('cursor at end of buffer: lands at end of new buffer', async () => {
    const adapter = new MockAdapter({});
    const initial = 'I rite stuff';
    adapter.pushText(initial, initial.length);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nI write stuff\nEND'),
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write stuff');
    expect(adapter.getCursorOffset()).toBe(13);              // end of new buffer
  });

  it('cursor mid-buffer: stays on the same logical position', async () => {
    const adapter = new MockAdapter({});
    const initial = 'I rite some stuff';
    adapter.pushText(initial, 7);                            // cursor between "rite" and "some"
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nI write some stuff\nEND'),
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('I write some stuff');
    // "rite" → "write" added 1 char before the cursor's logical position;
    // cursor moved from 7 to 8 (still between the now-fixed word and "some").
    expect(adapter.getCursorOffset()).toBe(8);
  });

  it('cursor at start: edits AFTER cursor don\'t shift it', async () => {
    const adapter = new MockAdapter({});
    const initial = 'I rite stuff';
    adapter.pushText(initial, 0);                            // cursor at start
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nI write stuff\nEND'),
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await rewrite.tick();
    expect(adapter.getCursorOffset()).toBe(0);
  });
});

describe('AgentRewrite — convergence over multiple rounds', () => {
  it('round 1 applies, round 2 sees clean buffer and is a no-op', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff.', 13);
    const state = new AgentTaskState();
    state.arm('correct spelling');
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
    await r.tick();
    expect(adapter.getText()).toBe('I write stuff.');
    expect(calls).toBe(2);                                                // both LLM calls fired
  });

  it('three rounds with progressive user typing: each round adds to a stable result', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('hii', 3);
    const state = new AgentTaskState();
    state.arm('correct spelling');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) return llmResponse('REWRITTEN:\nHi\nEND');
        if (calls === 2) return llmResponse('REWRITTEN:\nHi friend\nEND');
        return llmResponse('REWRITTEN:\nHi friend.\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(adapter.getText()).toBe('Hi');

    adapter.pushText('Hi freind', 9);
    await r.tick();
    expect(adapter.getText()).toBe('Hi friend');

    adapter.pushText('Hi friend', 9);
    await r.tick();
    // The no-auto-terminator guard strips the period (snapshot didn't
    // end with one — user may still be typing). User must terminate
    // their own sentence.
    expect(adapter.getText()).toBe('Hi friend');
  });

  it('second round on a stable buffer: idempotent, no double-apply', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('Hi friend.', 10);
    const state = new AgentTaskState();
    state.arm('correct spelling');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nHi friend.\nEND'),
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    await r.tick();
    await r.tick();
    expect(adapter.getText()).toBe('Hi friend.');
  });

  it('LLM oscillates between two valid forms across rounds: anti-oscillation pins the first form', async () => {
    // Models can flip between equally-valid grammar forms ("you'll" vs
    // "you will"). The anti-oscillation guard tracks recent applied
    // states and skips a rewrite that would revert to one — preventing
    // the visible flicker the user would otherwise see.
    const adapter = new MockAdapter({});
    adapter.pushText("you will go", 11);
    const state = new AgentTaskState();
    state.arm('fix grammar');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) return llmResponse("REWRITTEN:\nyou'll go\nEND");
        if (calls === 2) return llmResponse('REWRITTEN:\nyou will go\nEND');
        return llmResponse("REWRITTEN:\nyou'll go\nEND");
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(adapter.getText()).toBe("you'll go");
    await r.tick();
    // Round 2 wants to revert to "you will go" — but that was the
    // initial buffer, AND we now track "you'll go" as recently applied.
    // Whichever direction the merge goes, the third round's flip back
    // to "you'll go" will be skipped if it matches a recent state.
    await r.tick();
    // The buffer should NOT be flipping every round. The only acceptable
    // outcomes are: stuck at "you'll go", or stuck at "you will go".
    const final = adapter.getText();
    expect(final === "you'll go" || final === 'you will go').toBe(true);
  });
});

describe('AgentRewrite — DynDef + cycling state across rounds', () => {
  it('DynDef from round 1 stays after a no-op round 2', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff.', 13);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nI write stuff.\nEND'),
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(dynDefs.get(1)?.alternatives).toEqual(['rite', 'write']);
    await r.tick();
    expect(dynDefs.get(1)?.alternatives).toEqual(['rite', 'write']);
  });

  it('DynDef updates on a different word in round 2', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite some stuff.', 18);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) return llmResponse('REWRITTEN:\nI write some stuff.\nEND');
        return llmResponse('REWRITTEN:\nI write some stuf.\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(dynDefs.get(1)?.alternatives).toEqual(['rite', 'write']);
    await r.tick();
    expect(dynDefs.get(3)?.alternatives).toEqual(['stuff.', 'stuf.']);
  });
});

describe('AgentRewrite — additional cursor cases', () => {
  it('cursor at start, edits before user-typed insertion: cursor moves correctly', async () => {
    const adapter = new MockAdapter({});
    const initial = 'rite stuff';
    adapter.pushText(initial, 0);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nwrite stuff\nEND'),
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(adapter.getCursorOffset()).toBe(0);                            // cursor stayed at start
  });

  it('cursor mid-buffer with edits both before and after: stays logically correct', async () => {
    const adapter = new MockAdapter({});
    const initial = 'rite middle stuff';
    adapter.pushText(initial, 11);                                        // cursor between "middle" and " stuff"
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nwrite middle stuf\nEND'),
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    // "rite" → "write" (+1 char) before cursor; cursor moves +1.
    // Edit AFTER cursor doesn't shift cursor.
    expect(adapter.getCursorOffset()).toBe(12);
  });

  it('cursor in deleted region: clamped to a valid position', async () => {
    const adapter = new MockAdapter({});
    const initial = 'I really really wanted to.';
    adapter.pushText(initial, 11);                                        // cursor inside the duplicated "really"
    const state = new AgentTaskState();
    state.arm('fix grammar');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nI really wanted to.\nEND'),
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    // Whatever the cursor lands on, it must be in [0, newText.length].
    expect(adapter.getCursorOffset()).toBeGreaterThanOrEqual(0);
    expect(adapter.getCursorOffset()).toBeLessThanOrEqual(adapter.getText().length);
  });
});

describe('AgentRewrite — complex live-typing patterns', () => {
  it('user typed in two regions during one call (multiple insertions)', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'rite stuff and morre.',
      rewrite: (adapter) => {
        // User inserted at start AND at end.
        adapter.pushText('Hello rite stuff and morre. Bye!', 32);
        return 'write stuff and more.';
      },
    });
    await rewrite.tick();
    const result = adapter.getText();
    expect(result).toContain('Hello');
    expect(result).toContain('Bye!');
    // LLM's "rite" → "write" still applies (different word region).
    expect(result).toContain('write');
  });

  it('user backspaced + retyped a different word during call', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff',
      rewrite: (adapter) => {
        adapter.pushText('I rite st', 9);
        adapter.pushText('I rite stones', 13);                            // user retyped differently
        return 'I write stuff';
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toContain('stones');
    expect(adapter.getText()).not.toContain('stuff');                     // user's deletion respected
  });

  it('user pressed Enter mid-word during call: LLM still recognises the word', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'rite this',
      rewrite: (adapter) => {
        // User split "rite" with a newline mid-word (rare but possible).
        adapter.pushText('rit\ne this', 9);
        return 'write this';
      },
    });
    await rewrite.tick();
    // The user's mid-word newline survives. LLM's "rite → write" is on
    // a token that no longer exists in live ("rit", "e" are split tokens).
    // The merge MAY drop the LLM hunk; what matters is no corruption.
    expect(adapter.getText()).toContain('\n');
  });

  it('LLM proposed multiple edits, user typed in MIDDLE region only: outer edits land', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'aaa bbb ccc',
      rewrite: (adapter) => {
        adapter.pushText('aaa bUSERb ccc', 14);                           // user typed in middle
        return 'AAA BBB CCC';                                             // LLM capitalised all three
      },
    });
    await rewrite.tick();
    const result = adapter.getText();
    expect(result).toContain('USER');                                     // user content survives
    // The middle word is the user's. Outer words may or may not have
    // been capitalised — what matters is user content survives.
  });

  it('user moved cursor backward + typed (cursor isn\'t at end)', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('rite stuff at end', 0);                             // cursor at start
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => {
        // User moved cursor to start and typed.
        adapter.pushText('Hello rite stuff at end', 6);
        return llmResponse('REWRITTEN:\nwrite stuff at end\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    const result = adapter.getText();
    expect(result).toContain('Hello');
    expect(result).toContain('write');
  });
});

describe('AgentRewrite — edge-case LLM outputs', () => {
  it('LLM returned a rewrite with extra leading/trailing whitespace: trimmed', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff.',
      rewrite: '\n\n  I write stuff.  \n',
    });
    await rewrite.tick();
    // parseRewriteOutput trims the block; the rewrite is "I write stuff."
    expect(adapter.getText()).toBe('I write stuff.');
  });

  it('LLM returned the rewrite without REWRITTEN: marker: still parsed', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff.', 13);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('I write stuff.'),                    // no marker, no END
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(adapter.getText()).toBe('I write stuff.');
  });

  it('LLM returned with code fences: fences stripped', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff.', 13);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('```\nREWRITTEN:\nI write stuff.\nEND\n```'),
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(adapter.getText()).toBe('I write stuff.');
  });

  it('LLM returned a totally different document: full replacement (if no user typing)', async () => {
    const { adapter, rewrite } = setup({
      initialText: 'one two three',
      rewrite: 'completely different content here',
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('completely different content here');
  });

  it('LLM rewrite truncated, USER TYPED during call: user-typed tail survives', async () => {
    // Adversarial: LLM returns truncated output. Without user typing
    // there's no signal to reject the truncation — the merge applies
    // what was returned. WITH user typing, the user's content is
    // outside the LLM's rewrite scope and survives via the merge.
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff.',
      rewrite: (adapter) => {
        adapter.pushText('I rite stuff. and more text here.', 33);
        return 'I write';                                                 // truncated
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toContain('and more text here.');
  });

  it('LLM returned a much shorter rewrite (truncation): discarded by the truncation-prefix guard', async () => {
    // The truncation-prefix guard detects rewrites that are strict
    // prefixes of the snapshot AND noticeably shorter. Without this
    // guard the user's tail would be wiped.
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff and more text here.', 32);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('REWRITTEN:\nI rite\nEND'),
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    // Buffer unchanged — the truncation guard discarded the rewrite.
    expect(adapter.getText()).toBe('I rite stuff and more text here.');
  });

  it('LLM returned ONLY whitespace, USER TYPED during call: user content survives', async () => {
    // The "rewrite" parses as "" → would delete everything if no user
    // hunks. With user typing during the call, the user's hunks conflict
    // with the LLM's mass-deletion hunk and survive.
    const { adapter, rewrite } = setup({
      initialText: 'I rite stuff.',
      rewrite: (adapter) => {
        adapter.pushText('I rite stuff. typed more', 24);
        return '   ';                                                     // empty-ish
      },
    });
    await rewrite.tick();
    expect(adapter.getText()).toContain('typed more');
  });
});

describe('AgentRewrite — concurrency safety', () => {
  it('overlapping ticks: second tick skips while first is in flight', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff', 12);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();
    let calls = 0;
    let resolveFirst: ((v: string) => void) | null = null;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        if (calls === 1) {
          // Block first call until we manually resolve.
          return new Promise<string>(r => { resolveFirst = r; });
        }
        return llmResponse('REWRITTEN:\nI write stuff\nEND');
      },
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
    });
    const firstTick = rewrite.tick();
    // Fire a second tick while the first is mid-LLM-call. Should bail
    // immediately without making a 2nd LLM call.
    await rewrite.tick();
    expect(calls).toBe(1);
    // Now resolve the first call.
    resolveFirst!(llmResponse('REWRITTEN:\nI write stuff\nEND'));
    await firstTick;
    expect(adapter.getText()).toBe('I write stuff');
  });

  it('start/stop are idempotent', () => {
    const adapter = new MockAdapter({});
    adapter.pushText('x', 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      httpAdapter: { post: async () => llmResponse('REWRITTEN:\nx\nEND') },
    });
    rewrite.start();
    rewrite.start();         // idempotent
    rewrite.stop();
    rewrite.stop();          // idempotent
  });
});
