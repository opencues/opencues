import { describe, expect, it } from 'vitest';
import { buildIndexMap } from './coord-map';

describe('buildIndexMap — logical→painted coordinate mapping', () => {
  it('identity when texts are equal', () => {
    const m = buildIndexMap('hello world', 'hello world');
    expect(m.start(0)).toBe(0);
    expect(m.end(11)).toBe(11);
    expect(m.start(6)).toBe(6);
  });

  it('maps a whole-buffer range to FULL painted coverage across a space→\\n wrap', () => {
    // Claude Code soft-wrap REPLACES a space with \n at the wrap column.
    const content = 'すべての通信は HTTPS を使用します。';
    const ctx = content.replace('HTTPS を', 'HTTPS\nを');
    expect(ctx.length).toBe(content.length); // substitution, same length
    const m = buildIndexMap(content, ctx);
    // Whole buffer must cover the entire painted text (the drift bug clamped
    // short here, leaving trailing chars undimmed).
    expect(m.start(0)).toBe(0);
    expect(m.end(content.length)).toBe(ctx.length);
  });

  it('handles a bare mid-CJK-word \\n insert (no space at the wrap column)', () => {
    const content = '認証メカニズムを使用します。';
    const ctx = content.replace('認証メカニズ', '認証メカニズ\n'); // +1 insert
    expect(ctx.length).toBe(content.length + 1);
    const m = buildIndexMap(content, ctx);
    expect(m.start(0)).toBe(0);
    expect(m.end(content.length)).toBe(ctx.length);
  });

  it('aligns a MID range on the non-whitespace skeleton (both wrap kinds present)', () => {
    const content = 'すべての通信は HTTPS を使用します。安全な認証メカニズムを使用します。';
    const ctx = content.replace('HTTPS を', 'HTTPS\nを').replace('認証メカニズ', '認証メカニズ\n');
    const m = buildIndexMap(content, ctx);
    // Map the 2nd sentence; the mapped ctx slice must hold the same VISIBLE
    // chars (whitespace/wrap differences allowed).
    const i = content.indexOf('安全な');
    const e = content.length;
    const slice = ctx.slice(m.start(i), m.end(e));
    expect(slice.replace(/\s/g, '')).toBe(content.slice(i, e).replace(/\s/g, ''));
  });

  it('treats ZWS as soft layout (render-kick in painted text)', () => {
    const content = 'abcdef';
    const ctx = 'abc​def'; // ZWS inserted mid-string
    const m = buildIndexMap(content, ctx);
    expect(m.start(0)).toBe(0);
    expect(m.end(6)).toBe(ctx.length);
    // "def" (content [3,6)) maps past the ZWS.
    expect(ctx.slice(m.start(3), m.end(6))).toBe('def');
  });

  it('clamps safely when painted DROPPED visible chars (lossy transient)', () => {
    // `to` is missing visible content (e.g. mid-resolve / viewport clip) — the
    // skeletons don't correspond; never emit an out-of-range index.
    const content = 'the quick brown fox jumps';
    const ctx = 'the quick'; // truncated
    const m = buildIndexMap(content, ctx);
    expect(m.start(0)).toBeGreaterThanOrEqual(0);
    expect(m.end(content.length)).toBeLessThanOrEqual(ctx.length);
    expect(m.start(20)).toBeLessThanOrEqual(ctx.length);
  });
});

describe('buildIndexMap — boundary + invalid-input edge cases', () => {
  it('zero-length range (start === end at the same index) maps identically for identical text', () => {
    const m = buildIndexMap('hello world', 'hello world');
    // start(i) is identity for identical from/to text at any position.
    for (const i of [0, 3, 6, 11]) {
      expect(m.start(i)).toBe(i);
    }
    // end(i) is identity too, EXCEPT immediately after a whitespace run,
    // where it deliberately snaps back to exclude trailing whitespace
    // (see the dedicated whitespace-position test below) — i=3 and i=11
    // aren't preceded by whitespace, so identity holds there.
    expect(m.end(3)).toBe(3);
    expect(m.end(11)).toBe(11);
  });

  it('zero-length range at a WHITESPACE position: start snaps forward, end snaps back', () => {
    // Index 5 in "hello world" is the space between the two words.
    // start() snaps forward to the next visible char (6, 'w'); end()
    // snaps back to just past the last visible char before it (5, still
    // "hello"'s length since 'o' at index 4 ends at 5).
    const m = buildIndexMap('hello world', 'hello world');
    expect(m.start(5)).toBe(6);
    expect(m.end(5)).toBe(5);
  });

  it('zero-length span at buffer START maps to 0 on both ends', () => {
    const m = buildIndexMap('hello', '  hello'); // leading whitespace inserted
    expect(m.start(0)).toBe(0);
    expect(m.end(0)).toBe(0);
  });

  it('zero-length span at buffer END maps to to.length on both ends', () => {
    const content = 'hello';
    const ctx = 'hello   '; // trailing whitespace inserted
    const m = buildIndexMap(content, ctx);
    expect(m.start(content.length)).toBe(ctx.length);
    expect(m.end(content.length)).toBe(ctx.length);
  });

  it('negative index inputs are clamped rather than producing a negative or NaN result', () => {
    const m = buildIndexMap('hello world', 'hello world');
    expect(m.start(-5)).toBe(0);
    expect(m.end(-5)).toBe(0);
    expect(Number.isNaN(m.start(-1))).toBe(false);
    expect(Number.isNaN(m.end(-1))).toBe(false);
  });

  it('index far beyond string length clamps to to.length, never throws or overflows', () => {
    const m = buildIndexMap('hi', 'hi there');
    expect(() => m.start(100000)).not.toThrow();
    expect(() => m.end(100000)).not.toThrow();
    expect(m.start(100000)).toBeLessThanOrEqual('hi there'.length);
    expect(m.end(100000)).toBeLessThanOrEqual('hi there'.length);
  });

  it('empty `from` and empty `to` strings: every mapping collapses to 0', () => {
    const m = buildIndexMap('', '');
    expect(m.start(0)).toBe(0);
    expect(m.end(0)).toBe(0);
  });

  it('empty `from` against a non-empty `to`: start/end clamp to bounds without throwing', () => {
    const m = buildIndexMap('', 'unexpected content');
    expect(() => m.start(0)).not.toThrow();
    expect(m.start(0)).toBeGreaterThanOrEqual(0);
  });

  it('astral emoji (surrogate pair) in both from/to does not corrupt the non-whitespace skeleton', () => {
    // Emoji are 2 UTF-16 code units each but never whitespace, so they
    // count as 2 non-whitespace "chars" on both sides consistently.
    const content = 'status 😀 report';
    const ctx = content.replace(' 😀 ', ' 😀\n'); // simulate a wrap: space→\n after emoji
    const m = buildIndexMap(content, ctx);
    expect(m.start(0)).toBe(0);
    expect(m.end(content.length)).toBe(ctx.length);
    // The emoji itself must map through as a whole (not split mid-surrogate).
    const emojiStart = content.indexOf('😀');
    const mappedStart = m.start(emojiStart);
    const mappedEnd = m.end(emojiStart + 2); // emoji is 2 code units
    expect(ctx.slice(mappedStart, mappedEnd)).toBe('😀');
  });

  it('fully disjoint single-character buffers (no shared prefix/suffix)', () => {
    const m = buildIndexMap('a', 'b');
    expect(m.start(0)).toBe(0);
    expect(m.end(1)).toBe(1);
  });
});
