import type { WordDef } from 'cues-core';
import type { HighlightState } from '../types';
import type { SpanInfo } from '../core/cue-engine';

const hasHighlightAPI = typeof CSS !== 'undefined' && 'highlights' in CSS;

/**
 * Highlight renderer:
 *
 * Contenteditable: CSS Custom Highlight API — per-word coloring, zero DOM modification.
 * Textarea/Input: Swaps to a contenteditable div that inherits all computed styles.
 *   The original input is hidden. Value synced both ways.
 */
export class HighlightRenderer {
  readonly target: HTMLElement;
  /** If we swapped a form input, these track the swap */
  private swappedInput: HTMLTextAreaElement | HTMLInputElement | null = null;
  private swappedDiv: HTMLDivElement | null = null;

  constructor(target: HTMLElement) {
    this.target = target;
  }

  /** Replace input with contenteditable div, sync value both ways */
  private swapInput(input: HTMLTextAreaElement | HTMLInputElement): HTMLDivElement {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    div.textContent = input.value;
    div.spellcheck = input.spellcheck;

    const isTextarea = input instanceof HTMLTextAreaElement;

    // Capture exact dimensions and styles BEFORE hiding
    const cs = getComputedStyle(input);
    const rect = input.getBoundingClientRect();

    // Copy visual styles
    const copyProps = [
      'font', 'font-family', 'font-size', 'font-weight', 'font-style',
      'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent',
      'text-transform', 'color', 'background-color', 'background',
      'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
      'border-radius', 'box-sizing', 'box-shadow',
      'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'direction', 'text-decoration',
    ];
    for (const prop of copyProps) {
      div.style.setProperty(prop, cs.getPropertyValue(prop));
    }
    // Use exact pixel dimensions from getBoundingClientRect to prevent layout shift
    div.style.width = rect.width + 'px';
    div.style.height = rect.height + 'px';
    div.style.boxSizing = 'border-box';
    div.style.display = isTextarea ? 'block' : 'inline-block';
    div.style.whiteSpace = isTextarea ? 'pre-wrap' : 'nowrap';
    div.style.overflowWrap = isTextarea ? 'break-word' : 'normal';
    div.style.overflow = isTextarea ? 'auto' : 'hidden';
    div.style.outline = cs.outline; // preserve original outline
    div.style.cursor = 'text';

    // Hide original, place div after it
    input.style.display = 'none';
    input.insertAdjacentElement('afterend', div);

    // Sync div → input
    div.addEventListener('input', () => {
      input.value = div.textContent || '';
    });

    // Focus
    if (document.activeElement === input) div.focus();

    return div;
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
    if (this.swappedInput && this.swappedDiv) {
      this.swappedInput.value = this.swappedDiv.textContent || '';
      this.swappedInput.style.display = '';
      this.swappedDiv.remove();
      this.swappedDiv = null;
      this.swappedInput = null;
    }
  }
}
