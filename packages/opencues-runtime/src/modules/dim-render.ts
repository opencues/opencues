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
import type { SelectorSatelliteState } from '../state/selector-satellite';
import { splitWords } from './navigation';

export class DimRender {
  private _unsub: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader?: ConfigLoader,
    private spanFillState?: SpanFillState,
    private selectorSatelliteState?: SelectorSatelliteState,
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
    // currently-highlighted one AND not inside an active span/satellite
    // (those get whole-region highlight; individual cue dim there would
    // appear as random word-fading inside an otherwise bright unit).
    const dimRanges: Range[] = [];
    const activeIndex = this.hlState.active ? this.hlState.wordIndex : null;
    const span = this.spanFillState?.current ?? null;
    const spanLen = span ? Math.max(1, span.spanLength) : 0;
    const ss = this.selectorSatelliteState?.current ?? null;
    const ssSelEnd = ss ? ss.selectorIndex + Math.max(1, ss.selectorLength) - 1 : 0;
    const ssSatEnd = ss ? ss.satelliteIndex + Math.max(1, ss.satelliteLength) - 1 : 0;
    const activeInSpanRegion = span !== null && activeIndex !== null
      && activeIndex >= span.index && activeIndex < span.index + spanLen;
    const activeInSelector = ss !== null && activeIndex !== null
      && activeIndex >= ss.selectorIndex && activeIndex <= ssSelEnd;
    const activeInSatellite = ss !== null && activeIndex !== null
      && activeIndex >= ss.satelliteIndex && activeIndex <= ssSatEnd;
    const isInsideActiveBlock = (i: number): boolean => {
      if (activeInSpanRegion && span && i >= span.index && i < span.index + spanLen) return true;
      if (activeInSelector && ss && i >= ss.selectorIndex && i <= ssSelEnd) return true;
      if (activeInSatellite && ss && i >= ss.satelliteIndex && i <= ssSatEnd) return true;
      return false;
    };
    if (hasDimCap && this.configLoader) {
      const navigable = this.configLoader.navigableWords;
      for (const w of words) {
        if (w.index === activeIndex) continue;
        if (isInsideActiveBlock(w.index)) continue;
        const lc = w.word.toLowerCase().replace(/[\u200B\u200C]/g, '');
        if (lc.length === 0) continue;
        // Step 21: DynDefs entries (LLM-resolved alts) also count as
        // navigable, so they should dim too.
        if (
          navigable.has(lc) ||
          this.configLoader.matchStepPattern(w.word) ||
          this.dynDefs.getValid(w.index, w.word)
        ) {
          dimRanges.push({ start: w.start, end: w.end });
        }
      }
    }

    // Step 32 / Phase F.a — when a span fill is active, treat the whole
    // span as one block. If the active highlight isn't inside it, dim
    // the whole span. If it IS inside, the highlight (below) covers it
    // and we skip the dim layer (avoid stacking attributes).
    if (hasDimCap && span && !activeInSpanRegion) {
      const startWord = words[span.index];
      const endWord = words[span.index + spanLen - 1];
      if (startWord && endWord) {
        dimRanges.push({ start: startWord.start, end: endWord.end });
      }
    }

    // Phase G.b — selector + satellite dim. Both sides can be multi-word
    // ("display mode" / "plain text"). Each side gets its own dim layer.
    if (hasDimCap && ss) {
      const ss0 = words[ss.selectorIndex];
      const ss1 = words[ssSelEnd];
      const ts = words[ss.satelliteIndex];
      const te = words[ssSatEnd];
      if (ss0 && ss1 && !activeInSelector) dimRanges.push({ start: ss0.start, end: ss1.end });
      if (ts && te && !activeInSatellite) dimRanges.push({ start: ts.start, end: te.end });
    }

    // Highlight: the active word (overlaid). When the active word is
    // inside a span fill OR a multi-word satellite, expand the
    // highlight to cover the whole unit — that's how the user sees a
    // multi-word value as one cycleable thing.
    let highlight: { start: number; end: number } | undefined;
    if (hasHighlightCap && this.hlState.active && this.hlState.wordIndex !== null) {
      if (activeInSpanRegion && span) {
        const startWord = words[span.index];
        const endWord = words[span.index + spanLen - 1];
        if (startWord && endWord) {
          highlight = { start: startWord.start, end: endWord.end };
        }
      } else if (activeInSelector && ss) {
        const s0 = words[ss.selectorIndex];
        const s1 = words[ssSelEnd];
        if (s0 && s1) highlight = { start: s0.start, end: s1.end };
      } else if (activeInSatellite && ss) {
        const ts = words[ss.satelliteIndex];
        const te = words[ssSatEnd];
        if (ts && te) {
          highlight = { start: ts.start, end: te.end };
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
