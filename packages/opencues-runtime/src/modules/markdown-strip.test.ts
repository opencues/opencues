import { describe, expect, it } from 'vitest';
import { stripMarkdown } from './markdown-strip';

describe('stripMarkdown — bold', () => {
  it('strips a single bold span; range in stripped coords', () => {
    const r = stripMarkdown('hello **world** there');
    expect(r.stripped).toBe('hello world there');
    expect(r.bold).toEqual([{ start: 6, end: 11 }]);
    expect(r.hadMarkdown).toBe(true);
  });

  it('strips multiple bold spans', () => {
    const r = stripMarkdown('**first** then **second**');
    expect(r.stripped).toBe('first then second');
    expect(r.bold).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 17 },
    ]);
  });

  it('keeps unclosed bold markers literal', () => {
    const r = stripMarkdown('**unfinished text');
    expect(r.stripped).toBe('**unfinished text');
    expect(r.bold).toEqual([]);
    expect(r.hadMarkdown).toBe(false);
  });

  it('keeps empty bold pairs literal', () => {
    const r = stripMarkdown('a **** b');
    expect(r.stripped).toBe('a **** b');
    expect(r.bold).toEqual([]);
  });

  it('does not cross newlines', () => {
    const r = stripMarkdown('**line one\nline two**');
    expect(r.stripped).toBe('**line one\nline two**');
    expect(r.bold).toEqual([]);
  });
});

describe('stripMarkdown — italic', () => {
  it('strips a single italic span', () => {
    const r = stripMarkdown('foo *italic* bar');
    expect(r.stripped).toBe('foo italic bar');
    expect(r.italic).toEqual([{ start: 4, end: 10 }]);
  });

  it('does NOT match `*` inside `**bold**`', () => {
    const r = stripMarkdown('**bold**');
    expect(r.stripped).toBe('bold');
    expect(r.bold).toEqual([{ start: 0, end: 4 }]);
    expect(r.italic).toEqual([]);
  });

  it('handles bold + italic on the same line', () => {
    const r = stripMarkdown('a **b** c *d* e');
    expect(r.stripped).toBe('a b c d e');
    expect(r.bold).toEqual([{ start: 2, end: 3 }]);
    expect(r.italic).toEqual([{ start: 6, end: 7 }]);
  });
});

describe('stripMarkdown — code', () => {
  it('strips inline code', () => {
    const r = stripMarkdown('use `npm install` next');
    expect(r.stripped).toBe('use npm install next');
    expect(r.code).toEqual([{ start: 4, end: 15 }]);
  });

  it('keeps unclosed backticks literal', () => {
    const r = stripMarkdown('use `npm install');
    expect(r.stripped).toBe('use `npm install');
    expect(r.code).toEqual([]);
  });
});

describe('stripMarkdown — strikethrough', () => {
  it('strips a strike span', () => {
    const r = stripMarkdown('a ~~deleted~~ b');
    expect(r.stripped).toBe('a deleted b');
    expect(r.strike).toEqual([{ start: 2, end: 9 }]);
  });
});

describe('stripMarkdown — headings', () => {
  it('strips a single # heading marker, keeps the title text', () => {
    const r = stripMarkdown('# Title\nbody text');
    expect(r.stripped).toBe('Title\nbody text');
    expect(r.heading).toEqual([{ start: 0, end: 5 }]);
  });

  it('strips h1 through h6 (the leading `#`s + space all gone)', () => {
    const r = stripMarkdown('# one\n## two\n### three');
    expect(r.stripped).toBe('one\ntwo\nthree');
    expect(r.heading.length).toBe(3);
  });

  it('does not match `#` without a space', () => {
    const r = stripMarkdown('#nohash');
    expect(r.stripped).toBe('#nohash');
    expect(r.heading).toEqual([]);
  });
});

describe('stripMarkdown — list items', () => {
  it('strips `- ` bullet markers; keeps content', () => {
    const r = stripMarkdown('- one\n- two\n- three');
    expect(r.stripped).toBe('one\ntwo\nthree');
    expect(r.list.length).toBe(3);
  });

  it('strips `* ` bullets', () => {
    const r = stripMarkdown('* one\n* two');
    expect(r.stripped).toBe('one\ntwo');
    expect(r.list.length).toBe(2);
    expect(r.italic).toEqual([]);
  });

  it('strips numbered list markers', () => {
    const r = stripMarkdown('1. first\n2. second\n10. tenth');
    expect(r.stripped).toBe('first\nsecond\ntenth');
    expect(r.list.length).toBe(3);
  });

  it('preserves leading whitespace for nested lists', () => {
    const r = stripMarkdown('- top\n  - nested\n- bottom');
    expect(r.stripped).toBe('top\n  nested\nbottom');
    expect(r.list.length).toBe(3);
  });
});

describe('stripMarkdown — composite (LLM-shaped output)', () => {
  it('strips all six features in one buffer', () => {
    const input = [
      '# Summary',
      '',
      'The **quick** brown *fox* jumps over the `lazy` dog.',
      '',
      '- one',
      '- two',
      '- three',
    ].join('\n');
    const r = stripMarkdown(input);
    expect(r.stripped).toBe([
      'Summary',
      '',
      'The quick brown fox jumps over the lazy dog.',
      '',
      'one',
      'two',
      'three',
    ].join('\n'));
    expect(r.heading.length).toBe(1);
    expect(r.bold.length).toBe(1);
    expect(r.italic.length).toBe(1);
    expect(r.code.length).toBe(1);
    expect(r.list.length).toBe(3);
  });

  it('plain prose: idempotent, no markdown detected', () => {
    const r = stripMarkdown('Hello, my name is Wilfred. How are you today?');
    expect(r.stripped).toBe('Hello, my name is Wilfred. How are you today?');
    expect(r.hadMarkdown).toBe(false);
  });

  it('empty input: empty result, no markdown', () => {
    const r = stripMarkdown('');
    expect(r.stripped).toBe('');
    expect(r.hadMarkdown).toBe(false);
  });
});

describe('stripMarkdown — blank-slot suppression', () => {
  it('keeps `*` literal when the underlying region is a blank slot', () => {
    // text "volume _" — suppress range covers `_` at offset 7-8.
    // No italic candidates here, so this is the trivial pass case.
    const r = stripMarkdown('volume _', { suppressRanges: [{ start: 7, end: 8 }] });
    expect(r.stripped).toBe('volume _');
    expect(r.italic).toEqual([]);
  });

  it('keeps italic markers literal if their span overlaps a suppress region', () => {
    // Imagine LLM emitted `volume *_* now` and `_` is a blank slot.
    // The italic pair would normally consume *_*, but suppress drops it.
    const r = stripMarkdown('volume *_* now', { suppressRanges: [{ start: 8, end: 9 }] });
    expect(r.stripped).toBe('volume *_* now');
    expect(r.italic).toEqual([]);
  });

  it('strips bold even across a blank slot when the slot is inside the pair', () => {
    // Bold (`**`) is two characters — its syntax can't collide with a
    // single `_`. We still suppress overlaps to be safe (rule: if any
    // suppress range falls inside the span, leave markers literal).
    const r = stripMarkdown('**hello _ world**', { suppressRanges: [{ start: 8, end: 9 }] });
    expect(r.stripped).toBe('**hello _ world**');
    expect(r.bold).toEqual([]);
  });

  it('preserves bold OUTSIDE blank slot regions', () => {
    const r = stripMarkdown('**bold** here _ blank', { suppressRanges: [{ start: 14, end: 15 }] });
    expect(r.stripped).toBe('bold here _ blank');
    expect(r.bold).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('stripMarkdown — round-trip & idempotence', () => {
  it('stripping twice is a no-op (idempotent)', () => {
    const once = stripMarkdown('**hello** world').stripped;
    const twice = stripMarkdown(once).stripped;
    expect(twice).toBe(once);
  });

  it('input with no markdown returns hadMarkdown=false', () => {
    expect(stripMarkdown('plain').hadMarkdown).toBe(false);
    expect(stripMarkdown('').hadMarkdown).toBe(false);
    expect(stripMarkdown('a*b').hadMarkdown).toBe(false);   // not italic — no close
  });
});
