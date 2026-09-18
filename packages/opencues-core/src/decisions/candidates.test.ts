import { describe, it, expect } from 'vitest';
import { underscoreRouteDraft, spellingEligible, edits1, replaceCandidates, SPELLING_MAX_CANDIDATES } from './candidates';

describe('candidates cut in code', () => {
  it('windows a long buffer around the `_`', () => {
    const long = 'a'.repeat(9000) + ' zephyr _ ' + 'b'.repeat(3000);
    const d = underscoreRouteDraft(long, 1000);
    expect(d.length).toBe(1000);
    expect(d).toContain('zephyr _');
    expect(underscoreRouteDraft('short _')).toBe('short _');
  });

  it('spellingEligible: letters only, 3+ chars, not an acronym, not code / paths / numbers', () => {
    for (const w of ['zephyr', 'Quark,', 'behaviour', 'colour']) expect(spellingEligible(w), w).toBe(true);
    for (const w of ['ab', 'CI', 'JWT', 'v1.2', '@opencues/core', 'foo_bar', 'x-y', '20', '/tmp/a', "it's"]) expect(spellingEligible(w), w).toBe(false);
  });

  it('edits1: the common shapes first, the typed word excluded, capped for the option limit', () => {
    const c = edits1('zephr');
    expect(c).toContain('zephyr');
    expect(c).not.toContain('zephr');
    // deletions / transpositions / doublings (tier 1) come before vowel inserts (tier 2)
    expect(c.indexOf('zeph')).toBeLessThan(c.indexOf('zephyr'));
    expect(edits1('exponentialy').length).toBeLessThanOrEqual(SPELLING_MAX_CANDIDATES);
    expect(edits1('exponentialy')).toContain('exponentially');
  });

  it('replaceCandidates: words and 2-grams, punctuation-trimmed and deduped; commands are the suffixes ending at the _', () => {
    const { targets, commands } = replaceCandidates('alpha zephyr, beta zap the word _');
    expect(targets.slice(0, 4)).toEqual(['alpha', 'zephyr', 'beta', 'zap']);
    expect(targets).toContain('alpha zephyr');
    expect(commands).toEqual(['word _', 'the word _', 'zap the word _', 'beta zap the word _', 'zephyr, beta zap the word _', 'alpha zephyr, beta zap the word _']);
    expect(replaceCandidates('no blank here').commands).toEqual([]);
  });
});
