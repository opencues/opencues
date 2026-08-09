import { describe, expect, it } from 'vitest';
import {
  dismissalKey, dismissalLabel, parseDismissals, serializeDismissals,
  addDismissal, removeDismissal, dismissedKeySet, type DismissalRecord,
} from './dismissals';
import { normalizeCommitmentStatement } from './session-commitments';

const rec = (over: Partial<DismissalRecord> = {}): DismissalRecord => ({
  key: 'clashes with dentist 10 00',
  label: 'clashes with dentist 10:00',
  source: 'sentence-cue:calendar',
  dismissedAt: '2026-08-08T09:00:00Z',
  ...over,
});

describe('dismissalKey', () => {
  it('agrees with the watchlist normalization — one notion of "the same claim"', () => {
    // Load-bearing: dismissal and supersession must not disagree about
    // identity, or a forgotten claim comes back under a different key.
    for (const s of ['Use Bun, not Node', 'the shader border width is set to 8px']) {
      expect(dismissalKey(s)).toBe(normalizeCommitmentStatement(s));
    }
  });

  it('collapses punctuation, case and spacing', () => {
    expect(dismissalKey('15 Aug 2026 is a Saturday, not a Friday'))
      .toBe(dismissalKey('15 aug 2026  is a saturday   not a friday'));
  });

  it('ignores the leading note emoji — same advisory, same key', () => {
    expect(dismissalKey('⚠ clashes with dentist')).toBe(dismissalKey('clashes with dentist'));
    expect(dismissalKey('📅 clashes with dentist')).toBe(dismissalKey('⚠ clashes with dentist'));
  });

  it('is empty for text with nothing in it (never dismissable)', () => {
    expect(dismissalKey('⚠')).toBe('');
    expect(dismissalKey('   ')).toBe('');
  });

  it('does NOT collapse a rephrasing — the documented limit', () => {
    // Forget covers exact restatements; a reworded one reads as a new cue.
    // Pinned so the limit is a decision, not a surprise.
    expect(dismissalKey('use Bun, not Node')).not.toBe(dismissalKey('switch to Bun'));
  });
});

describe('dismissalLabel', () => {
  it('strips the emoji but keeps the words as shown', () => {
    expect(dismissalLabel('⚠ 15 Aug 2026 is a Saturday')).toBe('15 Aug 2026 is a Saturday');
  });
});

describe('parseDismissals', () => {
  it('round-trips through serialize', () => {
    const records = [rec(), rec({ key: 'k2', label: 'another' })];
    expect(parseDismissals(serializeDismissals(records))).toEqual(records);
  });

  it('keeps the well-formed rows of a partly broken file', () => {
    const raw = JSON.stringify({ dismissed: [rec(), null, { label: 'no key here' }, 42] });
    const out = parseDismissals(raw);
    expect(out).toHaveLength(2);
    expect(out[1].key).toBe(dismissalKey('no key here'));   // key derived from label
  });

  it('accepts a legacy bare array', () => {
    expect(parseDismissals(JSON.stringify([rec()]))).toHaveLength(1);
  });

  it('returns nothing for junk rather than throwing — a bad file must not take a host down', () => {
    expect(parseDismissals('not json at all')).toEqual([]);
    expect(parseDismissals('')).toEqual([]);
  });
});

describe('add / remove', () => {
  it('re-dismissing refreshes rather than duplicating', () => {
    const first = addDismissal([], rec());
    const again = addDismissal(first, rec({ dismissedAt: '2026-08-09T09:00:00Z' }));
    expect(again).toHaveLength(1);
    expect(again[0].dismissedAt).toBe('2026-08-09T09:00:00Z');
  });

  it('removing an absent key is a no-op — restore is safe to run twice', () => {
    const records = [rec()];
    expect(removeDismissal(records, 'nothing-like-this')).toEqual(records);
    expect(removeDismissal(removeDismissal(records, rec().key), rec().key)).toEqual([]);
  });

  it('dismissedKeySet gives the runtime its lookup', () => {
    expect(dismissedKeySet([rec(), rec({ key: 'k2' })]).has('k2')).toBe(true);
  });
});
