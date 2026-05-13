import { describe, expect, it } from 'vitest';
import { applyDirectives } from './render-directives';

const INV_ON = '\x1b[97m';
const INV_OFF = '\x1b[39m';
const DIM_ON = '\x1b[2m';
const DIM_OFF = '\x1b[22m';

describe('applyDirectives', () => {
  it('returns input unchanged when directives are null/undefined', () => {
    expect(applyDirectives('hello', null)).toBe('hello');
    expect(applyDirectives('hello', undefined)).toBe('hello');
    expect(applyDirectives('hello', {})).toBe('hello');
  });

  it('textOverride short-circuits and replaces entirely', () => {
    expect(applyDirectives('original', { textOverride: 'replaced' })).toBe('replaced');
    expect(applyDirectives('original', { textOverride: '' })).toBe('');
  });

  it('highlight wraps a range on plain text', () => {
    expect(applyDirectives('hello', { highlight: { start: 1, end: 4 } }))
      .toBe(`h${INV_ON}ell${INV_OFF}o`);
  });

  it('highlight at start of string', () => {
    expect(applyDirectives('hello', { highlight: { start: 0, end: 5 } }))
      .toBe(`${INV_ON}hello${INV_OFF}`);
  });

  it('highlight at end of string', () => {
    expect(applyDirectives('hello world', { highlight: { start: 6, end: 11 } }))
      .toBe(`hello ${INV_ON}world${INV_OFF}`);
  });

  it('preserves existing ANSI codes around the highlight', () => {
    // Algorithm flushes insertions at the start of each visible position,
    // before consuming any leading ANSI for that position. So INV_ON lands
    // before \x1b[31m. Visually equivalent (both attributes apply to "hello").
    const rendered = `\x1b[31mhello\x1b[0m`;
    const out = applyDirectives(rendered, { highlight: { start: 0, end: 5 } });
    expect(out).toBe(`${INV_ON}\x1b[31mhello${INV_OFF}\x1b[0m`);
  });

  it('correctly counts visible chars across embedded ANSI', () => {
    // "ab\x1b[31mcd\x1b[0mef" → visible "abcdef". Highlight chars 2..4 (cd).
    // Highlight codes emit just before/after the visible range.
    const rendered = `ab\x1b[31mcd\x1b[0mef`;
    const out = applyDirectives(rendered, { highlight: { start: 2, end: 4 } });
    expect(out).toBe(`ab${INV_ON}\x1b[31mcd${INV_OFF}\x1b[0mef`);
  });

  it('dimRanges applied with correct codes', () => {
    expect(applyDirectives('abc 123 xyz', { dimRanges: [{ start: 4, end: 7 }] }))
      .toBe(`abc ${DIM_ON}123${DIM_OFF} xyz`);
  });

  it('multiple dimRanges', () => {
    expect(applyDirectives('a 1 b 2 c', {
      dimRanges: [{ start: 2, end: 3 }, { start: 6, end: 7 }],
    })).toBe(`a ${DIM_ON}1${DIM_OFF} b ${DIM_ON}2${DIM_OFF} c`);
  });

  it('highlight + dimRanges coexist', () => {
    const out = applyDirectives('hello world', {
      highlight: { start: 0, end: 5 },
      dimRanges: [{ start: 6, end: 11 }],
    });
    expect(out).toBe(`${INV_ON}hello${INV_OFF} ${DIM_ON}world${DIM_OFF}`);
  });

  it('empty range emits open then close codes adjacent', () => {
    expect(applyDirectives('hello', { highlight: { start: 2, end: 2 } }))
      .toBe(`he${INV_ON}${INV_OFF}llo`);
  });

  it('range beyond text length flushes trailing inserts', () => {
    expect(applyDirectives('hi', { highlight: { start: 0, end: 5 } }))
      .toBe(`${INV_ON}hi${INV_OFF}`);
  });

  it('handles no insertions case (empty arrays)', () => {
    expect(applyDirectives('hello', { dimRanges: [] })).toBe('hello');
  });

  it('handles ANSI-only string', () => {
    expect(applyDirectives('\x1b[31m\x1b[0m', { highlight: { start: 0, end: 0 } }))
      .toBe(`${INV_ON}${INV_OFF}\x1b[31m\x1b[0m`);
  });

  it('coalesces overlapping dimRanges (no premature DIM_OFF gap)', () => {
    // Without coalescing: cue dim [4,7] inside consume-all dim [0,11] would
    // emit DIM_OFF at 7, leaving 7..11 undimmed.
    const out = applyDirectives('aaaa bbb cc', {
      dimRanges: [
        { start: 0, end: 11 },
        { start: 4, end: 7 },
      ],
    });
    expect(out).toBe(`${DIM_ON}aaaa bbb cc${DIM_OFF}`);
  });

  it('merges adjacent dimRanges (touching edges)', () => {
    const out = applyDirectives('abcdef', {
      dimRanges: [
        { start: 0, end: 3 },
        { start: 3, end: 6 },
      ],
    });
    expect(out).toBe(`${DIM_ON}abcdef${DIM_OFF}`);
  });
});

describe('applyDirectives — markdown ranges (Phase 1: terminals)', () => {
  const BOLD_ON = '\x1b[1m';
  const BOLD_OFF = '\x1b[22m';
  const IT_ON = '\x1b[3m';
  const IT_OFF = '\x1b[23m';
  const CODE_ON = '\x1b[7m';
  const CODE_OFF = '\x1b[27m';
  const STRIKE_ON = '\x1b[9m';
  const STRIKE_OFF = '\x1b[29m';
  const HEAD_ON = '\x1b[1;4m';
  const HEAD_OFF = '\x1b[22;24m';

  it('wraps a bold range with ANSI bold codes (markers INCLUDED in the range)', () => {
    const out = applyDirectives('a **X** b', { boldRanges: [{ start: 2, end: 7 }] });
    expect(out).toBe(`a ${BOLD_ON}**X**${BOLD_OFF} b`);
  });

  it('wraps italic ranges', () => {
    const out = applyDirectives('a *x* b', { italicRanges: [{ start: 2, end: 5 }] });
    expect(out).toBe(`a ${IT_ON}*x*${IT_OFF} b`);
  });

  it('wraps inline code ranges (inverse video)', () => {
    const out = applyDirectives('use `npm` here', { codeRanges: [{ start: 4, end: 9 }] });
    expect(out).toBe(`use ${CODE_ON}\`npm\`${CODE_OFF} here`);
  });

  it('wraps strikethrough ranges', () => {
    const out = applyDirectives('a ~~old~~ b', { strikeRanges: [{ start: 2, end: 9 }] });
    expect(out).toBe(`a ${STRIKE_ON}~~old~~${STRIKE_OFF} b`);
  });

  it('wraps heading ranges with bold + underline', () => {
    const out = applyDirectives('# Title', { headingRanges: [{ start: 0, end: 7 }] });
    expect(out).toBe(`${HEAD_ON}# Title${HEAD_OFF}`);
  });

  it('wraps list items with dim (faint marker)', () => {
    const out = applyDirectives('- one', { listRanges: [{ start: 0, end: 5 }] });
    expect(out).toBe(`${DIM_ON}- one${DIM_OFF}`);
  });

  it('combines bold and italic ranges in one directive', () => {
    const out = applyDirectives('**bold** and *italic*', {
      boldRanges: [{ start: 0, end: 8 }],
      italicRanges: [{ start: 13, end: 21 }],
    });
    expect(out).toContain(`${BOLD_ON}**bold**${BOLD_OFF}`);
    expect(out).toContain(`${IT_ON}*italic*${IT_OFF}`);
  });

  it('empty range lists do not emit any ANSI', () => {
    const out = applyDirectives('plain text', {
      boldRanges: [],
      italicRanges: [],
      codeRanges: [],
    });
    expect(out).toBe('plain text');
  });

  it('omitted range fields: existing dim + highlight paths unaffected', () => {
    const out = applyDirectives('hello', {});
    expect(out).toBe('hello');
  });
});
