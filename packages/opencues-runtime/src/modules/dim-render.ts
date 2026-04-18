// DimRender — computes RenderDirectives on every onRender event.
//
// Two visual layers:
//   1. Dim ranges for every word that's a known cue / control / step-pattern
//      match — visual hint that the word is navigable.
//   2. Highlight range over the actively-selected word (overrides the dim).
//
// The host renders dim and highlight via applyDirectives in the bootstrap.

import type { HostAdapter, Range, RenderContext, RenderDirectives, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';
import { splitWords } from './navigation';

export class DimRender {
  private _unsub: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private _dynDefs: DynDefs,
    private configLoader?: ConfigLoader,
    private spanFillState?: SpanFillState,
  ) {}

  subscribe(): void {
    this._unsub = this.adapter.onRender(ctx => this.compute(ctx));
  }

  unsubscribe(): void {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  /**
   * Pure: takes a render context, returns directives or null.
   * Exposed for unit testing without the subscribe pipeline.
   */
  compute(ctx: RenderContext): RenderDirectives | null {
    const hasHighlightCap = this.adapter.capabilities.includes('highlight-range');
    const hasDimCap = this.adapter.capabilities.includes('dim-ranges');

    const words = splitWords(ctx.text);

    // Dim ranges: every cue / control / step-pattern word that is NOT the
    // currently-highlighted one. The highlight overlay takes priority on
    // the active word so we don't dim it (would dim under inverse).
    const dimRanges: Range[] = [];
    const activeIndex = this.hlState.active ? this.hlState.wordIndex : null;
    if (hasDimCap && this.configLoader) {
      const navigable = this.configLoader.navigableWords;
      for (const w of words) {
        if (w.index === activeIndex) continue;
        const lc = w.word.toLowerCase().replace(/[\u200B\u200C]/g, '');
        if (lc.length === 0) continue;
        if (navigable.has(lc) || this.configLoader.matchStepPattern(w.word)) {
          dimRanges.push({ start: w.start, end: w.end });
        }
      }
    }

    // Step 32 / Phase F.a — when a span fill is active, treat the whole
    // span as one block. If the active highlight isn't inside it, dim
    // the whole span. If it IS inside, the highlight (below) extends to
    // cover the entire span and we skip the dim layer to avoid stacking
    // attributes (inverse + dim renders inconsistently across terminals).
    const span = this.spanFillState?.current ?? null;
    const spanLen = span ? Math.max(1, span.spanLength) : 0;
    const activeInSpan = span !== null
      && activeIndex !== null
      && activeIndex >= span.index
      && activeIndex < span.index + spanLen;

    if (hasDimCap && span && !activeInSpan) {
      const startWord = words[span.index];
      const endWord = words[span.index + spanLen - 1];
      if (startWord && endWord) {
        dimRanges.push({ start: startWord.start, end: endWord.end });
      }
    }

    // Highlight: the active word (overlaid). When the active word is
    // inside a span fill, expand the highlight to cover the entire span
    // — that's how the user sees a multi-word fill as one cycleable unit.
    let highlight: { start: number; end: number } | undefined;
    if (hasHighlightCap && this.hlState.active && this.hlState.wordIndex !== null) {
      if (activeInSpan && span) {
        const startWord = words[span.index];
        const endWord = words[span.index + spanLen - 1];
        if (startWord && endWord) {
          highlight = { start: startWord.start, end: endWord.end };
        }
      } else {
        const target = words[this.hlState.wordIndex];
        if (target) {
          highlight = { start: target.start, end: target.end };
        }
      }
    }

    if (!highlight && dimRanges.length === 0) return null;
    return { highlight, dimRanges };
  }
}
