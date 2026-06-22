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
