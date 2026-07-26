// DaemonCore scenario suite — the mac host's bridge-event grammar,
// runnable on ANY platform (no macOS, no Accessibility grant, no
// swiftc, no @opencues/runtime import). The maintainer has no mac:
// this file is the mac integration's primary test surface and MUST
// keep running everywhere. Events below are real bridge transcripts
// (SPOTLIGHT-SPIKE.md live captures), replayed per the repo's
// scenario-test discipline: multi-step journeys, asserting at every
// step — not isolated function pokes.

import { describe, expect, it } from 'vitest';
import { DaemonCore, type RuntimeSurface } from './daemon-core';

interface Recorded {
  keys: Array<{ key: string; text: string; cursorOffset: number }>;
  notifies: Array<{ text: string; cursor: number; source: 'user' | 'runtime' }>;
  resets: number;
}

function makeRuntime(): { rt: RuntimeSurface; rec: Recorded } {
  const rec: Recorded = { keys: [], notifies: [], resets: 0 };
  const rt: RuntimeSurface = {
    dispatchKey(e) { rec.keys.push({ key: e.key, text: e.text, cursorOffset: e.cursorOffset }); return true; },
    notifyTextChange(text, cursor, source) { rec.notifies.push({ text, cursor, source }); },
    resetBufferState() { rec.resets += 1; },
  };
  return { rt, rec };
}

interface Harness {
  core: DaemonCore;
  rec: Recorded;
  sent: Array<Record<string, unknown>>;
  logs: Array<{ level: string; msg: string }>;
  untrusted: number;
}

function makeHarness(opts: { deny?: string[]; charBudgetEnv?: string; replaceQueryEnv?: string; cyclingEnv?: string } = {}): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const h: Partial<Harness> = { sent, logs, untrusted: 0 };
  const core = new DaemonCore({
    send: cmd => { sent.push(cmd); },
    log: (level, msg) => { logs.push({ level, msg }); },
    deniedBundles: () => new Set(opts.deny ?? ['com.googlecode.iterm2']),
    charBudgetEnv: () => opts.charBudgetEnv,
    replaceQueryEnv: () => opts.replaceQueryEnv,
    cyclingEnv: () => opts.cyclingEnv,
    onUntrusted: () => { h.untrusted! += 1; },
  });
  const { rt, rec } = makeRuntime();
  core.attachRuntime(rt);
  h.core = core; h.rec = rec;
  return h as Harness;
}

const focusSpotlight = (value = '', cursor = 0): Record<string, unknown> => ({
  type: 'focus', app: 'Spotlight', bundle: 'com.apple.Spotlight', role: 'AXTextField', value, cursor,
});
const focusTextEdit = (value = '', cursor = 0): Record<string, unknown> => ({
  type: 'focus', app: 'TextEdit', bundle: 'com.apple.TextEdit', role: 'AXTextArea', value, cursor,
});
const change = (value: string, cursor: number): Record<string, unknown> => ({ type: 'change', value, cursor });

describe('ready handshake', () => {
  it('trusted → info log, daemon proceeds', () => {
    const h = makeHarness();
    h.core.handleEvent({ type: 'ready', trusted: true });
    expect(h.untrusted).toBe(0);
    expect(h.logs.some(l => l.msg.includes('ax-bridge ready'))).toBe(true);
  });
  it('untrusted → actionable error + onUntrusted (prod: exit 1)', () => {
    const h = makeHarness();
    h.core.handleEvent({ type: 'ready', trusted: false });
    expect(h.untrusted).toBe(1);
    expect(h.logs.some(l => l.level === 'error' && l.msg.includes('Accessibility permission missing'))).toBe(true);
  });
});

describe('focus / blur', () => {
  it('focus seeds the buffer as runtime-sourced context — a pre-existing `_` must NOT arm', () => {
    const h = makeHarness();
    h.core.handleEvent(focusTextEdit('draft with a hole _ already here', 5));
    expect(h.rec.resets).toBe(1);
    expect(h.rec.notifies).toEqual([{ text: 'draft with a hole _ already here', cursor: 5, source: 'runtime' }]);
    expect(h.rec.keys).toHaveLength(0);
  });

  it('denied bundle (terminal) is ignored entirely — state reset, nothing seeded', () => {
    const h = makeHarness();
    h.core.handleEvent({ type: 'focus', app: 'iTerm2', bundle: 'com.googlecode.iterm2', value: 'ls -la _', cursor: 8 });
    expect(h.core.focused).toBeNull();
    expect(h.rec.resets).toBe(1);
    expect(h.rec.notifies).toHaveLength(0);
    expect(h.core.getText()).toBe('');
  });

  it('blur clears focus + resets; double blur is idempotent', () => {
    const h = makeHarness();
    h.core.handleEvent(focusTextEdit('hello', 5));
    h.core.handleEvent({ type: 'blur' });
    expect(h.core.focused).toBeNull();
    expect(h.rec.resets).toBe(2);
    h.core.handleEvent({ type: 'blur' });
    expect(h.rec.resets).toBe(2);
  });

  it('change events with no focus are dropped (bridge blur races)', () => {
    const h = makeHarness();
    h.core.handleEvent(change('stray _', 7));
    expect(h.rec.notifies).toHaveLength(0);
    expect(h.rec.keys).toHaveLength(0);
  });
});

describe('typing → arm → fill → echo (the full journey)', () => {
  it('typed `_` arms exactly once, with marker-stripped text at the marker index', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight());
    h.core.handleEvent(change('capital of france', 17));
    h.core.handleEvent(change('capital of france ', 18));
    h.core.handleEvent(change('capital of france _', 19));
    expect(h.rec.keys).toEqual([{ key: '_', text: 'capital of france ', cursorOffset: 18 }]);
    const userNotifies = h.rec.notifies.filter(n => n.source === 'user');
    expect(userNotifies).toHaveLength(3);
  });

  it('runtime write → one contiguous replace command + optimistic state + echo classified runtime-sourced', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight());
    h.core.handleEvent(change('capital of france _', 19));
    h.core.requestWrite('capital of france France capital: Paris');
    // ONE contiguous replace — filtered by cmd because focus also arms the
    // chord tap ({cmd:'capture'}) on this host now.
    const replaces = h.sent.filter(c => c['cmd'] === 'replace');
    expect(replaces).toHaveLength(1);
    expect(replaces[0]).toMatchObject({ cmd: 'replace', start: 18 });
    // Optimistic: the runtime reads its own bytes back immediately.
    expect(h.core.getText()).toBe('capital of france France capital: Paris');
    // The bridge echoes our write as a change event → runtime-sourced,
    // never an arm.
    const before = h.rec.keys.length;
    h.core.handleEvent(change('capital of france France capital: Paris', 39));
    expect(h.rec.keys.length).toBe(before);
    expect(h.rec.notifies.at(-1)).toMatchObject({ source: 'runtime' });
  });

  it('writeAck failure asks the bridge for a resync read', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight('q _', 3));
    h.core.handleEvent({ type: 'writeAck', id: 1, ok: false, err: 'no focus' });
    expect(h.sent.at(-1)).toEqual({ cmd: 'read' });
    expect(h.logs.some(l => l.level === 'warn' && l.msg.includes('AX write failed'))).toBe(true);
  });

  it('write-path method logged once per focus, re-logged after refocus', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight());
    h.core.handleEvent({ type: 'writeAck', id: 1, ok: true, method: 'replace-attr' });
    h.core.handleEvent({ type: 'writeAck', id: 2, ok: true, method: 'replace-attr' });
    expect(h.logs.filter(l => l.msg === 'write path')).toHaveLength(1);
    h.core.handleEvent(focusTextEdit());
    h.core.handleEvent({ type: 'writeAck', id: 3, ok: true, method: 'selection' });
    expect(h.logs.filter(l => l.msg === 'write path')).toHaveLength(2);
  });
});

describe('REGRESSION 2026-07-21 — Spotlight duplicate notifications', () => {
  // Live transcript: Spotlight fires 2-3 byte-identical AXValueChanged
  // per keystroke; the duplicate re-ran the fill pipeline and the
  // buffer ended as "istanbul: not foundistanbul: not found".
  it('a byte-identical duplicate user change is dropped — one arm, one user notify', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight('capital of istanbul', 19));
    h.core.handleEvent(change('capital of istanbul _', 21));
    h.core.handleEvent(change('capital of istanbul _', 21)); // Spotlight duplicate
    h.core.handleEvent(change('capital of istanbul _', 21)); // and a third
    expect(h.rec.keys).toHaveLength(1);
    expect(h.rec.notifies.filter(n => n.source === 'user')).toHaveLength(1);
  });

  it('echoes of our own write are NOT dropped as duplicates (span bookkeeping needs them)', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight('capital of france _', 19));
    h.core.requestWrite('France capital: Paris');
    // Optimistic update already made state identical to the echo —
    // exactly the shape the dedupe must exempt.
    h.core.handleEvent(change('France capital: Paris', 21));
    expect(h.rec.notifies.at(-1)).toMatchObject({ text: 'France capital: Paris', source: 'runtime' });
  });

  it('cursor-only movement is not swallowed by the dedupe (cursor differs)', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight('abc', 3));
    h.core.handleEvent(change('abc', 1)); // same value, moved cursor
    expect(h.rec.notifies.filter(n => n.source === 'user')).toHaveLength(1);
    expect(h.core.getCursorOffset()).toBe(1);
  });
});

describe('Spotlight session transcript (SPOTLIGHT-SPIKE.md live capture)', () => {
  it('open-with-restored-query → clear → type → arm → dismiss', () => {
    const h = makeHarness();
    h.core.handleEvent({ type: 'ready', trusted: true });
    // Panel opens restoring the previous query, fully selected — this
    // is pre-existing content: context, never a trigger.
    h.core.handleEvent(focusSpotlight('setting', 7));
    expect(h.rec.keys).toHaveLength(0);
    // Esc clears (value → ''), duplicates included.
    h.core.handleEvent(change('', 0));
    h.core.handleEvent(change('', 0));
    // Type a query char by char (bridge sends full value per keystroke).
    for (const [v, c] of [['w', 1], ['we', 2], ['wea', 3], ['weather', 7], ['weather ', 8], ['weather _', 9]] as const) {
      h.core.handleEvent(change(v, c));
    }
    expect(h.rec.keys).toEqual([{ key: '_', text: 'weather ', cursorOffset: 8 }]);
    // Dismissal → blur → state cleared.
    h.core.handleEvent({ type: 'blur' });
    expect(h.core.focused).toBeNull();
    expect(h.core.getAnswerCharBudget()).toBeNull();
  });
});

describe('answer char budget accessor', () => {
  it('Spotlight focused → 37; ordinary app → null; env override respected', () => {
    const h = makeHarness();
    h.core.handleEvent(focusSpotlight('q', 1));
    expect(h.core.getAnswerCharBudget()).toBe(37);
    h.core.handleEvent(focusTextEdit('doc', 3));
    expect(h.core.getAnswerCharBudget()).toBeNull();

    const h2 = makeHarness({ charBudgetEnv: 'com.apple.Spotlight=50' });
    h2.core.handleEvent(focusSpotlight('q', 1));
    expect(h2.core.getAnswerCharBudget()).toBe(50);
  });
});

describe('answer-replaces-query accessor', () => {
  it('Spotlight focused → true; ordinary app → false; nothing focused → false', () => {
    const h = makeHarness();
    expect(h.core.getAnswerReplacesQuery()).toBe(false); // no focus yet
    h.core.handleEvent(focusSpotlight('capital of france _', 18));
    expect(h.core.getAnswerReplacesQuery()).toBe(true);
    // A real document is the user's own content — never wiped.
    h.core.handleEvent(focusTextEdit('a draft _', 9));
    expect(h.core.getAnswerReplacesQuery()).toBe(false);
    // Dismissal clears focus → back to the safe default.
    h.core.handleEvent(focusSpotlight('q', 1));
    h.core.handleEvent({ type: 'blur' });
    expect(h.core.getAnswerReplacesQuery()).toBe(false);
  });

  it('env opts a third-party launcher in (and Spotlight out)', () => {
    const h = makeHarness({ replaceQueryEnv: 'com.raycast.macos' });
    h.core.handleEvent(focusSpotlight('q _', 3));
    expect(h.core.getAnswerReplacesQuery()).toBe(false);

    const off = makeHarness({ replaceQueryEnv: 'off' });
    off.core.handleEvent(focusSpotlight('q _', 3));
    expect(off.core.getAnswerReplacesQuery()).toBe(false);
  });

  it('names the focused app for master\'s app-aware output steering', () => {
    const h = makeHarness();
    expect(h.core.getAmbientContext()).toBeNull(); // nothing focused yet
    h.core.handleEvent(focusSpotlight('my tax pdfs _', 13));
    expect(h.core.getAmbientContext()).toEqual({ app: 'Spotlight' });
    h.core.handleEvent(focusTextEdit('a draft', 7));
    expect(h.core.getAmbientContext()).toEqual({ app: 'TextEdit' });
    // Blur → no field → app-blind answers, never a stale app name.
    h.core.handleEvent({ type: 'blur' });
    expect(h.core.getAmbientContext()).toBeNull();
  });

  it('reports no ambient context when the bridge sends no app name', () => {
    const h = makeHarness();
    // The bridge's own fallback for an unnamed owner is '?' — that is not
    // an app the steering can shape output for.
    h.core.handleEvent({ type: 'focus', app: '?', bundle: 'com.example.thing', role: 'AXTextField', value: '', cursor: 0 });
    expect(h.core.getAmbientContext()).toBeNull();
  });

  it('a denied bundle never reports a focused field at all', () => {
    const h = makeHarness({ deny: ['com.apple.Spotlight'] });
    h.core.handleEvent(focusSpotlight('q _', 3));
    expect(h.core.focused).toBeNull();
    expect(h.core.getAnswerReplacesQuery()).toBe(false);
  });
});

describe('line-protocol robustness', () => {
  it('malformed / unknown lines never throw or mutate state', () => {
    const h = makeHarness();
    h.core.handleEvent(focusTextEdit('stable', 6));
    const notifies = h.rec.notifies.length;
    expect(() => {
      h.core.handleLine('not json at all');
      h.core.handleLine('{"type":"no-such-event"}');
      h.core.handleLine('{"cmd":"replace"}'); // a COMMAND, not an event
      h.core.handleLine('{}');
    }).not.toThrow();
    expect(h.core.getText()).toBe('stable');
    expect(h.rec.notifies.length).toBe(notifies);
  });

  it('events before runtime attach are dropped with a warn, not a crash', () => {
    const sent: Array<Record<string, unknown>> = [];
    const logs: Array<{ level: string; msg: string }> = [];
    const core = new DaemonCore({
      send: c => { sent.push(c); },
      log: (level, msg) => { logs.push({ level, msg }); },
      deniedBundles: () => new Set(),
      onUntrusted: () => {},
    });
    expect(() => core.handleEvent(focusSpotlight('x', 1))).not.toThrow();
    expect(logs.some(l => l.level === 'warn' && l.msg.includes('before runtime attach'))).toBe(true);
  });
});

// ─── Cycling chords (CGEventTap channel) ──────────────────────────────
// The bridge captures Ctrl+Alt+arrows and SWALLOWS them, but only while the
// daemon says so: the deny list lives here, so a tap left armed would eat the
// user's own chords in iTerm. These replay the bridge's side of that contract.
describe('cycling chord capture', () => {
  const cmds = (h: Harness, cmd: string) => h.sent.filter(c => c['cmd'] === cmd);

  it('arms capture on an attachable focus and disarms on blur', () => {
    const h = makeHarness();
    expect(cmds(h, 'capture')).toHaveLength(0);
    h.core.handleEvent(focusTextEdit('draft', 5));
    expect(cmds(h, 'capture')).toEqual([{ cmd: 'capture', on: true }]);
    h.core.handleEvent({ type: 'blur' });
    expect(cmds(h, 'capture').at(-1)).toEqual({ cmd: 'capture', on: false });
  });

  it('NEVER arms capture in a denied app (chords stay the terminal\'s)', () => {
    const h = makeHarness({ deny: ['com.googlecode.iterm2'] });
    h.core.handleEvent({ type: 'focus', app: 'iTerm2', bundle: 'com.googlecode.iterm2', role: 'AXTextArea', value: 'x', cursor: 1 });
    expect(cmds(h, 'capture').filter(c => c['on'] === true)).toHaveLength(0);
  });

  it('OPENCUES_AX_CYCLING=off keeps the pre-cycling profile', () => {
    const h = makeHarness({ cyclingEnv: 'off' });
    h.core.handleEvent(focusTextEdit('draft', 5));
    expect(cmds(h, 'capture').filter(c => c['on'] === true)).toHaveLength(0);
    expect(h.core.supportsCycling()).toBe(false);
  });

  // supportsCycling is a HOST capability, not a per-focus one: the resolver's
  // build key includes it, so a focus-scoped value rebuilt every source (and
  // dropped every cache) on each blur/focus — seen live 2026-07-26.
  it('supportsCycling does NOT flap with focus (no source-set churn)', () => {
    const h = makeHarness();
    expect(h.core.supportsCycling()).toBe(true);
    h.core.handleEvent(focusTextEdit('draft', 5));
    expect(h.core.supportsCycling()).toBe(true);
    h.core.handleEvent({ type: 'blur' });
    expect(h.core.supportsCycling()).toBe(true);   // capability, not state
    // …but capture (what actually swallows keys) DID follow the focus.
    expect(cmds(h, 'capture').at(-1)).toEqual({ cmd: 'capture', on: false });
  });

  it('does not re-send an unchanged capture state (one command per transition)', () => {
    const h = makeHarness();
    h.core.handleEvent(focusTextEdit('a', 1));
    h.core.handleEvent(focusSpotlight('b', 1));   // focus → focus, still armed
    expect(cmds(h, 'capture')).toEqual([{ cmd: 'capture', on: true }]);
  });

  it('forwards a captured chord to the runtime with the live buffer + caret', () => {
    const h = makeHarness();
    h.core.handleEvent(focusTextEdit('the attorney filed', 4));
    h.core.handleEvent({ type: 'key', key: 'up', modifiers: { ctrl: true, alt: true, shift: false, meta: false } });
    expect(h.rec.keys.at(-1)).toEqual({ key: 'up', text: 'the attorney filed', cursorOffset: 4 });
  });

  it('drops a chord that arrives with no focused element', () => {
    const h = makeHarness();
    h.core.handleEvent({ type: 'key', key: 'down', modifiers: { ctrl: true, alt: true, shift: false, meta: false } });
    expect(h.rec.keys).toHaveLength(0);
  });

  it('a tap failure is a warn, not a crash — blank fills keep working', () => {
    const h = makeHarness();
    expect(() => h.core.handleEvent({ type: 'tapFailed', reason: 'tapCreate returned nil' })).not.toThrow();
    expect(h.logs.some(l => l.level === 'warn' && /chord tap unavailable/.test(l.msg))).toBe(true);
    h.core.handleEvent(focusTextEdit('still works', 5));
    expect(h.core.getText()).toBe('still works');
  });
});
