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
  isCueDismissed, registerDismissalSink, setForgottenKeys, _resetCueDismissalsForTests,
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
  const advisory: WordDef = {
    originalWord: text, alternatives: [text], currentIndex: 0,
    spanStart: 0, spanEnd: text.length,
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

  it('the hint retires once the user has dismissed that note', async () => {
    const { adapter, dim, text } = await setup();
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    setForgottenKeys([]);                       // the mute is what silenced it
    _resetCueDismissalsForTests();              // …so un-silence to inspect the hint
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote?.hint)
      .toBeUndefined();
  });
});

describe('press `_` once — mute', () => {
  it('silences the note and types nothing into the buffer', async () => {
    const { adapter, dim, text } = await setup();
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote).toBeTruthy();

    adapter.fireKey('_', {}, { cursorOffset: 3 });

    // The gesture is consumed: the buffer is untouched, no stray underscore.
    expect(adapter.getText()).toBe(text);
    expect(adapter.setTextCalls).toHaveLength(0);
    // And the note is gone.
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote).toBeUndefined();
  });

  it('does not write anything durable — a mute is this session only', async () => {
    const written: DismissalRecord[] = [];
    registerDismissalSink((r) => written.push(r));
    const { adapter } = await setup();
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    expect(written).toHaveLength(0);
  });

  it('leaves a DIFFERENT advisory alone', async () => {
    const { adapter, dynDefs, dim, text } = await setup();
    const at = text.indexOf('Thursday');
    dynDefs.set(5, {
      originalWord: 'Thursday', alternatives: ['Thursday'], currentIndex: 0,
      spanStart: at, spanEnd: at + 'Thursday'.length,
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
    const { adapter, dynDefs, advisory } = await setup();

    adapter.fireKey('_', {}, { cursorOffset: 3 });
    // The def is gone after the first press, so the second press needs the note
    // back — exactly what happens live, where the next resolve re-registers it
    // and the user presses again on the note in front of them.
    dynDefs.set(0, advisory);
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
    adapter.fireKey('_', {}, { cursorOffset: 3 });
    dynDefs.set(0, advisory);
    adapter.fireKey('_', {}, { cursorOffset: 3 });          // forgotten

    dynDefs.set(0, advisory);
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote).toBeUndefined();

    // `opencues dismissals restore` rewrites the file; the ingest re-reads it
    // and hands the runtime the new set. That is the whole undo path.
    setForgottenKeys([]);
    _resetCueDismissalsForTests();
    expect(dim.compute({ text, cursor: 3, externalHighlights: [] })?.inlineNote?.text).toBe(CLASH);
  });
});
