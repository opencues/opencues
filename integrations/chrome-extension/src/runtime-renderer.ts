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

import type { RenderDirectives } from 'opencues-runtime/dist/src/adapter';

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
 * what should be on screen now.
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

  // Base = whole-document minus dim/active; the existing CSS treats
  // "oc-base" as the default mid-gray, which we keep by registering
  // a single range covering the whole text.
  const docText = target.textContent ?? '';
  const baseRanges: Range[] = [];
  if (docText.length > 0) {
    const baseSpan = plainOffsetsToDomRanges(target, [{ start: 0, end: docText.length }]);
    baseRanges.push(...baseSpan);
  }

  const Highlight = (window as { Highlight?: typeof globalThis.Highlight }).Highlight;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  if (!Highlight) return;
  highlights.set('oc-base', new Highlight(...baseRanges));
  highlights.set('oc-dim', new Highlight(...dimRanges));
  highlights.set('oc-active', new Highlight(...activeRanges));
}

/** Tear down the runtime's highlights — called on detach/dispose. */
export function clearDirectives(): void {
  if (!hasHighlightAPI) return;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  highlights.delete('oc-base');
  highlights.delete('oc-dim');
  highlights.delete('oc-active');
}
