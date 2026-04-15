import type { WordDef } from 'cues-core';
import type { HighlightState } from '../types';
import type { SpanInfo } from '../core/cue-engine';

const hasHighlightAPI = typeof CSS !== 'undefined' && 'highlights' in CSS;

/**
 * Highlight renderer — CSS Custom Highlight API on contenteditable elements.
 * Per-word coloring with zero DOM modification.
 *
 * Textarea/input not supported — CSS Custom Highlight API only works on DOM text nodes.
 * See docs/rendering.md for the full story.
 */
export class HighlightRenderer {
  readonly target: HTMLElement;

  constructor(target: HTMLElement) {
    this.target = target;
  }

  render(_text: string, hlState: HighlightState, wordDefs: WordDef[], spans?: Record<number, SpanInfo>): void {
    if (!hasHighlightAPI) return;

    // Read DOM text directly — this is what the Highlight API will apply to.
    const domText = this.target.textContent || '';
    const words = domText.split(/\s+/).filter(w => w);

    // Build set of word indices that should be dimmed (alts or control-bound)
    const altIndices = new Set<number>();
    for (const d of wordDefs) {
      if ((d.alts && d.alts.length > 0) || d.metadata?.controlName) {
        altIndices.add(d.index);
        // Also add span-covered indices so non-origin span words get dimmed
        const spanLen = (d as any).spanLength || 1;
        for (let s = 1; s < spanLen; s++) altIndices.add(d.index + s);
      }
    }

    // If there are spans, also mark non-origin words whose origin has alts
    if (spans) {
      for (const [idx, info] of Object.entries(spans)) {
        const i = Number(idx);
        if (info.originalIndex !== i && altIndices.has(info.originalIndex)) {
          altIndices.add(i);
        }
      }
    }

    console.log('[OpenCues][renderer] words:', words, 'altIndices:', [...altIndices]);

    const activeIdx = hlState.active ? hlState.wordIndex : null;

    // Compute active span range (origin + span words)
    let activeSpanEnd = activeIdx != null ? activeIdx + 1 : -1;
    if (activeIdx != null) {
      const activeDef = wordDefs.find(d => d.index === activeIdx);
      const spanLen = (activeDef as any)?.spanLength || 1;
      if (spanLen > 1) {
        activeSpanEnd = activeIdx + spanLen;
      } else if (spans && spans[activeIdx]) {
        activeSpanEnd = activeIdx + spans[activeIdx].spanLength;
      }
    }

    const baseRanges: Range[] = [];
    const dimRanges: Range[] = [];
    const activeRanges: Range[] = [];

    // Build word positions from the DOM text
    const wordPositions: Array<{ start: number; end: number; index: number }> = [];
    let searchPos = 0;
    for (let i = 0; i < words.length; i++) {
      const start = domText.indexOf(words[i], searchPos);
      if (start >= 0) {
        wordPositions.push({ start, end: start + words[i].length, index: i });
        searchPos = start + words[i].length;
      }
    }

    // Walk DOM text nodes and create ranges at exact positions
    const walker = document.createTreeWalker(this.target, NodeFilter.SHOW_TEXT);
    let charPos = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const nodeStart = charPos;
      const nodeEnd = charPos + node.length;
      for (const wp of wordPositions) {
        if (wp.end <= nodeStart || wp.start >= nodeEnd) continue;
        const rangeStart = Math.max(wp.start - nodeStart, 0);
        const rangeEnd = Math.min(wp.end - nodeStart, node.length);
        try {
          const range = new Range();
          range.setStart(node, rangeStart);
          range.setEnd(node, rangeEnd);
          // Active span: origin + all span words
          if (activeIdx != null && wp.index >= activeIdx && wp.index < activeSpanEnd) {
            activeRanges.push(range);
          } else if (altIndices.has(wp.index)) {
            dimRanges.push(range);
          } else {
            baseRanges.push(range);
          }
        } catch { /* skip */ }
      }
      charPos = nodeEnd;
    }

    (CSS as any).highlights.set('oc-base', new (window as any).Highlight(...baseRanges));
    (CSS as any).highlights.set('oc-dim', new (window as any).Highlight(...dimRanges));
    (CSS as any).highlights.set('oc-active', new (window as any).Highlight(...activeRanges));
  }

  clearStyles(): void {
    if (hasHighlightAPI) {
      (CSS as any).highlights.delete('oc-base');
      (CSS as any).highlights.delete('oc-dim');
      (CSS as any).highlights.delete('oc-active');
    }
  }

  destroy(): void {
    this.clearStyles();
  }
}
