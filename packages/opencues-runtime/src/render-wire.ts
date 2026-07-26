// render-wire.ts — RenderDirectives[] → the minimal overlay wire shape.
//
// `collectRenderDirectives()` returns ONE RenderDirectives object per onRender
// subscriber (DimRender, MarkdownRender, BlankLoadingAnimator, …). A host that
// paints an OVERLAY over a foreign app's own glyphs — rather than rendering the
// text itself — can only annotate two things:
//
//   { dim: [[start, end], …], hl: [start, end] | null }
//
// dim = "this word has alternatives", hl = the single active/cycling span.
// Char offsets, [start,end), into the host's current buffer text — the same
// coordinate system every band uses (chrome maps identical ranges into CSS
// Custom Highlights; windows and mac resolve them to screen rects via UIA
// GetBoundingRectangles / AXBoundsForRange respectively).
//
// Markdown + coloured ranges are deliberately DROPPED: an overlay cannot
// restyle glyphs it does not own, only draw above them.
//
// WHY THIS LIVES IN THE RUNTIME: it began as integrations/windows/src/
// render-wire.cjs. The mac overlay needs byte-identical flattening — and per
// CLAUDE.md ("when a guard must exist identically on two code paths because of
// a structural split, extract it in the SAME PR that adds the second copy"),
// the second consumer is the moment to share rather than fork. Both hosts now
// call this; windows/src/render-wire.cjs is a thin re-export kept so its own
// invariants suite and hostd's require path stay valid.
//
// Pure and dependency-free on purpose: it is the one piece of overlay logic
// that can be unit-tested without a screen, a shim, or an Accessibility grant.

import type { RenderDirectives } from './adapter';

/** `[start, end)` char offsets into the host's buffer text. */
export type WireRange = readonly [number, number];

export interface RenderWire {
  readonly dim: WireRange[];
  /** At most one active span — null when nothing is being cycled. */
  readonly hl: WireRange | null;
}

/** A finite, non-empty, forward range is the only kind worth painting. */
function usable(start: unknown, end: unknown): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && (end as number) > (start as number);
}

export function mergeRenderDirectives(
  dirs: ReadonlyArray<RenderDirectives | null | undefined> | null | undefined,
): RenderWire {
  const dim: WireRange[] = [];
  let hl: WireRange | null = null;
  for (const d of Array.isArray(dirs) ? dirs : []) {
    if (!d || typeof d !== 'object') continue;
    if (Array.isArray(d.dimRanges)) {
      for (const r of d.dimRanges) {
        if (r && usable(r.start, r.end)) dim.push([r.start, r.end]);
      }
    }
    const h = d.highlight;
    // Last writer wins — there is at most one active span, and a later
    // subscriber (Cycling) supersedes an earlier one (DimRender).
    if (h && usable(h.start, h.end)) hl = [h.start, h.end];
  }
  // The active span must not ALSO paint as dim: two washes over one word reads
  // as a rendering bug, not as emphasis.
  const dedup = hl ? dim.filter(([s, e]) => !(s === hl![0] && e === hl![1])) : dim;
  return { dim: dedup, hl };
}
