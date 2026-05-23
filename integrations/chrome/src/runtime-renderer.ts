// CE.2 + CE.3 — translate runtime RenderDirectives into CSS Custom
// Highlight API ranges. Replaces the engine-walk in
// src/ui/highlight-renderer.ts.
//
// Inputs:
//   - target: the contenteditable the runtime is bound to.
//   - directives: array of { dimRanges?, highlight? } from
//     bootResult.collectRenderDirectives().
//
// Output: updates CSS.highlights for 'oc-base' / 'oc-dim' / 'oc-active'.
// All ranges are computed against the target's textContent in plain
// text (to match the runtime's offset coordinate system) and mapped
// back to DOM Range objects via a TreeWalker.

import type { RenderDirectives } from '@opencues/runtime/dist/src/adapter';
import { walkPlainText } from './dom-walk';

const hasHighlightAPI = typeof CSS !== 'undefined' && 'highlights' in CSS;

interface PlainRange { start: number; end: number; }

/** Build [start,end) DOM Ranges from plain-text [start,end) offsets.
 *  Uses walkPlainText so the offsets agree with the runtime's view of
 *  text — including \n at BR / block boundaries that have no Text
 *  node behind them. Highlights for a range that lands on a virtual
 *  \n are silently skipped (no Text node to anchor onto). */
function plainOffsetsToDomRanges(target: HTMLElement, offsets: PlainRange[]): Range[] {
  if (offsets.length === 0) return [];
  const { segments } = walkPlainText(target);
  const out: Range[] = [];
  for (const seg of segments) {
    // Skip IMG-emoji segments (`<img alt="👋">` on Gmail/Slack/etc.) —
    // dom-walk emits them so plain-text math agrees with the visible
    // string, but they're not real Text nodes (no `.data`) and a
    // browser Range can't anchor on the IMG character. Same policy
    // the doc-comment above already applies to virtual `\n` segments:
    // silently skip; the highlight just doesn't render on that glyph.
    if (seg.node.nodeType !== Node.TEXT_NODE) continue;
    for (const o of offsets) {
      if (o.end <= seg.plainStart || o.start >= seg.plainEnd) continue;
      const rangeStart = Math.max(o.start - seg.plainStart, 0);
      const rangeEnd = Math.min(o.end - seg.plainStart, seg.node.data.length);
      try {
        const range = new Range();
        range.setStart(seg.node, rangeStart);
        range.setEnd(seg.node, rangeEnd);
        out.push(range);
      } catch { /* skip — DOM mutated mid-walk */ }
    }
  }
  return out;
}

/**
 * Apply a batch of RenderDirectives to the target's CSS Highlights.
 * Idempotent — call on every render. The runtime delivers exactly
 * what should be on screen now. NO dedup: every call re-walks the
 * DOM and rebuilds Ranges. Reason: in tiptap/PM-managed
 * contenteditables, the editor's MutationObserver reconciles after
 * our writeText and replaces the Text nodes our Ranges point at;
 * dedup would let the post-cycle render short-circuit and leave
 * stale Ranges in place. Re-walking is cheap (single TreeWalker pass
 * over a typical chat-input subtree), so always-rebuild is the right
 * trade.
 */
export function applyDirectives(target: HTMLElement, directives: RenderDirectives[]): void {
  if (!hasHighlightAPI) return;

  const dimOffsets: PlainRange[] = [];
  const highlightOffsets: PlainRange[] = [];
  // Per-colour buckets — coloredRanges from BlankLoadingAnimator carry
  // an `rgb` field (chrome opts into 'render-rgb-color' capability so
  // boot-common picks the rgb path). Group by colour so we register one
  // Highlight per unique colour with all matching ranges.
  const coloredByHex = new Map<string, PlainRange[]>();
  for (const d of directives) {
    if (d.dimRanges) for (const r of d.dimRanges) dimOffsets.push({ start: r.start, end: r.end });
    if (d.highlight) highlightOffsets.push({ start: d.highlight.start, end: d.highlight.end });
    if (d.coloredRanges) {
      for (const cr of d.coloredRanges) {
        if (!cr.rgb) continue;
        const hex = cr.rgb.toLowerCase();
        let bucket = coloredByHex.get(hex);
        if (!bucket) { bucket = []; coloredByHex.set(hex, bucket); }
        bucket.push({ start: cr.start, end: cr.end });
      }
    }
  }

  // Walk DOM once, distributing matches into the right buckets.
  const dimRanges = plainOffsetsToDomRanges(target, dimOffsets);
  const activeRanges = plainOffsetsToDomRanges(target, highlightOffsets);

  // The default mid-tone colour comes from the .oc-attached CSS class
  // on the contenteditable itself (see content.css), NOT from an
  // oc-base highlight — that path used to cause "all white" flashes
  // when reconciliation invalidated the base Range mid-cycle.
  const Highlight = (window as { Highlight?: typeof globalThis.Highlight }).Highlight;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  if (!Highlight) return;
  highlights.set('oc-dim', new Highlight(...dimRanges));
  highlights.set('oc-active', new Highlight(...activeRanges));

  // Per-colour loading highlights. Each unique colour gets a Highlight
  // named `oc-load-RRGGBB` (the hex without `#`). The CSS rule for
  // that name is injected on demand via ensureLoadingColorStyle so the
  // CSS Custom Highlight engine has a `color:` to paint with.
  // Cache the set of colours we've seen so we can DROP stale ones when
  // an animator stops — otherwise old colours linger in the highlights
  // map and the stylesheet grows monotonically.
  for (const seen of _knownLoadingHexes) {
    if (!coloredByHex.has(seen)) {
      highlights.delete(`oc-load-${seen.slice(1)}`);
    }
  }
  _knownLoadingHexes.clear();
  for (const [hex, ranges] of coloredByHex) {
    _knownLoadingHexes.add(hex);
    ensureLoadingColorStyle(hex);
    const domRanges = plainOffsetsToDomRanges(target, ranges);
    highlights.set(`oc-load-${hex.slice(1)}`, new Highlight(...domRanges));
  }
}

// Tracks every `#hex` we've registered a Highlight for in the current
// render cycle. The applyDirectives next-cycle path uses it to GC any
// colours that fell out of the active set (animator stopped) so the
// CSS Custom Highlight map stays small.
const _knownLoadingHexes = new Set<string>();

const LOADING_STYLE_ID = 'oc-loading-color-styles';

/** Inject (idempotently) a `::highlight(oc-load-RRGGBB)` rule for the
 *  given hex so the CSS engine has a colour to paint matching ranges. */
function ensureLoadingColorStyle(hex: string): void {
  const name = `oc-load-${hex.slice(1)}`;
  let sheet = document.getElementById(LOADING_STYLE_ID) as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = LOADING_STYLE_ID;
    document.head.appendChild(sheet);
  }
  const rule = `::highlight(${name}) { color: ${hex} !important; }`;
  // Cheap dedup — search the existing text for the rule.
  if ((sheet.textContent ?? '').includes(rule)) return;
  sheet.appendChild(document.createTextNode(rule + '\n'));
}

/** Tear down the runtime's highlights — called on detach/dispose. */
export function clearDirectives(): void {
  if (!hasHighlightAPI) return;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  highlights.delete('oc-dim');
  highlights.delete('oc-active');
}
