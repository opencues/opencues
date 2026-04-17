// DimRender — computes RenderDirectives on every onRender event.
//
// Phase scope: paint a single highlight range covering the active word.
// Cycling spans, number dimming, consume-all, and shimmer suppression land
// in later phases as those modules ship.

import type { HostAdapter, RenderContext, RenderDirectives, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import { splitWords } from './navigation';

export class DimRender {
  private _unsub: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private _dynDefs: DynDefs,
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
    if (!this.hlState.active || this.hlState.wordIndex === null) return null;
    if (!this.adapter.capabilities.includes('highlight-range')) return null;

    const words = splitWords(ctx.text);
    const target = words[this.hlState.wordIndex];
    if (!target) return null;

    return {
      highlight: { start: target.start, end: target.end },
    };
  }
}
