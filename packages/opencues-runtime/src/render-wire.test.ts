// Tests for the overlay wire mapping shared by the windows shim and the mac
// AX overlay. Pure input → output: no screen, no shim, no Accessibility grant.
//
// The windows integration has its own suite (tests/render-wire-invariants.mjs)
// which still passes against this module after the extraction; these cases pin
// the contract from the runtime side so a future edit here can't silently
// change what either host paints.

import { describe, expect, it } from 'vitest';
import { mergeRenderDirectives } from './render-wire';
import type { RenderDirectives } from './adapter';

const d = (o: Partial<RenderDirectives>): RenderDirectives => o as RenderDirectives;

describe('mergeRenderDirectives', () => {
  it('flattens dim ranges from every subscriber, preserving order', () => {
    const wire = mergeRenderDirectives([
      d({ dimRanges: [{ start: 0, end: 4 }, { start: 5, end: 9 }] }),
      d({ dimRanges: [{ start: 10, end: 14 }] }),
    ]);
    expect(wire.dim).toEqual([[0, 4], [5, 9], [10, 14]]);
    expect(wire.hl).toBeNull();
  });

  it('takes the LAST highlight — a later subscriber supersedes an earlier one', () => {
    // DimRender may propose one; Cycling, running later, owns the active span.
    const wire = mergeRenderDirectives([
      d({ highlight: { start: 0, end: 4 } }),
      d({ highlight: { start: 10, end: 16 } }),
    ]);
    expect(wire.hl).toEqual([10, 16]);
  });

  it('never paints the active span as dim as well (no double ink)', () => {
    const wire = mergeRenderDirectives([
      d({ dimRanges: [{ start: 0, end: 4 }, { start: 10, end: 16 }] }),
      d({ highlight: { start: 10, end: 16 } }),
    ]);
    expect(wire.dim).toEqual([[0, 4]]);
    expect(wire.hl).toEqual([10, 16]);
  });

  it('drops ranges an overlay cannot paint (empty, reversed, non-finite)', () => {
    const wire = mergeRenderDirectives([
      d({ dimRanges: [
        { start: 3, end: 3 },                       // empty
        { start: 9, end: 4 },                       // reversed
        { start: Number.NaN, end: 5 },              // non-finite
        { start: 0, end: Number.POSITIVE_INFINITY },// non-finite
        { start: 1, end: 2 },                       // the only good one
      ] }),
      d({ highlight: { start: 7, end: 7 } }),        // empty → no highlight
    ]);
    expect(wire.dim).toEqual([[1, 2]]);
    expect(wire.hl).toBeNull();
  });

  it('ignores markdown/coloured ranges — an overlay cannot restyle foreign glyphs', () => {
    const wire = mergeRenderDirectives([
      d({
        boldRanges: [{ start: 0, end: 4 }],
        italicRanges: [{ start: 5, end: 9 }],
        coloredRanges: [{ start: 0, end: 4, ansi: 'red' }],
        textOverride: 'nope',
      } as Partial<RenderDirectives>),
    ]);
    expect(wire.dim).toEqual([]);
    expect(wire.hl).toBeNull();
  });

  it('survives junk input — an empty wire CLEARS the overlay, never throws', () => {
    // A throwing mapper would leave stale rects painted over the user's text.
    for (const input of [null, undefined, [], [null], [undefined], ['nope' as unknown as RenderDirectives], [{} as RenderDirectives]]) {
      const wire = mergeRenderDirectives(input as never);
      expect(wire).toEqual({ dim: [], hl: null });
    }
  });
});
