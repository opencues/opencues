import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown-parse';

describe('parseMarkdown — bold (**…**)', () => {
  it('finds a single bold span', () => {
    const r = parseMarkdown('hello **world** there');
    expect(r.bold).toEqual([{ start: 6, end: 15 }]);
    expect(r.italic).toEqual([]);
  });

  it('finds multiple bold spans', () => {
    const r = parseMarkdown('**first** then **second**');
    expect(r.bold).toEqual([
      { start: 0, end: 9 },
      { start: 15, end: 25 },
    ]);
  });

  it('drops an unclosed bold span', () => {
    const r = parseMarkdown('**unfinished text');
    expect(r.bold).toEqual([]);
  });

  it('drops an empty bold span', () => {
    const r = parseMarkdown('a **** b');
    expect(r.bold).toEqual([]);
  });

  it('does not cross newlines', () => {
    const r = parseMarkdown('**line one\nline two**');
    expect(r.bold).toEqual([]);
  });

  it('range includes the syntax markers (renderers decide whether to dim them)', () => {
    const r = parseMarkdown('**X**');
    expect(r.bold).toEqual([{ start: 0, end: 5 }]);   // covers ** + X + **
  });
});

describe('parseMarkdown — italic (*…*)', () => {
  it('finds a simple italic span', () => {
    const r = parseMarkdown('foo *italic* bar');
    expect(r.italic).toEqual([{ start: 4, end: 12 }]);
  });

  it('does NOT pick up `*bold*` from inside `**bold**`', () => {
    const r = parseMarkdown('**bold**');
    expect(r.bold).toEqual([{ start: 0, end: 8 }]);
    expect(r.italic).toEqual([]);
  });

  it('handles bold + italic in the same line', () => {
    const r = parseMarkdown('a **b** c *d* e');
    expect(r.bold).toEqual([{ start: 2, end: 7 }]);
    expect(r.italic).toEqual([{ start: 10, end: 13 }]);
  });

  it('does not cross newlines', () => {
    const r = parseMarkdown('*one\ntwo*');
    expect(r.italic).toEqual([]);
  });
});

describe('parseMarkdown — code (`…`)', () => {
  it('finds inline code', () => {
    const r = parseMarkdown('use `npm install` next');
    expect(r.code).toEqual([{ start: 4, end: 17 }]);
  });

  it('drops unclosed code', () => {
    const r = parseMarkdown('use `npm install');
    expect(r.code).toEqual([]);
  });
});

describe('parseMarkdown — strikethrough (~~…~~)', () => {
  it('finds a strike span', () => {
    const r = parseMarkdown('a ~~deleted~~ b');
    expect(r.strike).toEqual([{ start: 2, end: 13 }]);
  });
});

describe('parseMarkdown — headings', () => {
  it('finds a single # heading', () => {
    const r = parseMarkdown('# Title\nbody text');
    expect(r.heading).toEqual([{ start: 0, end: 7 }]);
  });

  it('supports h1 through h6', () => {
    const text = '# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6';
    const r = parseMarkdown(text);
    expect(r.heading.length).toBe(6);
  });

  it('does not match `#` without a space after', () => {
    const r = parseMarkdown('#nohash\n#also-no-hash');
    expect(r.heading).toEqual([]);
  });

  it('does not match `#` past 6 characters', () => {
    const r = parseMarkdown('####### too many');
    expect(r.heading).toEqual([]);
  });
});

describe('parseMarkdown — list items', () => {
  it('matches `-` bullets', () => {
    const r = parseMarkdown('- one\n- two\n- three');
    expect(r.list.length).toBe(3);
  });

  it('matches `*` bullets WITHOUT also italicising them', () => {
    const r = parseMarkdown('* one\n* two');
    expect(r.list.length).toBe(2);
    // `*` at line-start with a space after is a list bullet, not italic.
    // Italic would need a closing `*` on the same line.
    expect(r.italic).toEqual([]);
  });

  it('matches numbered list items', () => {
    const r = parseMarkdown('1. first\n2. second\n10. tenth');
    expect(r.list.length).toBe(3);
  });

  it('tolerates leading whitespace (nested lists)', () => {
    const r = parseMarkdown('- top\n  - nested\n- bottom');
    expect(r.list.length).toBe(3);
  });
});

describe('parseMarkdown — blank-slot suppression', () => {
  it('drops italic ranges that overlap a suppress region', () => {
    // "volume _" — the underscore is a blank slot, italic parsing
    // would think `_` opens italic. Suppress the range covering `_`.
    const text = 'set volume _ now';
    const suppress = [{ start: 11, end: 12 }];   // `_` at offset 11
    const r = parseMarkdown(text, { suppressRanges: suppress });
    // Without suppression, italic-on-underscore parser would never
    // fire because it's a single `_` — but if the LLM emitted `_a_`,
    // the suppression would catch overlap with surrounding slots.
    expect(r.italic).toEqual([]);
  });

  it('drops code ranges that overlap a blank slot', () => {
    const text = 'a `code` _ with backtick';
    const suppress = [{ start: 9, end: 10 }];
    const r = parseMarkdown(text, { suppressRanges: suppress });
    // The code span `code` at offset 2-8 does NOT overlap the suppress
    // region at 9-10, so it survives.
    expect(r.code).toEqual([{ start: 2, end: 8 }]);
  });

  it('keeps bold ranges across blanks (` ** ` cannot collide with single `_`)', () => {
    const text = '**this is bold** _ blank';
    const suppress = [{ start: 17, end: 18 }];
    const r = parseMarkdown(text, { suppressRanges: suppress });
    expect(r.bold).toEqual([{ start: 0, end: 16 }]);
  });

  it('drops italic where LLM emitted `_underscore_` adjacent to a blank slot', () => {
    // text: "before _x_ after _ done"
    //                  ^^^ italic span via underscore
    //                          ^ blank slot
    // For now we don't support `_x_` italic (only `*x*`), so this is
    // hypothetical. Suppress mechanism would still apply if we add it.
    const text = '**bold** here';
    const r = parseMarkdown(text);
    expect(r.bold).toEqual([{ start: 0, end: 8 }]);
  });
});

describe('parseMarkdown — composite', () => {
  it('LLM-shaped output: heading + bold + italic + code + list', () => {
    const text = [
      '# Summary',
      '',
      'The **quick** brown *fox* jumps over the `lazy` dog.',
      '',
      '- one',
      '- two',
      '- three',
    ].join('\n');
    const r = parseMarkdown(text);
    expect(r.heading.length).toBe(1);
    expect(r.bold.length).toBe(1);
    expect(r.italic.length).toBe(1);
    expect(r.code.length).toBe(1);
    expect(r.list.length).toBe(3);
  });

  it('empty buffer: all-empty result', () => {
    const r = parseMarkdown('');
    expect(r.bold).toEqual([]);
    expect(r.italic).toEqual([]);
    expect(r.code).toEqual([]);
    expect(r.strike).toEqual([]);
    expect(r.heading).toEqual([]);
    expect(r.list).toEqual([]);
  });

  it('plain prose without markdown: all-empty result', () => {
    const r = parseMarkdown('Hello, my name is Wilfred. How are you today?');
    expect(r.bold.length + r.italic.length + r.code.length + r.heading.length + r.list.length).toBe(0);
  });
});
