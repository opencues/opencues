import { describe, expect, it } from 'vitest';
import { applyDirectives } from './render-directives';

const INV_ON = '\x1b[7m';
const INV_OFF = '\x1b[27m';
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
});
