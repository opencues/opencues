/**
 * Tests for the shared keyword-window predicate.
 * Run: node --test dist/keyword-window.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { keywordInWindow, keywordGap, lineOfWords, LINE_SCOPE_FALLBACK_PROXIMITY } from './keyword-window';

describe('keywordGap', () => {
  it('0 when adjacent, N for N words between', () => {
    assert.strictEqual(keywordGap(0, 1), 0); // brightness _
    assert.strictEqual(keywordGap(0, 2), 1); // brightness 70 _
    assert.strictEqual(keywordGap(2, 11), 8);
  });
});

describe('lineOfWords', () => {
  it('matches the flat split order with per-word line numbers', () => {
    assert.deepStrictEqual(lineOfWords('a b c'), [0, 0, 0]);
    assert.deepStrictEqual(lineOfWords('a\nb c'), [0, 1, 1]);
    assert.deepStrictEqual(lineOfWords('a b\n\nc'), [0, 0, 2]); // blank line bumps the index
    // word order identical to text.split(/\s+/).filter(Boolean)
    const text = 'i adjusted the brightness\nplease set it to 50 _';
    const words = text.split(/\s+/).filter(Boolean);
    assert.strictEqual(lineOfWords(text).length, words.length);
  });
});

describe('keywordInWindow — gate OFF (per-blank proximity)', () => {
  it('within proximity → true; beyond → false', () => {
    assert.strictEqual(keywordInWindow(0, 1, 0), true);  // adjacent, proximity 0
    assert.strictEqual(keywordInWindow(0, 2, 0), false); // 1 between, proximity 0
    assert.strictEqual(keywordInWindow(0, 2, 3), true);  // 1 between, proximity 3
    assert.strictEqual(keywordInWindow(0, 5, 3), false); // 4 between, proximity 3
  });
});

describe('keywordInWindow — gate ON (line-scoped)', () => {
  // "i adjusted the brightness\nplease set it to 50 _"
  // words:  i(0) adjusted(1) the(2) brightness(3) | please(4) set(5) it(6) to(7) 50(8) _(9)
  // lineOf: 0    0           0      0              | 1         1       1     1      1     1
  const lineOf = lineOfWords('i adjusted the brightness\nplease set it to 50 _');

  it('keyword on the SAME line as _ → true (any distance, ignores proximity 0)', () => {
    // "brightness 70 _" on one line: keyword idx 0, _ idx 2, same line
    const same = lineOfWords('brightness in the room was nice today 50 _');
    const kwEnd = 0, blankIdx = same.length - 1;
    assert.strictEqual(keywordInWindow(kwEnd, blankIdx, 0, { lineScoped: true, lineOf: same }), true);
  });

  it('keyword on a PREVIOUS line → false (even though proximity would allow it)', () => {
    // brightness at idx 3 (line 0), _ at idx 9 (line 1)
    assert.strictEqual(keywordInWindow(3, 9, 99, { lineScoped: true, lineOf }), false);
  });

  it('falls back to a wide fixed window when lineOf is absent', () => {
    assert.strictEqual(keywordInWindow(0, 5, 0, { lineScoped: true }), true);  // gap 4 ≤ 12
    assert.strictEqual(keywordInWindow(0, 5 + LINE_SCOPE_FALLBACK_PROXIMITY + 2, 0, { lineScoped: true }), false);
  });
});
