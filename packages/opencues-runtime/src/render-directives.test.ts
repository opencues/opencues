import { describe, expect, it } from 'vitest';
import { applyDirectives, inlineNoteBoxColumn, truncateToCells, wrapToCellLines } from './render-directives';

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

// The OpenTUI hosts (OpenCode / shell) can't splice a note line into the
// textarea's own render, so they float an absolute overlay line at this
// column. It must match the terminal splice's alignment: the `↳ ` CONNECTOR
// lands ON the span's column, pointing at the value's first character.
// Aligning the MESSAGE instead (what this did until 2026-08-16) makes the
// alignment depend on whichever character the message begins with — an emoji's
// mark is drawn narrower than its cell and lands a fraction off, a word lands
// on exactly — so the same note wobbled by message.
describe('inlineNoteBoxColumn', () => {
  it('span at column 0 → flush left', () => {
    expect(inlineNoteBoxColumn('attorney filed today', 0)).toBe(0);
  });

  it('mid-line ASCII span → the span\'s own column', () => {
    // "the " = 4 cells before the span, so the connector starts at 4.
    expect(inlineNoteBoxColumn('the attorney filed', 4)).toBe(4);
  });

  it('CJK prefix counted in visual cells, not code units', () => {
    // "日本語" = 3 code units but 6 cells → 6, not 3.
    expect(inlineNoteBoxColumn('日本語x', 3)).toBe(6);
  });

  it('only the span line prefix counts (prior lines ignored)', () => {
    // "line1\n" then "the cat"; span at 'cat' (offset 10). Line prefix
    // "the " = 4 cells → 4, independent of line1's length.
    expect(inlineNoteBoxColumn('line1\nthe cat', 10)).toBe(4);
  });

  it('out-of-range spanStart is clamped to the buffer length', () => {
    expect(inlineNoteBoxColumn('hi', 999)).toBe(2);
  });
});

// The gemini-cli host clips directives per visual line and calls
// applyDirectives on the single line containing the span; the note must
// splice in as a real extra line (`\n ↳ …`) so Ink renders a pushed-down
// row. Same splice CC uses. Pins the mechanism gemini depends on.
describe('applyDirectives — inlineNote splice (per-line, gemini/CC)', () => {
  it('appends the note as a new line after a single-line span', () => {
    const out = applyDirectives('the meeting is friday', {
      dimRanges: [],
      inlineNote: { spanStart: 0, spanEnd: 21, text: '⚠ the 19th is a Friday' },
    });
    // original line text is preserved verbatim at the front
    expect(out.startsWith('the meeting is friday')).toBe(true);
    // a real newline is introduced (the pushed-down row)
    expect(out).toContain('\n');
    // the connector + formatted advisory land on that new line
    expect(out).toContain('↳');
    // Terminal splice pads the double-width emoji with an extra space.
    expect(out).toContain('⚠  the 19th is a Friday');
  });

  it('no inlineNote → line unchanged (no spurious newline)', () => {
    expect(applyDirectives('plain line', { dimRanges: [] })).toBe('plain line');
  });
});

// ── maxNoteCols wrapping (Sep 2026 — "config _ note is clipped") ────────
// CC's Ink box TRUNCATES over-wide lines to a bare `…`, so an unclamped
// note line (span-column pad + connector + a 78-char setting description)
// vanished entirely on narrow terminals. Platform parity is the spec:
// chrome lays the same note out `pre-wrap` in a max-width and the OpenTUI
// hosts wrap it as a flow <text> — so the splice hosts now WRAP the note
// into hang-indented continuation lines within the host-supplied width.
// Fixtures are synthetic shapes per CLAUDE.md — the pins are widths and
// line structure.
describe('applyDirectives — maxNoteCols wrapping', () => {
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  const noteLines = (out: string): string[] => stripAnsi(out).split('\n').slice(1);
  const buffer = 'aaaa ZZ';
  const base = { spanStart: 5, spanEnd: 7 };

  it('fits on one line → byte-identical to the unclamped splice', () => {
    const d = { inlineNote: { ...base, text: 'ALT-ONE note', hint: '(underscore to cycle)' } };
    expect(applyDirectives(buffer, d, 0, 120)).toBe(applyDirectives(buffer, d, 0));
  });

  it('no maxNoteCols → single unclamped line (bridge renderedText contract)', () => {
    const long = 'x'.repeat(200);
    const out = applyDirectives(buffer, { inlineNote: { ...base, text: long } }, 0);
    const lines = noteLines(out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(long);
  });

  it('over-wide note WRAPS — every word survives, no line exceeds the budget', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
    const out = applyDirectives(buffer, { inlineNote: { ...base, text } }, 0, 30);
    const lines = noteLines(out);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    // Nothing is lost — parity with chrome/OpenTUI, not an ellipsis.
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('kilo lima');
  });

  it('continuation lines hang-indent under the message (pad + connector width)', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel';
    const out = applyDirectives(buffer, { inlineNote: { ...base, text } }, 0, 25);
    const lines = noteLines(out);
    expect(lines.length).toBeGreaterThan(1);
    // First line: 5-col pad then the connector.
    expect(lines[0].indexOf('↳')).toBe(5);
    // Continuations: pad + 2 (connector width) of spaces, then text.
    for (const l of lines.slice(1)) expect(l.slice(0, 7)).toBe(' '.repeat(7));
  });

  it('the hint wraps with the text (inline, like chrome) — never dropped', () => {
    const d = { inlineNote: { ...base, text: 'ALT-ONE note body words here', hint: '(underscore to cycle)' } };
    const out = applyDirectives(buffer, d, 0, 25);
    expect(stripAnsi(out)).toContain('(underscore to');
  });

  it('spaceless CJK hard-breaks cell-aware — no line overshoots', () => {
    const d = { inlineNote: { ...base, text: '設定'.repeat(30) } };
    const out = applyDirectives(buffer, d, 0, 30);
    for (const l of noteLines(out)) {
      const cells = [...l].reduce((n, ch) => n + (/[　-鿿]/.test(ch) ? 2 : 1), 0);
      expect(cells).toBeLessThanOrEqual(30);
    }
    // All 60 glyphs survive across the wrapped lines.
    const glyphs = noteLines(out).join('').replace(/[^設定]/g, '');
    expect(glyphs.length).toBe(60);
  });

  it('span column too deep → pad shifts LEFT to keep a readable measure', () => {
    const deep = ' '.repeat(70) + 'ZZ';
    const d = { inlineNote: { spanStart: 70, spanEnd: 72, text: 'ALT-FIX body here' } };
    const lines = noteLines(applyDirectives(deep, d, 0, 40));
    expect(lines[0].indexOf('↳')).toBeLessThan(70);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);
    expect(lines[0]).toMatch(/↳ ALT-FIX/);
  });
});

describe('wrapToCellLines', () => {
  it('fits → single line untouched', () => {
    expect(wrapToCellLines('short note', 20)).toEqual(['short note']);
  });
  it('greedy word wrap at spaces', () => {
    expect(wrapToCellLines('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd']);
  });
  it('hard-breaks a token wider than the budget', () => {
    expect(wrapToCellLines('xxxxxxxxxx', 4)).toEqual(['xxxx', 'xxxx', 'xx']);
  });
  it('CJK counts 2 cells per glyph', () => {
    expect(wrapToCellLines('設定設定設定', 4)).toEqual(['設定', '設定', '設定']);
  });
});

describe('truncateToCells', () => {
  it('returns text unchanged when it fits', () => {
    expect(truncateToCells('short', 10)).toBe('short');
  });
  it('reserves a cell for the ellipsis', () => {
    expect(truncateToCells('abcdef', 4)).toBe('abc…');
  });
  it('CJK is 2 cells wide', () => {
    expect(truncateToCells('設定設定', 5)).toBe('設定…'); // 2+2 then no room for a third
  });
  it('degenerate budget → bare ellipsis', () => {
    expect(truncateToCells('abc', 1)).toBe('…');
  });
});
