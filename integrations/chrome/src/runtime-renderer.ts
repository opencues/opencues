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

const hasHighlightAPI = typeof CSS !== 'undefined' && 'highlights' in CSS;

interface PlainRange { start: number; end: number; }

/** Build [start,end) DOM Ranges from plain-text [start,end) offsets. */
function plainOffsetsToDomRanges(target: HTMLElement, offsets: PlainRange[]): Range[] {
  if (offsets.length === 0) return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let charPos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nodeStart = charPos;
    const nodeEnd = charPos + node.length;
    for (const o of offsets) {
      if (o.end <= nodeStart || o.start >= nodeEnd) continue;
      const rangeStart = Math.max(o.start - nodeStart, 0);
      const rangeEnd = Math.min(o.end - nodeStart, node.length);
      try {
        const range = new Range();
        range.setStart(node, rangeStart);
        range.setEnd(node, rangeEnd);
        out.push(range);
      } catch { /* skip — DOM mutated mid-walk */ }
    }
    charPos = nodeEnd;
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
  for (const d of directives) {
    if (d.dimRanges) for (const r of d.dimRanges) dimOffsets.push({ start: r.start, end: r.end });
    if (d.highlight) highlightOffsets.push({ start: d.highlight.start, end: d.highlight.end });
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
}

/** Tear down the runtime's highlights — called on detach/dispose. */
export function clearDirectives(): void {
  if (!hasHighlightAPI) return;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  highlights.delete('oc-dim');
  highlights.delete('oc-active');
}
