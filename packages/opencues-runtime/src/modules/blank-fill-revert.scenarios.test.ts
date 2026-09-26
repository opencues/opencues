/**
 * A STATIC blank's answer is revertible with `_`, the way a fluid-blank or
 * transform-blank answer already is.
 *
 * The journey (Wilfred on OpenCode, the `tables` blank): type a request for a
 * static, script-free blank, the answer lands, the caret sits on it and the
 * note reads `was: <request>` with the revert hint; `_` puts the request back
 * WITHOUT the blank firing again on the restored `_`; `_` again re-applies the
 * answer. Drives the REAL BlankFill + Cycling + DimRender through a real
 * blanks registry; only the blank itself is synthetic.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BlankFill } from './blank-fill';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { DimRender } from './dim-render';
import { UndoApplier } from './undo';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';
import { SpanFillState } from '../state/span-fill';
import { DynDefs, originalIndexOf, inlineNoteText, _resetCycledEverForTests, type WordDef } from '../state/dyn-defs';
import { HighlightState } from '../state/highlight-state';
import { UndoJournal } from '../state/undo-journal';
import { createBlankInvoke, type Blank } from '../blanks';

const TIPS = wrapTipsAsCuesMd({ concepts: [] });

const ZORBIFY = `---
type: blank
name: zorbify
blankKeywords: zorbify
---
`;
const ZORBLIST = `---
type: blank
name: zorblist
blankKeywords: zorblist
---
`;
const ZORBDISMISS = `---
type: blank
name: zorbdismiss
blankKeywords: zorbdismiss
blankDismissible: true
---
`;
const VOLUME = `---
type: blank
name: volume
blankKeywords: volume
blankStep: 6
blankSuffix: %
tip: system volume
---
`;

const CAPS = [
  'shimmer', 'render-override', 'dim-ranges', 'highlight-range',
  'selection', 'spawn-process', 'file-read', 'file-write',
  'force-render', 'change-source', 'blank-invoke', 'inline-note',
] as const;

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

async function setup(answer = 'ZORB-ANSWER ONE TWO') {
  const calls: Record<string, number> = {};
  const counted = (name: string, get: () => Promise<string>): Blank => ({
    name, readOnly: true,
    get: async () => { calls[name] = (calls[name] ?? 0) + 1; return get(); },
  });
  let vol = 40;
  const registry = new Map<string, Blank>([
    ['zorbify', counted('zorbify', async () => answer)],
    ['zorblist', counted('zorblist', async () => 'ZORB-ALT-ONE\nZORB-ALT-TWO\nZORB-ALT-THREE')],
    ['zorbdismiss', counted('zorbdismiss', async () => 'ZORB-SAVED NOTICE')],
    ['volume', { name: 'volume', readOnly: false, get: async () => { calls.volume = (calls.volume ?? 0) + 1; return String(vol); }, set: async (v: string) => { vol = parseInt(v, 10); } }],
  ]);
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: {
      '/mock/CUES.md': TIPS,
      '/proj/blanks/zorbify/BLANK.md': ZORBIFY,
      '/proj/blanks/zorblist/BLANK.md': ZORBLIST,
      '/proj/blanks/zorbdismiss/BLANK.md': ZORBDISMISS,
      '/proj/blanks/volume/BLANK.md': VOLUME,
    },
    capabilities: [...CAPS],
  });
  const invoke = createBlankInvoke(registry);
  (adapter as unknown as { blankInvoke: typeof invoke }).blankInvoke = invoke;
  const loader = new ConfigLoader(adapter, { settingsFile: '/mock/CUES.md' });
  await loader.load();
  const spanFillState = new SpanFillState();
  const dynDefs = new DynDefs();
  const hlState = new HighlightState();
  const journal = new UndoJournal();
  // Cycling subscribes first, as every host band wires it: it must see `_`
  // before BlankFill does.
  const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState,
    undefined, undefined, undefined, undefined, journal);
  cycling.subscribe();
  const bf = new BlankFill(adapter, loader, spanFillState, undefined, undefined, dynDefs,
    undefined, undefined, journal);
  bf.subscribe();
  const dim = new DimRender(adapter, hlState, dynDefs, loader, spanFillState);
  const note = () => dim.compute({ text: adapter.getText(), cursor: adapter.getCursorOffset(), externalHighlights: [] })?.inlineNote;
  const undo = async (action: 'undo' | 'redo' = 'undo') => {
    const applier = new UndoApplier(adapter, loader, journal);
    const { text } = await applier.apply(action, 1, adapter.getText());
    adapter.pushTextNoKeystroke(text);
  };
  return { adapter, dynDefs, spanFillState, calls, note, undo, journal };
}

// the hint retirement is module state: a test that adjusted a knob must not retire the next test's hint
beforeEach(() => _resetCycledEverForTests());

describe('static blank fill — `_` reverts the landed answer (the tables journey)', () => {
  it('lands, shows the was: note, `_` restores the request without re-firing, `_` re-applies', async () => {
    const s = await setup();
    s.adapter.pushText('zorbify zorb _');
    await flush();
    // The command span is consumed (the shape captured an argument), as
    // `nato for zorb _` → `Zulu Oscar Romeo Bravo`.
    expect(s.adapter.getText()).toBe('ZORB-ANSWER ONE TWO');
    expect(s.calls.zorbify).toBe(1);

    // Caret on the answer: the toggle note names what it was, the hint the revert.
    s.adapter.setCursorOffset(s.adapter.getText().length);
    expect(s.note()).toMatchObject({ text: 'was: zorbify zorb _', hint: '(underscore to revert)' });

    // `_` is consumed (not typed) and puts the request back.
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('zorbify zorb _');
    // The restored `_` is NOT a new request: no second invocation.
    expect(s.calls.zorbify).toBe(1);

    // Still on the span: the note names the answer, `_` re-applies it.
    expect(s.note()).toMatchObject({ text: 'ZORB-ANSWER ONE TWO', hint: '(underscore to apply)' });
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('ZORB-ANSWER ONE TWO');
    expect(s.calls.zorbify).toBe(1);

    // And back once more: the toggle walks both ways indefinitely.
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('zorbify zorb _');
    expect(s.calls.zorbify).toBe(1);
  });

  it('the user\'s next keystroke after a revert does not fire the blank either', async () => {
    const s = await setup();
    s.adapter.pushText('zorbify zorb _');
    await flush();
    s.adapter.setCursorOffset(s.adapter.getText().length);
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('zorbify zorb _');
    s.adapter.pushText('zorbify zorb _ ', 'zorbify zorb _ '.length);
    await flush();
    expect(s.adapter.getText()).toBe('zorbify zorb _ ');
    expect(s.calls.zorbify).toBe(1);
  });

  it('typing after the answer, then reverting, then typing: still no re-fire', async () => {
    const s = await setup();
    s.adapter.pushText('zorbify zorb _');
    await flush();
    // The user carries on writing past the answer (a USER edit with no `_`).
    s.adapter.pushText('ZORB-ANSWER ONE TWO zeta', 'ZORB-ANSWER ONE TWO zeta'.length);
    await flush();
    // Caret back onto the answer, `_` reverts it.
    s.adapter.setCursorOffset(5);
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('zorbify zorb _ zeta');
    // The next keystroke (end of the line) must not read the restored `_`
    // as freshly typed.
    s.adapter.pushText('zorbify zorb _ zetas', 'zorbify zorb _ zetas'.length);
    await flush();
    expect(s.adapter.getText()).toBe('zorbify zorb _ zetas');
    expect(s.calls.zorbify).toBe(1);
  });

  it('a single-word answer toggles too', async () => {
    const s = await setup('ZORB-ANSWER');
    s.adapter.pushText('zorbify zorb _');
    await flush();
    expect(s.adapter.getText()).toBe('ZORB-ANSWER');
    s.adapter.setCursorOffset(3);
    expect(s.note()?.text).toBe('was: zorbify zorb _');
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('zorbify zorb _');
    expect(s.calls.zorbify).toBe(1);
  });

  it('prior text survives the fill, the revert and the re-apply', async () => {
    const s = await setup();
    s.adapter.pushText('zeta line.\nzorbify zorb _');
    await flush();
    expect(s.adapter.getText()).toBe('zeta line.\nZORB-ANSWER ONE TWO');
    const def = [...s.dynDefs.entries()].map(([, d]) => d).find(d => d.blankName === 'zorbify');
    expect(def?.landed).toBe(true);
    expect(def?.alternatives).toEqual(['ZORB-ANSWER ONE TWO', 'zorbify zorb _']);
    // One owner of the span: the landed def, not a single-stop spanFill too.
    expect(s.spanFillState.current).toBeNull();

    s.adapter.setCursorOffset(s.adapter.getText().length);
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('zeta line.\nzorbify zorb _');
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    expect(s.adapter.getText()).toBe('zeta line.\nZORB-ANSWER ONE TWO');
    expect(s.calls.zorbify).toBe(1);
  });

  it('an edit inside the answer retires the toggle: `_` then types', async () => {
    const s = await setup();
    s.adapter.pushText('zorbify zorb _');
    await flush();
    s.adapter.pushText('ZORB-ANSWER ONE TWX', 'ZORB-ANSWER ONE TWX'.length);
    await flush();
    expect(s.note()).toBeUndefined();
    expect(s.adapter.fireKey('_')).toBe(false);
    expect(s.calls.zorbify).toBe(1);
  });
});

describe('static blank fill — undo after a revert', () => {
  it('undo walks back the revert, then the fill, and never re-arms the blank', async () => {
    const s = await setup();
    s.adapter.pushText('zorbify zorb _');
    await flush();
    const answered = s.adapter.getText();
    s.adapter.setCursorOffset(answered.length);
    expect(s.adapter.fireKey('_')).toBe(true);
    await flush();
    const reverted = s.adapter.getText();
    expect(reverted).not.toBe(answered);

    await s.undo();
    await flush();
    expect(s.adapter.getText()).toBe(answered);
    await s.undo();
    await flush();
    // fillSplice: undoing the fill restores the request WITHOUT its trigger
    // `_`, so it cannot re-fire (the existing contract for every fill).
    expect(s.adapter.getText()).toBe('zorbify zorb');
    expect(s.calls.zorbify).toBe(1);
  });
});

describe('static blank fill — the fills that keep their own behaviour', () => {
  it('a list (multi-line) fill keeps its spanFill cycle and gets no landed def', async () => {
    const s = await setup();
    s.adapter.pushText('zorblist _');
    await flush();
    expect(s.adapter.getText()).toContain('ZORB-ALT-ONE');
    expect(s.spanFillState.current?.alternatives.length).toBe(3);
    expect([...s.dynDefs.entries()].some(([, d]) => d.landed)).toBe(false);
  });

  it('a dismissible fill keeps its spanFill dismiss stop and gets no landed def', async () => {
    const s = await setup();
    s.adapter.pushText('zorbdismiss _');
    await flush();
    expect(s.spanFillState.current?.alternatives.at(-1)).toBe('_');
    expect([...s.dynDefs.entries()].some(([, d]) => d.landed)).toBe(false);
  });

  it('the volume actuator keeps its single-stop def and its adjust note', async () => {
    const s = await setup();
    s.adapter.pushText('volume _');
    await flush();
    expect(s.adapter.getText()).toBe('volume 40%');
    const def = s.dynDefs.get(1);
    expect(def?.alternatives).toEqual(['40%']);
    expect(def?.landed).toBeUndefined();
    s.adapter.setCursorOffset(s.adapter.getText().length);
    expect(s.note()?.hint).toBe('(ctrl+alt+up/down to adjust)');
  });

  it('fluid / transform toggles keep the original as the LAST stop', () => {
    const base = { originalWord: 'q', currentIndex: 0, spanStart: 0, spanEnd: 1 };
    const fluid: WordDef = { ...base, alternatives: ['8', '4 + 4 = _'], blankName: 'fluid-blank' };
    const transform: WordDef = { ...base, alternatives: ['A', 'B', 'C'], blankName: 'transform-blank' };
    const cue: WordDef = { ...base, alternatives: ['zorb', 'ZORB-FIX'] };
    expect(originalIndexOf(fluid)).toBe(1);
    expect(originalIndexOf(transform)).toBe(2);
    expect(originalIndexOf(cue)).toBe(0);
    expect(inlineNoteText(fluid)).toBe('was: 4 + 4 = _');
  });
});
