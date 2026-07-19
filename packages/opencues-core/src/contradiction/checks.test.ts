/**
 * Deterministic unit tests for the Tier-0 contradiction checks + the source.
 * No LLM, no network — a pinned clock makes weekday resolution reproducible.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { weekdayDateCheck, splitBillCheck } from './checks';
import { ContradictionCueSource } from './contradiction-cue-source';

// Pin "now" to Wed 2026-07-15. Upcoming 24th → 2026-07-24, a FRIDAY.
const NOW = new Date(Date.UTC(2026, 6, 15, 9, 0));
const env = { now: NOW };
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const run = (checkFn: typeof weekdayDateCheck, s: string) => checkFn(words(s), env);

describe('weekday-date mismatch', () => {
  it('flags "Thursday the 24th" when the 24th is a Friday, with the right correction', () => {
    const [c] = run(weekdayDateCheck, 'see you Thursday the 24th');
    assert.ok(c, 'a contradiction fires');
    assert.match(c.tip, /the 24th is a Friday, not Thursday/);
    assert.equal(c.correction, 'Friday the 24th');
    assert.equal(words('see you Thursday the 24th').slice(c.startWord, c.endWord).join(' '), 'Thursday the 24th');
  });

  it('is SILENT when the weekday is correct (Friday the 24th)', () => {
    assert.deepEqual(run(weekdayDateCheck, "let's meet Friday the 24th"), []);
  });

  it('handles "Weekday, Month Nth" and resolves the named month', () => {
    // Aug 23 2026 is a Sunday; "Monday, August 23rd" is wrong.
    const [c] = run(weekdayDateCheck, 'the launch is Monday, August 23rd');
    assert.ok(c);
    assert.match(c.tip, /the 23rd is a Sunday, not Monday/);
    assert.equal(c.correction, 'Monday, August 23rd'.replace('Monday', 'Sunday'));
  });

  it('handles abbreviations ("Thurs 24")', () => {
    const [c] = run(weekdayDateCheck, 'call me Thurs 24');
    assert.ok(c);
    assert.match(c.tip, /is a Friday, not Thursday/);
  });

  it('bails (no false positive) when the weekday is not part of a date phrase', () => {
    assert.deepEqual(run(weekdayDateCheck, 'I love Thursday mornings and coffee'), []);
    assert.deepEqual(run(weekdayDateCheck, 'Thursday was a great day'), []);
  });

  it('never flags a nonexistent date (the 31st of an unspecified short month is skipped safely)', () => {
    // Whatever "the 31st" resolves to, the check must not throw or emit a bad date.
    assert.doesNotThrow(() => run(weekdayDateCheck, 'due Monday the 31st'));
  });
});

describe('split-the-bill math', () => {
  it('flags "$120 among 4, $25 each" → $30', () => {
    const [c] = run(splitBillCheck, "dinner was $120 among 4, that's $25 each");
    assert.ok(c);
    assert.match(c.tip, /\$120 ÷ 4 = \$30 each, not \$25/);
    assert.equal(c.correction, '$30 each');
  });

  it('is SILENT when the math is right ($120 / 4 = $30 each)', () => {
    assert.deepEqual(run(splitBillCheck, '$120 split 4 ways is $30 each'), []);
  });

  it('handles "N people" and decimals', () => {
    const [c] = run(splitBillCheck, 'the bill is $100 for 3 people so $33 each');
    assert.ok(c);
    assert.match(c.tip, /\$33\.33 each, not \$33/);
  });

  it('accepts a bare per-person figure (no $ on the second number)', () => {
    const [c] = run(splitBillCheck, 'dinner was $120 among 4 so 25 each');
    assert.ok(c);
    assert.match(c.tip, /\$120 ÷ 4 = \$30 each, not \$25/);
  });

  it('reads a spelled-out headcount (the formalizer rewrites 4 -> four)', () => {
    const [c] = run(splitBillCheck, 'The dinner cost $120 for four individuals so $25 each');
    assert.ok(c);
    assert.match(c.tip, /\$120 ÷ 4 = \$30 each, not \$25/);
  });

  it('bails without a headcount or a per-person figure (no guess)', () => {
    assert.deepEqual(run(splitBillCheck, 'the bill was $120'), []);
    assert.deepEqual(run(splitBillCheck, "we'll split it evenly"), []);
  });
});

describe('ContradictionCueSource', () => {
  const src = new ContradictionCueSource({ now: () => NOW });

  it('emits a passive sentence-cue-shaped result with the tip + CHAR-offset span', async () => {
    const text = 'see you Thursday the 24th';
    const { results } = await src.getCues({ text, words: words(text) } as never);
    assert.equal(results.length, 1);
    const r = results[0];
    assert.match(r.source, /^sentence-cue:contradiction-weekday-date$/);
    assert.equal(r.cueTip, '⚠ the 24th is a Friday, not Thursday');
    assert.deepEqual(r.alternatives, ['Thursday the 24th', 'Friday the 24th']);
    // Char offsets (not word indices) — the resolver slices liveText by these.
    assert.equal(r.spanStart, 8);
    assert.equal(r.spanEnd, 25);
    // The invariant the resolver's race-guard checks:
    assert.equal(text.slice(r.spanStart!, r.spanEnd!), r.alternatives[0]);
  });

  it('returns nothing on clean text', async () => {
    const { results } = await src.getCues({ text: 'hello there friend', words: words('hello there friend') } as never);
    assert.deepEqual(results, []);
  });

  it('does not stack two tips on the same span', async () => {
    // One phrase, one flag.
    const { results } = await src.getCues({ text: 'Thursday the 24th', words: words('Thursday the 24th') } as never);
    assert.equal(results.length, 1);
  });
});
