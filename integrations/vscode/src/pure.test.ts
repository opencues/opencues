import { describe, expect, it } from 'vitest';
import {
  coalesceRanges,
  computeSingleRangeEdit,
  looksLikeExternalMutation,
  underWordGate,
  parseDotEnv,
  EXTERNAL_MUTATION_CHAR_THRESHOLD,
} from './pure';

describe('coalesceRanges (Q11)', () => {
  it('merges a cue-word range nested inside a span range', () => {
    expect(coalesceRanges([{ start: 0, end: 20 }, { start: 5, end: 9 }]))
      .toEqual([{ start: 0, end: 20 }]);
  });
  it('merges adjacent ranges', () => {
    expect(coalesceRanges([{ start: 0, end: 5 }, { start: 5, end: 9 }]))
      .toEqual([{ start: 0, end: 9 }]);
  });
  it('keeps disjoint ranges, sorted', () => {
    expect(coalesceRanges([{ start: 10, end: 12 }, { start: 0, end: 4 }]))
      .toEqual([{ start: 0, end: 4 }, { start: 10, end: 12 }]);
  });
  it('handles empty and single inputs', () => {
    expect(coalesceRanges([])).toEqual([]);
    expect(coalesceRanges([{ start: 1, end: 2 }])).toEqual([{ start: 1, end: 2 }]);
  });
});

describe('computeSingleRangeEdit (D12)', () => {
  it('returns null when texts are equal', () => {
    expect(computeSingleRangeEdit('same', 'same')).toBeNull();
  });
  it('produces a minimal mid-text replacement (word cycle)', () => {
    expect(computeSingleRangeEdit('the attorney filed', 'the lawyer filed'))
      .toEqual({ start: 4, end: 12, text: 'lawyer' });
  });
  it('handles pure insertion and pure deletion', () => {
    expect(computeSingleRangeEdit('ab', 'aXb')).toEqual({ start: 1, end: 1, text: 'X' });
    expect(computeSingleRangeEdit('aXb', 'ab')).toEqual({ start: 1, end: 2, text: '' });
  });
  it('handles whole-buffer replacement', () => {
    expect(computeSingleRangeEdit('old', 'new')).toEqual({ start: 0, end: 3, text: 'new' });
  });
  it('repeated-char boundaries do not overlap prefix and suffix', () => {
    // 'aaa' → 'aa': prefix must not eat what suffix already claimed.
    const edit = computeSingleRangeEdit('aaa', 'aa');
    expect(edit).not.toBeNull();
    const applied = 'aaa'.slice(0, edit!.start) + edit!.text + 'aaa'.slice(edit!.end);
    expect(applied).toBe('aa');
  });
});

describe('looksLikeExternalMutation (Q14)', () => {
  it('single-char typing is not external', () => {
    expect(looksLikeExternalMutation([{ rangeOffset: 5, rangeLength: 0, textLength: 1 }])).toBe(false);
  });
  it('a short word completion is not external', () => {
    expect(looksLikeExternalMutation([{ rangeOffset: 5, rangeLength: 0, textLength: 8 }])).toBe(false);
  });
  it('multi-range edits (formatter / multi-cursor) are external', () => {
    expect(looksLikeExternalMutation([
      { rangeOffset: 0, rangeLength: 1, textLength: 1 },
      { rangeOffset: 40, rangeLength: 1, textLength: 1 },
    ])).toBe(true);
  });
  it('a large single insert (paste / Copilot accept) is external', () => {
    expect(looksLikeExternalMutation([
      { rangeOffset: 5, rangeLength: 0, textLength: EXTERNAL_MUTATION_CHAR_THRESHOLD },
    ])).toBe(true);
  });
  it('a large single delete (cut) is external', () => {
    expect(looksLikeExternalMutation([
      { rangeOffset: 5, rangeLength: 120, textLength: 0 },
    ])).toBe(true);
  });
  it('no changes is not external', () => {
    expect(looksLikeExternalMutation([])).toBe(false);
  });
});

describe('underWordGate (D14)', () => {
  it('0 disables the gate', () => {
    expect(underWordGate('a '.repeat(10_000), 0)).toBe(true);
  });
  it('counts whitespace-delimited words across newlines', () => {
    expect(underWordGate('one two\nthree four', 4)).toBe(true);
    expect(underWordGate('one two\nthree four five', 4)).toBe(false);
  });
  it('empty text passes any gate', () => {
    expect(underWordGate('', 500)).toBe(true);
  });
});

describe('parseDotEnv', () => {
  it('parses plain, exported, and quoted values; skips comments', () => {
    const parsed = parseDotEnv([
      '# comment',
      'GROQ_API_KEY=gsk_abc',
      'export CEREBRAS_API_KEY="csk_def"',
      "OPENAI_API_KEY='sk-ghi'",
      '',
      'not a kv line',
      'EMPTY=',
    ].join('\n'));
    expect(parsed).toEqual({
      GROQ_API_KEY: 'gsk_abc',
      CEREBRAS_API_KEY: 'csk_def',
      OPENAI_API_KEY: 'sk-ghi',
    });
  });
});
