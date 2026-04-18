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
import type { ConsumeAllState } from '../state/consume-all';
import { splitWords } from './navigation';

export class DimRender {
  private _unsub: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private _dynDefs: DynDefs,
    private configLoader?: ConfigLoader,
    private consumeAllState?: ConsumeAllState,
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

    // Step 32 — dim the consume-all span as a single block so the user
    // sees the whole filled chunk is cycleable. Skip the active word
    // (highlight overlay wins). One contiguous range per gap so the
    // host can render through punctuation between words.
    if (hasDimCap && this.consumeAllState?.current) {
      const entry = this.consumeAllState.current;
      const spanLen = entry.spanLength || 1;
      const startWord = words[entry.index];
      const endWord = words[entry.index + spanLen - 1];
      if (startWord && endWord) {
        if (activeIndex !== null && activeIndex >= entry.index && activeIndex < entry.index + spanLen) {
          // Active word splits the span into up to two pieces.
          const active = words[activeIndex];
          if (active && active.start > startWord.start) {
            dimRanges.push({ start: startWord.start, end: active.start });
          }
          if (active && active.end < endWord.end) {
            dimRanges.push({ start: active.end, end: endWord.end });
          }
        } else {
          dimRanges.push({ start: startWord.start, end: endWord.end });
        }
      }
    }

    // Highlight: the active word (overlaid).
    let highlight: { start: number; end: number } | undefined;
    if (hasHighlightCap && this.hlState.active && this.hlState.wordIndex !== null) {
      const target = words[this.hlState.wordIndex];
      if (target) {
        highlight = { start: target.start, end: target.end };
      }
    }

    if (!highlight && dimRanges.length === 0) return null;
    return { highlight, dimRanges };
  }
}
