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

// Cache the last-applied directives + text so we can no-op when the
// runtime re-fires the same render. Without this, every keystroke
// rebuilds three Highlight objects from scratch even when the dim/
// highlight ranges haven't changed — visible as a brief style flash
// on each character typed because the browser sees Highlights torn
// down and recreated each frame.
let _lastKey: string | null = null;
let _lastTarget: HTMLElement | null = null;

function dedupKey(text: string, dimOffsets: PlainRange[], highlightOffsets: PlainRange[]): string {
  // Stable string key: any change in text or any range invalidates.
  // Cheaper than deep-comparing two arrays of {start,end}.
  let k = `t:${text.length}|d:`;
  for (const r of dimOffsets) k += `${r.start}-${r.end},`;
  k += '|h:';
  for (const r of highlightOffsets) k += `${r.start}-${r.end},`;
  return k;
}

/**
 * Apply a batch of RenderDirectives to the target's CSS Highlights.
 * Idempotent — call on every render. The runtime delivers exactly
 * what should be on screen now. No-ops when the (text, dimRanges,
 * highlightRanges) tuple is identical to the previous call so we
 * don't tear down + recreate identical Highlight objects.
 */
export function applyDirectives(target: HTMLElement, directives: RenderDirectives[]): void {
  if (!hasHighlightAPI) return;

  const dimOffsets: PlainRange[] = [];
  const highlightOffsets: PlainRange[] = [];
  for (const d of directives) {
    if (d.dimRanges) for (const r of d.dimRanges) dimOffsets.push({ start: r.start, end: r.end });
    if (d.highlight) highlightOffsets.push({ start: d.highlight.start, end: d.highlight.end });
  }

  const docText = target.textContent ?? '';
  const key = dedupKey(docText, dimOffsets, highlightOffsets);
  if (target === _lastTarget && key === _lastKey) return;
  _lastTarget = target;
  _lastKey = key;

  // Walk DOM once, distributing matches into the right buckets.
  const dimRanges = plainOffsetsToDomRanges(target, dimOffsets);
  const activeRanges = plainOffsetsToDomRanges(target, highlightOffsets);

  // Base = whole-document minus dim/active; the existing CSS treats
  // "oc-base" as the default mid-gray, which we keep by registering
  // a single range covering the whole text.
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
  _lastKey = null;
  _lastTarget = null;
  if (!hasHighlightAPI) return;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  highlights.delete('oc-base');
  highlights.delete('oc-dim');
  highlights.delete('oc-active');
}
