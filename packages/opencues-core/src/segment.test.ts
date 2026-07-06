/**
 * Tests for segment.ts — segmentStart(), the single source of truth for
 * "where does the command segment containing this position begin?".
 *
 * Shared by blank-shapes.ts (lineWithBlank) and config-intent-source.ts
 * (summonPhraseStart). A boundary is an ASCII terminator (.!?) followed
 * by whitespace, a CJK/fullwidth terminator (。！？．), or a newline.
 */

import { describe, expect, it } from 'vitest';
import { segmentStart } from './segment';

describe('segmentStart — happy path', () => {
  it('no boundary anywhere → returns 0 (whole buffer is one segment)', () => {
    expect(segmentStart('turn on the lights')).toBe(0);
  });

  it('single sentence terminator + space → segment starts just after it', () => {
    const text = 'hii world. voice mode off';
    const boundary = text.indexOf('. ') + 2; // index just after ". "
    expect(segmentStart(text)).toBe(boundary);
  });

  it('splits on "!" the same way as "."', () => {
    const text = 'watch out! turn on the lights';
    expect(segmentStart(text)).toBe(text.indexOf('! ') + 2);
  });

  it('splits on "?" the same way', () => {
    const text = 'are you there? volume up';
    expect(segmentStart(text)).toBe(text.indexOf('? ') + 2);
  });

  it('splits on newline', () => {
    const text = 'first line\nsecond line';
    expect(segmentStart(text)).toBe(text.indexOf('\n') + 1);
  });

  it('takes the LAST boundary before pos, not the first', () => {
    const text = 'one. two. three';
    const lastBoundary = text.lastIndexOf('. ') + 2;
    expect(segmentStart(text)).toBe(lastBoundary);
  });

  it('pos argument restricts the scan to before that position (ignores later boundaries)', () => {
    const text = 'one. two. three';
    // pos sits right at the start of "two" — only the first boundary counts.
    const posAtTwo = text.indexOf('two');
    expect(segmentStart(text, posAtTwo)).toBe(text.indexOf('. ') + 2);
  });

  it('skips leading whitespace after the boundary', () => {
    const text = 'one.   two';
    // segmentStart should land on "two", not on any of the spaces.
    expect(segmentStart(text)).toBe(text.indexOf('two'));
  });
});

describe('segmentStart — edge cases', () => {
  it('decimal numbers are NOT treated as boundaries (no whitespace lookahead match)', () => {
    // "gpt-5.4" and "3.5" — the period is immediately followed by a digit,
    // so the (?=\s) lookahead must not match.
    const text = 'the model is gpt-5.4 turn it up';
    expect(segmentStart(text)).toBe(0);
  });

  it('"3.5" mid-sentence does not split', () => {
    const text = 'version 3.5 released today';
    expect(segmentStart(text)).toBe(0);
  });

  it('CJK terminator 。 splits without requiring trailing whitespace', () => {
    const text = '你好世界。打开灯光';
    const boundary = text.indexOf('。') + 1;
    expect(segmentStart(text)).toBe(boundary);
  });

  it('CJK terminator ！ splits without trailing whitespace', () => {
    const text = '小心！打开灯光';
    expect(segmentStart(text)).toBe(text.indexOf('！') + 1);
  });

  it('fullwidth terminator ．splits without trailing whitespace', () => {
    const text = '第一部分．第二部分';
    expect(segmentStart(text)).toBe(text.indexOf('．') + 1);
  });

  it('empty string → returns 0', () => {
    expect(segmentStart('')).toBe(0);
  });

  it('whitespace-only string → returns length (all whitespace skipped) since start<text.length loop consumes it', () => {
    // start begins at 0; loop advances past every whitespace char, landing at text.length.
    const text = '   ';
    expect(segmentStart(text)).toBe(text.length);
  });

  it('single word with no boundary and no whitespace → returns 0', () => {
    expect(segmentStart('hello')).toBe(0);
  });

  it('very long single sentence with no boundary → returns 0 regardless of length', () => {
    const text = 'word '.repeat(5000).trim();
    expect(segmentStart(text)).toBe(0);
  });

  it('boundary at the very end of the string (trailing ". ") lands at text.length', () => {
    const text = 'hello world. ';
    expect(segmentStart(text)).toBe(text.length);
  });

  it('multiple consecutive boundaries (". ! ") — segment starts after the last one', () => {
    const text = 'a. ! b';
    // Both '.' (followed by space) and '!' (followed by space) are boundaries.
    // The last match position determines the start.
    const lastBang = text.lastIndexOf('!');
    const expectedStart = lastBang + 1 + 1; // '!' + following space skipped
    expect(segmentStart(text)).toBe(expectedStart);
  });

  it('pos = 0 → returns 0 (nothing before position 0 to scan)', () => {
    expect(segmentStart('one. two', 0)).toBe(0);
  });

  it('pos beyond text.length behaves like scanning the whole text', () => {
    const text = 'one. two';
    expect(segmentStart(text, 9999)).toBe(segmentStart(text));
  });

  it('default pos (omitted) reproduces the whole-buffer scan', () => {
    const text = 'one. two. three';
    expect(segmentStart(text)).toBe(segmentStart(text, text.length));
  });

  it('spaceless CJK text with an embedded ASCII "." mid-word does not falsely split (no whitespace follows)', () => {
    // Mirrors the sentence-cues doc's "spaceless CJK" caveat: a stray ASCII
    // period with no trailing whitespace should not create a boundary
    // even in a CJK context, since the lookahead requires whitespace.
    const text = '价格是9.99元人民币';
    expect(segmentStart(text)).toBe(0);
  });

  it('newline immediately followed by another newline (blank line) — boundary at first newline, whitespace-skip consumes the second', () => {
    const text = 'first\n\nthird';
    expect(segmentStart(text)).toBe(text.indexOf('third'));
  });

  it('tab and other whitespace after a boundary is skipped like a space', () => {
    const text = 'one.\tvolume up';
    expect(segmentStart(text)).toBe(text.indexOf('volume'));
  });
});

describe('segmentStart — invalid input', () => {
  it('non-string text throws (function assumes a real string per its TS signature)', () => {
    // @ts-expect-error — deliberately passing a non-string to exercise runtime behavior
    expect(() => segmentStart(null)).toThrow();
  });

  it('undefined text throws', () => {
    // @ts-expect-error — deliberately passing undefined
    expect(() => segmentStart(undefined)).toThrow();
  });

  it('negative pos is treated like "before everything" and returns 0', () => {
    // pos < text.length so `upto = text.slice(0, pos)` — slice with a
    // negative index counts from the end in native JS semantics, which is
    // surprising but is the CURRENT documented(-ish) behavior: a negative
    // pos does NOT mean "scan nothing," it slices from the end.
    const text = 'one. two. three';
    // slice(0, -1) trims the last char off, so behavior mirrors segmentStart
    // scanning almost the whole string, NOT "no boundary before position 0".
    const result = segmentStart(text, -1);
    expect(result).toBe(text.lastIndexOf('. ') + 2);
  });
});
