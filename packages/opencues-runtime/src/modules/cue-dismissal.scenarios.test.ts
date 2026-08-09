/**
 * Scenario tests for dismissing a cue.
 *
 * Unit tests pin the registry; this file walks the journey the user actually
 * takes — see the advisory, press `_`, watch it go, keep typing, press `_`
 * twice on the next one, and have the CLI's restore bring it back mid-session.
 *
 * The invariant under all of them: `_` on an advisory is a GESTURE, so it must
 * never land in the buffer as text, and it must never touch a cue that has
 * something to cycle (there `_` still cycles).
 *
 * Companion to docs/architecture/cue-dismissal.md.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { DimRender } from './dim-render';
import { HighlightState } from '../state/highlight-state';
import { DynDefs, _resetCycledEverForTests, type WordDef } from '../state/dyn-defs';
import {
  FORGET_GRACE_MS, isCueDismissed, registerDismissalSink, setForgottenKeys,
  _resetCueDismissalsForTests,
} from '../state/cue-dismissals';
import type { DismissalRecord } from '@opencues/core';
import { MockAdapter } from '../../testing/mock-adapter';

afterEach(() => { _resetCueDismissalsForTests(); _resetCycledEverForTests(); });

const CLASH = '⚠ clashes with dentist 10:00';

/** A buffer with one passive advisory over its only sentence, plus the modules
 *  that paint and act on it. Mirrors what the resolver registers for a calendar
 *  conflict: one alternative (nothing to cycle to) and a cueTip. */
async function setup(text = 'I am free Thursday morning') {
  const adapter = new MockAdapter({ files: { '/mock/CUES.md': '---\ndomain: test\n---\n' } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  const dim = new DimRender(adapter, hlState, dynDefs, loader);
  // Spans the first sentence only, so a second advisory can be registered on a
  // later one without the two overlapping.
  const first = text.split('. ')[0] + (text.includes('. ') ? '.' : '');
  const advisory: WordDef = {
    originalWord: first, alternatives: [first], currentIndex: 0,
    spanStart: 0, spanEnd: first.length,
    blankName: 'sentence-cue:calendar', cueTip: CLASH, priority: 90,
  };
  dynDefs.set(0, advisory);
  return { adapter, dynDefs, dim, loader, text, advisory };
}

describe('the note teaches the gesture', () => {
  it('an advisory offers dismiss, a cycleable cue offers cycle', async () => {
    const { dim, dynDefs, text } = await setup();
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote).toMatchObject({
      text: CLASH, hint: '(underscore to dismiss)',
    });
    // Same span, but now with somewhere to cycle to → the other gesture.
    dynDefs.set(0, {
      originalWord: text, alternatives: [text, 'I am busy Thursday morning'], currentIndex: 0,
      spanStart: 0, spanEnd: text.length,
      blankName: 'sentence-cue:session-contradiction', cueTip: '⚠ you said Thursday was blocked',
    });
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote?.hint)
      .toBe('(underscore to cycle)');
  });

  it('the plain dismiss hint returns once a mute has lapsed', async () => {
    // A mute is not a lesson learned, so the cue comes back offering the same
    // gesture. (The how-to hint is retired only by a forget, after which there
    // is no cue left to show it.)
    const { adapter, dim, text } = await setup();
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    _resetCueDismissalsForTests();              // stand in for the mute lapsing
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote?.hint)
      .toBe('(underscore to dismiss)');
  });
});

describe('press `_` once — mute', () => {
  it('types nothing into the buffer, and the note offers the second grain', async () => {
    // ⚠ Regression: the first cut deleted the def and stopped painting on the
    // first press, so there was nothing left on screen to press `_` on again —
    // `forget` was unreachable through the UI. The note must survive the offer
    // window and say what a second press does.
    const { adapter, dim, text } = await setup();
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote?.hint)
      .toBe('(underscore to dismiss)');

    adapter.fireKey('_', {}, { cursorOffset: 3 });

    // The gesture is consumed: the buffer is untouched, no stray underscore.
    expect(adapter.getText()).toBe(text);
    expect(adapter.setTextCalls).toHaveLength(0);
    // The note is still up, now offering the forget.
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote).toMatchObject({
      text: CLASH, hint: '(muted · underscore again to forget)',
    });
  });

  it('goes quiet once the offer window lapses', async () => {
    const { adapter, dim, text } = await setup();
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    const real = Date.now;
    try {
      Date.now = () => real.call(Date) + FORGET_GRACE_MS + 1;
      expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote).toBeUndefined();
    } finally { Date.now = real; }
  });

  it('stops swallowing `_` once the note is no longer painted', async () => {
    // A muted cue past its window paints nothing, so the key must fall through
    // to its ordinary meaning rather than vanish over an invisible note.
    const { adapter } = await setup();
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    const real = Date.now;
    try {
      Date.now = () => real.call(Date) + FORGET_GRACE_MS + 1;
      expect(adapter.fireKey('_', {}, { cursorOffset: 3 })).toBe(false);
    } finally { Date.now = real; }
  });

  it('does not write anything durable — a mute is this session only', async () => {
    const written: DismissalRecord[] = [];
    registerDismissalSink((r) => written.push(r));
    const { adapter } = await setup();
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    expect(written).toHaveLength(0);
  });

  it('leaves a DIFFERENT advisory alone', async () => {
    // The p31 invariant: silencing one claim must not blind another.
    const text = 'I am free Thursday morning. Pick-up is at four.';
    const { adapter, dynDefs, dim } = await setup(text);
    const second = 'Pick-up is at four.';
    const at = text.indexOf(second);
    dynDefs.set(5, {
      originalWord: second, alternatives: [second], currentIndex: 0,
      spanStart: at, spanEnd: at + second.length,
      blankName: 'sentence-cue:calendar', cueTip: '⚠ clashes with the school run',
    });
    adapter.fireKey('_', {}, { cursorOffset: 3 });          // dismiss the first
    expect(isCueDismissed('clashes with the school run')).toBe(false);
    expect(dim.compute({ text, cursor: at + 2, externalHighlights: [] })?.inlineNote?.text)
      .toBe('⚠ clashes with the school run');
  });
});

describe('press `_` twice — forget', () => {
  it('writes one durable record with the label the user saw', async () => {
    const written: DismissalRecord[] = [];
    registerDismissalSink((r) => written.push(r));
    const { adapter } = await setup();

    // Two presses on the note in front of you — no re-registration needed,
    // because the note is still painted through the offer window.
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    adapter.fireKey('_', {}, { cursorOffset: 3 });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      label: 'clashes with dentist 10:00',      // emoji stripped, words kept
      source: 'sentence-cue:calendar',
    });
  });
});

describe('`_` still means cycle where there is something to cycle', () => {
  it('rotates a cycleable cue instead of dismissing it', async () => {
    const text = 'we can use Node';
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': '---\ndomain: test\n---\n' } });
    adapter.pushText(text);
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter);
    await loader.load();
    const cycling = new Cycling(adapter, new HighlightState(), dynDefs, loader);
    cycling.subscribe();
    dynDefs.set(0, {
      originalWord: text, alternatives: [text, 'we can use Bun'], currentIndex: 0,
      spanStart: 0, spanEnd: text.length,
      blankName: 'sentence-cue:session-contradiction', cueTip: '⚠ you said you would use Bun',
    });

    adapter.fireKey('_', {}, { cursorOffset: 3 });

    expect(adapter.setTextCalls.at(-1)).toBe('we can use Bun');
    expect(isCueDismissed('you said you would use bun')).toBe(false);
  });
});

describe('restoring from the CLI', () => {
  it('brings the cue back in the running session, no restart', async () => {
    const { adapter, dynDefs, dim, text, advisory } = await setup();
    registerDismissalSink(() => { /* a writer exists, so forget is durable */ });
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    adapter.fireKey('_', {}, { cursorOffset: 3 });          // forgotten

    dynDefs.set(0, advisory);                                // a later resolve
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote).toBeUndefined();

    // `opencues dismissals restore` rewrites the file; the ingest re-reads it
    // and hands the runtime the new set. That is the whole undo path.
    setForgottenKeys([]);
    _resetCueDismissalsForTests();
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote?.text).toBe(CLASH);
  });
});
