'use strict';

// ─── Render-directive → wire mapping (phase 2 overlay) ───────────────────
//
// `bootResult.collectRenderDirectives()` returns ONE RenderDirectives
// object per onRender subscriber (DimRender, MarkdownRender,
// BlankLoadingAnimator, ...). The Windows shim's overlay only paints two
// things — dim spans ("this word has alternatives") and the single
// active/cycling highlight — so this module flattens the array into the
// minimal wire shape:
//
//   { dim: [[start, end], ...], hl: [start, end] | null }
//
// Char offsets, [start,end), into the daemon's mirror text — the same
// coordinate system every host band uses (chrome maps the identical
// ranges into CSS Custom Highlights). Markdown/colored ranges are
// deliberately dropped: the overlay cannot restyle a foreign app's own
// glyphs, only annotate above them.
//
// Pure + dependency-free so tests/render-wire-invariants.mjs can pin it.

function mergeRenderDirectives(dirs) {
  const dim = [];
  let hl = null;
  for (const d of Array.isArray(dirs) ? dirs : []) {
    if (!d || typeof d !== 'object') continue;
    if (Array.isArray(d.dimRanges)) {
      for (const r of d.dimRanges) {
        if (r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start) {
          dim.push([r.start, r.end]);
        }
      }
    }
    const h = d.highlight;
    if (h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start) {
      hl = [h.start, h.end];   // last writer wins — there is at most one active span
    }
  }
  // The active span must not ALSO paint as dim (double ink on the same
  // word); drop any dim range that exactly matches the highlight.
  const dedup = hl ? dim.filter(([s, e]) => !(s === hl[0] && e === hl[1])) : dim;
  return { dim: dedup, hl };
}

module.exports = { mergeRenderDirectives };
