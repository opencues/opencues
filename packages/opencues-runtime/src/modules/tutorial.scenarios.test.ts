// Scenario tests for TutorialCoach — multi-step user journeys against a
// mock adapter, per the CLAUDE.md testing rule. These pin the
// DETERMINISTIC contracts (activation, control phrases, the Esc ×3
// escape hatch, trace attempt-preservation); LLM-judged behaviour is
// covered by the agentic harness (scenario 42) and stays out of unit
// tests by design.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TutorialCoach } from './tutorial';
import type { TextChangeEvent, KeyEvent } from '../adapter';

const TUTORIAL_MD = `---
name: demo
id: 1
title: Demo tutorial
---

## Step 1 — first
Do the first thing.

## Step 2 — second
Do the second thing.

## Step 3 — third
Do the third thing.
`;

function makeHarness() {
  const events: Array<{ type: string; body?: Record<string, unknown> }> = [];
  const writes: string[] = [];
  let textHandler: ((e: TextChangeEvent) => void) | null = null;
  const adapter = {
    onTextChange: (h: (e: TextChangeEvent) => void) => { textHandler = h; return () => { textHandler = null; }; },
    readDir: async (path: string) => path.endsWith('/tutorials')
      ? [{ name: 'demo', isDirectory: true }]
      : null,
    readFile: async (path: string) => path.endsWith('demo/TUTORIAL.md') ? TUTORIAL_MD : null,
    pushText: (text: string) => { writes.push(text); },
    setText: (text: string) => { writes.push(text); },
    setCursorOffset: () => { /* noop */ },
    forceRender: () => { /* noop */ },
    emitEvent: (type: string, body?: Record<string, unknown>) => { events.push({ type, body }); },
    log: () => { /* noop */ },
  };
  const configLoader = { opencuesState: { settings: new Map<string, string>() } };
  const resolveLLM = vi.fn(() => null); // no LLM — deterministic paths only
  const coach = new TutorialCoach(
    adapter as never,
    configLoader as never,
    { tutorialsDirs: ['/cues/tutorials'], resolveLLM, log: () => { /* noop */ } },
  );
  coach.subscribe();

  const type = async (text: string, prev = ''): Promise<void> => {
    textHandler?.({ text, cursorOffset: text.length, previousText: prev, source: 'user' });
    // handleControl is async (readDir/readFile) + consumePhrase defers a
    // tick — drain microtasks and the 0ms timer.
    await vi.advanceTimersByTimeAsync(1);
  };
  const key = (name: string, mods: Partial<KeyEvent['modifiers']> = {}): void => {
    coach.observeKey({
      key: name,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false, ...mods },
      text: '', cursorOffset: 0,
    } as KeyEvent);
  };
  return { coach, events, writes, resolveLLM, type, key };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('TutorialCoach journeys (deterministic contracts)', () => {
  it('start → done → done → done completes; control spans consumed', async () => {
    const h = makeHarness();
    await h.type('start tutorial 1 _');
    expect(h.events.map(e => e.type)).toContain('tutorial.started');
    expect(h.coach.active).toBe(true);
    expect(h.coach.status()).toMatchObject({ step: 1, stepCount: 3 });
    expect(h.writes.at(-1)).toBe(''); // command span consumed

    await h.type('done _');
    expect(h.coach.status()).toMatchObject({ step: 2 });
    await h.type('done _');
    expect(h.coach.status()).toMatchObject({ step: 3 });
    await h.type('done _'); // last step → completed + deactivated
    expect(h.coach.active).toBe(false);
    expect(h.events.map(e => e.type)).toContain('tutorial.completed');
    const advances = h.events.filter(e => e.type === 'tutorial.step-advanced');
    expect(advances.map(a => a.body?.reason)).toEqual(['user', 'user']);
  });

  it('Esc ×3 exits deterministically with countdown — zero LLM involvement', async () => {
    const h = makeHarness();
    await h.type('start tutorial 1 _');
    h.key('escape');
    expect(h.coach.active).toBe(true);
    expect(h.coach.status()?.coach).toBe('Esc ×2 more to exit the tutorial');
    h.key('escape');
    expect(h.coach.active).toBe(true);
    expect(h.coach.status()?.coach).toBe('Esc ×1 more to exit the tutorial');
    h.key('escape');
    expect(h.coach.active).toBe(false);
    const stopped = h.events.find(e => e.type === 'tutorial.stopped');
    expect(stopped?.body?.reason).toBe('escape-key');
    // Transient notice carries the resume phrase.
    expect(h.coach.status()?.coach).toContain('start tutorial 1 _');
    expect(h.coach.status()?.offTrack).toBe(false);
    // The hatch must work with a dead/missing LLM: resolver never consulted.
    expect(h.resolveLLM).not.toHaveBeenCalled();
  });

  it('Esc counter resets after the 2.5s window and on other keys', async () => {
    const h = makeHarness();
    await h.type('start tutorial 1 _');
    h.key('escape');
    await vi.advanceTimersByTimeAsync(2600); // window expires
    h.key('escape');
    expect(h.coach.status()?.coach).toBe('Esc ×2 more to exit the tutorial'); // reset, not ×1
    h.key('tab'); // any other key resets the chain
    h.key('escape');
    h.key('escape');
    expect(h.coach.active).toBe(true); // only 2 since reset — still in
  });

  it('escape presses land in the trace (tutorials can teach Esc)', async () => {
    const h = makeHarness();
    await h.type('start tutorial 1 _');
    h.key('escape');
    h.key('escape');
    const esc = h.coach.traceSnapshot().find(t => t.kind === 'key' && t.text === 'escape');
    expect(esc?.count).toBe(2);
    expect(h.coach.active).toBe(true);
  });

  it('trace preserves distinct attempts, coalesces continued typing', async () => {
    const h = makeHarness();
    await h.type('start tutorial 1 _');
    await h.type('/m'); await h.type('/me', '/m'); await h.type('/memory', '/me'); // continued typing — one entry
    await h.type('/setup', '/memory');   // new direction — new entry
    await h.type('/start', '/setup');    // new direction — new entry
    const typed = h.coach.traceSnapshot().filter(t => t.kind === 'typed');
    expect(typed.map(t => t.text)).toEqual(['/memory', '/setup', '/start']);
  });

  it('non-empty → empty transition records a submit (self-write TTL expired)', async () => {
    const h = makeHarness();
    await h.type('start tutorial 1 _');
    // Past the 250ms echo window, the consume-write stash ('') must not
    // swallow the user's own buffer-cleared submit signal. This pinned a
    // real bug: a lingering self-write entry ate submit detection on any
    // host that doesn't echo pushText.
    await vi.advanceTimersByTimeAsync(300);
    await h.type('git status');
    await h.type('', 'git status');
    const last = h.coach.traceSnapshot().at(-1);
    expect(last).toMatchObject({ kind: 'submitted', text: 'git status' });
  });

  it('stop tutorial _ deactivates; tutorials-mode: off gates everything', async () => {
    const h = makeHarness();
    await h.type('start tutorial 1 _');
    expect(h.coach.active).toBe(true);
    await h.type('stop tutorial _');
    expect(h.coach.active).toBe(false);
    expect(h.events.filter(e => e.type === 'tutorial.stopped').at(-1)?.body?.reason).toBe('user');
  });

  it('resolver suppression covers active mode AND control-phrase typing', async () => {
    const h = makeHarness();
    expect(h.coach.shouldSuppressResolve('the lawyer filed today')).toBe(false);
    expect(h.coach.shouldSuppressResolve('start tutorial 1 _')).toBe(true); // mid-phrase, inactive
    await h.type('start tutorial 1 _');
    expect(h.coach.shouldSuppressResolve('anything at all')).toBe(true); // modal
    await h.type('stop tutorial _');
    expect(h.coach.shouldSuppressResolve('anything at all')).toBe(false); // released
  });

  it('no LLM: degraded mode is loud + fully navigable end-to-end', async () => {
    const h = makeHarness(); // resolveLLM returns null throughout
    await h.type('start tutorial 1 _');
    await vi.advanceTimersByTimeAsync(300);
    // User types step activity → debounced tick fires → offline hint
    // (deterministic) instead of silence.
    await h.type('git status');
    await vi.advanceTimersByTimeAsync(400); // past the 300ms coach debounce
    expect(h.coach.status()?.coach).toContain('coach offline (no LLM key)');
    expect(h.coach.status()?.coach).toContain('type next _ when done');
    expect(h.coach.status()?.offTrack).toBe(false);
    // Manual advancement carries the whole journey.
    await h.type('next _', 'git status');
    expect(h.coach.status()).toMatchObject({ step: 2 });
    await h.type('next _');
    await h.type('next _'); // last step → completed
    expect(h.coach.active).toBe(false);
    expect(h.events.map(e => e.type)).toContain('tutorial.completed');
  });

  it('coach unreachable (2 consecutive network failures) → offline hint; recovery clears it', async () => {
    const h = makeHarness();
    let failing = true;
    // A resolved LLM whose dispatch always throws (dead network).
    h.resolveLLM.mockImplementation((() => ({
      provider: {
        id: 'test', defaultModel: 'm',
        buildRequest: () => { if (failing) throw new Error('ECONNREFUSED'); return { url: 'u', body: 'b', headers: {} }; },
        parseResponse: () => 'STEP: 1\nSTATUS: IN_PROGRESS\nCOACH: back online',
      },
      model: 'm', endpoint: 'e', apiKey: 'k',
    })) as never);
    await h.type('start tutorial 1 _');
    await vi.advanceTimersByTimeAsync(300);
    await h.type('attempt one');
    await vi.advanceTimersByTimeAsync(400); // failure 1 — still the static line
    expect(h.coach.status()?.coach).not.toContain('coach offline');
    await h.type('attempt one two', 'attempt one');
    await vi.advanceTimersByTimeAsync(400); // failure 2 — degrade loudly
    expect(h.coach.status()?.coach).toContain('coach offline (coach unreachable)');
    expect(h.events.filter(e => e.type === 'tutorial.tick' && e.body?.error).length).toBe(2);
    void failing;
  });

  it('unknown tutorial → not-found event + transient catalogue notice', async () => {
    const h = makeHarness();
    await h.type('start tutorial 99 _');
    expect(h.coach.active).toBe(false);
    const nf = h.events.find(e => e.type === 'tutorial.not-found');
    expect(nf?.body?.arg).toBe('99');
    expect(String(nf?.body?.available)).toContain('demo');
    expect(h.coach.status()?.coach).toContain('available');
    await vi.advanceTimersByTimeAsync(11_000); // notice expires
    expect(h.coach.status()).toBeNull();
  });
});
