import { describe, expect, it } from 'vitest';
import { locateViewportSlice, translateDirectivesToViewport } from './viewport';
import type { RenderDirectives } from '../../../src/adapter';

// The bug these pin (Sep 2026): CC renders tall buffers through a scrolled
// viewport; building the render ctx from the slice made full-buffer spans
// read as stale and lose their dim ("draft email _ doesn't go grey" —
// reproduced identically on CC 2.1.206 and 2.1.236).

const EMAIL = 'Subject: [Subject]\n\nDear [Recipient],\n\n[Body]\n\nBest regards,\nWilfred';

describe('locateViewportSlice', () => {
  it('full text renders as-is → offset 0, full length', () => {
    expect(locateViewportSlice(EMAIL, EMAIL, 0)).toEqual({ offset: 0, length: EMAIL.length });
  });

  it('scrolled slice (first line off-screen) → mid-buffer offset', () => {
    const slice = EMAIL.slice(18); // "\nDear [Recipient],..."
    expect(locateViewportSlice(EMAIL, slice, EMAIL.length)).toEqual({ offset: 18, length: slice.length });
  });

  it('CC cursor-cell pad: exactly ONE trailing space not in the buffer still matches', () => {
    expect(locateViewportSlice('HELLO WORLD', 'HELLO WORLD ', 11)).toEqual({ offset: 0, length: 11 });
    const slice = EMAIL.slice(18) + ' ';
    expect(locateViewportSlice(EMAIL, slice, EMAIL.length)).toEqual({ offset: 18, length: EMAIL.length - 18 });
  });

  it('two trailing pad spaces are NOT trimmed (could be user text)', () => {
    expect(locateViewportSlice('HELLO WORLD', 'HELLO WORLD  ', 11)).toBeNull();
  });

  it('non-contiguous slice (soft-wrap inserted chars) → null, caller falls back', () => {
    expect(locateViewportSlice('a long unbroken line of text', 'a long unbroken\nline of text', 0)).toBeNull();
  });

  it('empty slice / slice longer than buffer → null', () => {
    expect(locateViewportSlice('', ' ', 0)).toBeNull();
    expect(locateViewportSlice('ab', 'abc', 0)).toBeNull();
  });

  it('ambiguous repetitive buffer → first occurrence containing the cursor wins', () => {
    const full = 'line\nline\nline\nline';
    // slice "line\nline" occurs at 0, 5, 10. Cursor 12 is inside the
    // occurrences at 5 and 10 — the FIRST containing one (5) wins; with
    // repetitive content every containing occurrence paints identically,
    // so first-wins is deterministic and good enough.
    expect(locateViewportSlice(full, 'line\nline', 12)).toEqual({ offset: 5, length: 9 });
    // Cursor at 2 → only the occurrence at 0 contains it.
    expect(locateViewportSlice(full, 'line\nline', 2)).toEqual({ offset: 0, length: 9 });
    // Cursor inside none (impossible in practice) → first occurrence.
    expect(locateViewportSlice(full, 'line\nline', 999)).toEqual({ offset: 0, length: 9 });
  });
});

describe('translateDirectivesToViewport', () => {
  const d: RenderDirectives = {
    dimRanges: [{ start: 0, end: 143 }],
    highlight: { start: 20, end: 30 },
    coloredRanges: [{ start: 140, end: 141, ansi: 'red' }],
    inlineNote: { spanStart: 0, spanEnd: 143, text: 'note', hint: '(underscore to cycle)' },
  };

  it('unscrolled fast path returns the directives untouched', () => {
    expect(translateDirectivesToViewport(d, 0, 143, 143)).toBe(d);
  });

  it('shifts and clips every range family into slice coords', () => {
    const t = translateDirectivesToViewport(d, 18, 125, 143);
    expect(t.dimRanges).toEqual([{ start: 0, end: 125 }]);       // 0-143 clipped into the 125-char slice
    expect(t.highlight).toEqual({ start: 2, end: 12 });           // 20-30 shifted by -18
    expect(t.coloredRanges).toEqual([{ start: 122, end: 123, ansi: 'red' }]);
    expect(t.inlineNote).toEqual({ spanStart: 0, spanEnd: 125, text: 'note', hint: '(underscore to cycle)' });
  });

  it('ranges entirely off-screen are dropped', () => {
    const t = translateDirectivesToViewport(
      { dimRanges: [{ start: 0, end: 10 }], highlight: { start: 5, end: 10 } },
      18, 125, 143,
    );
    expect(t.dimRanges).toEqual([]);
    expect(t.highlight).toBeUndefined();
  });

  it('inlineNote fully off-screen is dropped, never clamped to a fake anchor', () => {
    const t = translateDirectivesToViewport(
      { inlineNote: { spanStart: 0, spanEnd: 10, text: 'note' } },
      18, 125, 143,
    );
    expect(t.inlineNote).toBeNull();
  });

  it('whole-buffer textOverride (glimmer) is sliced to the viewport; other lengths pass through', () => {
    const full = 'x'.repeat(143);
    const t = translateDirectivesToViewport({ textOverride: full }, 18, 125, 143);
    expect(t.textOverride).toBe('x'.repeat(125));
    const odd = translateDirectivesToViewport({ textOverride: 'short' }, 18, 125, 143);
    expect(odd.textOverride).toBe('short');
  });
});
