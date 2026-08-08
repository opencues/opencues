import { afterEach, describe, expect, it } from 'vitest';
import {
  MUTE_MS, FORGET_GRACE_MS, forgetOfferRemainingMs,
  dismissalTargetOf, isCueDismissed, muteRemainingMs, pressDismiss,
  registerDismissalSink, setForgottenKeys, _resetCueDismissalsForTests,
} from './cue-dismissals';
import type { DismissalRecord } from '@opencues/core';

afterEach(() => _resetCueDismissalsForTests());

const advisory = { cueTip: '⚠ clashes with dentist 10:00', blankName: 'sentence-cue:calendar', alternatives: ['I am free Thursday'] };
const cycleable = { cueTip: '⚠ you said you would use Bun', blankName: 'sentence-cue:session-contradiction', alternatives: ['we can use Node', 'we can use Bun'] };

describe('dismissalTargetOf — what `_` may dismiss', () => {
  it('claims a pure advisory (nothing to cycle to)', () => {
    expect(dismissalTargetOf(advisory)).toMatchObject({
      label: 'clashes with dentist 10:00',
      source: 'sentence-cue:calendar',
    });
  });

  it('does NOT claim a cycleable cue — there `_` still means cycle', () => {
    // Load-bearing: overloading `_` on a cue with alternatives would take the
    // reconcile gesture away, which IS the answer for those.
    expect(dismissalTargetOf(cycleable)).toBeNull();
  });

  it('does not claim a def with no advisory at all', () => {
    expect(dismissalTargetOf({ alternatives: ['a', 'b'] })).toBeNull();
    expect(dismissalTargetOf({ cueTip: '⚠', alternatives: ['x'] })).toBeNull();  // empty key
  });
});

describe('mute — the first press', () => {
  it('silences the cue and lapses on its own', () => {
    const t0 = 1_000_000;
    expect(pressDismiss({ key: 'k', label: 'l', source: 's' }, t0)).toBe('mute');
    expect(isCueDismissed('k', t0 + 1000)).toBe(true);
    expect(muteRemainingMs('k', t0 + 1000)).toBeGreaterThan(0);
    expect(isCueDismissed('k', t0 + MUTE_MS + 1)).toBe(false);   // back on its own
  });

  it('is per cue — muting one does not blind another', () => {
    // The p31 invariant from the research prototype: dismissing the fizzy-drink
    // claim must not silence the gym claim in the next sentence.
    const t0 = 2_000_000;
    pressDismiss({ key: 'fizzy', label: 'no fizzy drinks', source: 's' }, t0);
    expect(isCueDismissed('fizzy', t0)).toBe(true);
    expect(isCueDismissed('gym', t0)).toBe(false);
  });

  it('two presses far apart are two mutes, not a forget', () => {
    const t0 = 3_000_000;
    expect(pressDismiss({ key: 'k', label: 'l', source: 's' }, t0)).toBe('mute');
    expect(pressDismiss({ key: 'k', label: 'l', source: 's' }, t0 + FORGET_GRACE_MS + 1)).toBe('mute');
  });

  it('opens the offer window, which then lapses', () => {
    // ⚠ The window is what makes `forget` reachable: DimRender keeps painting
    // the note while it is open, so there is something left to press again.
    const t0 = 3_500_000;
    expect(forgetOfferRemainingMs('k', t0)).toBe(0);          // nothing pressed yet
    pressDismiss({ key: 'k', label: 'l', source: 's' }, t0);
    expect(forgetOfferRemainingMs('k', t0 + 500)).toBeGreaterThan(0);
    expect(forgetOfferRemainingMs('k', t0 + FORGET_GRACE_MS + 1)).toBe(0);
  });

  it('offers nothing once the cue is already forgotten', () => {
    setForgottenKeys(['k']);
    expect(forgetOfferRemainingMs('k')).toBe(0);
  });
});

describe('forget — the second press', () => {
  it('upgrades within the double-press window and reaches the sink', () => {
    const written: DismissalRecord[] = [];
    registerDismissalSink((r) => written.push(r));
    const t0 = 4_000_000;
    pressDismiss({ key: 'k', label: 'the label', source: 'sentence-cue:calendar' }, t0);
    expect(pressDismiss({ key: 'k', label: 'the label', source: 'sentence-cue:calendar' }, t0 + 100)).toBe('forget');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ key: 'k', label: 'the label', source: 'sentence-cue:calendar' });
    expect(written[0].dismissedAt).toBe(new Date(t0 + 100).toISOString());
  });

  it('takes effect immediately, before the file round-trips', () => {
    // The sink writes and the ingest polls; without the local update the cue
    // would flash back for a few seconds.
    registerDismissalSink(() => { /* slow writer */ });
    const t0 = 5_000_000;
    pressDismiss({ key: 'k', label: 'l', source: 's' }, t0);
    pressDismiss({ key: 'k', label: 'l', source: 's' }, t0 + 100);
    expect(isCueDismissed('k', t0 + 100 + MUTE_MS * 10)).toBe(true);   // outlives any mute
  });

  it('a press on a DIFFERENT cue in the window is a mute, not a forget', () => {
    const t0 = 6_000_000;
    pressDismiss({ key: 'a', label: 'a', source: 's' }, t0);
    expect(pressDismiss({ key: 'b', label: 'b', source: 's' }, t0 + 50)).toBe('mute');
  });

  it('degrades to a long mute with no sink (chrome), rather than lying', () => {
    const t0 = 7_000_000;
    pressDismiss({ key: 'k', label: 'l', source: 's' }, t0);
    expect(pressDismiss({ key: 'k', label: 'l', source: 's' }, t0 + 100)).toBe('forget');
    expect(isCueDismissed('k', t0 + 23 * 3600_000)).toBe(true);
    expect(isCueDismissed('k', t0 + 25 * 3600_000)).toBe(false);
  });

  it('a throwing sink never eats the keystroke', () => {
    registerDismissalSink(() => { throw new Error('disk full'); });
    const t0 = 8_000_000;
    pressDismiss({ key: 'k', label: 'l', source: 's' }, t0);
    expect(() => pressDismiss({ key: 'k', label: 'l', source: 's' }, t0 + 100)).not.toThrow();
  });
});

describe('setForgottenKeys — the live undo', () => {
  it('hydrates from disk and drops what the CLI restored', () => {
    setForgottenKeys(['gone']);
    expect(isCueDismissed('gone')).toBe(true);
    setForgottenKeys([]);                       // user ran `dismissals restore`
    expect(isCueDismissed('gone')).toBe(false); // live again, no restart
  });
});
