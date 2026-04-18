// Navigation module — Phase 1.
//
// Ported from the v1 patch (wordHighlight.ts:461/475). Handles Ctrl+Alt+Left
// and Ctrl+Alt+Right by walking the whitespace-separated word list from the
// right-hand side and updating HighlightState.
//
// Phase 1 does NOT implement cue filtering (globalThis._isCueControl,
// globalThis._localCueMap etc.). Navigation targets all non-empty words. Cue
// filtering returns in a later phase once DynDefs is populated.

import type { HostAdapter, KeyEvent, TextChangeEvent, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';

export interface WordSpan {
  readonly start: number;
  readonly end: number;
  readonly word: string;
  readonly index: number;
}

export class Navigation {
  private _unsubLeft: Unsubscribe | null = null;
  private _unsubRight: Unsubscribe | null = null;
  private _unsubText: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    /**
     * Optional. When provided, navigation prefers cueMap-mapped words; falls
     * back to all-words when no matches. Mirrors v1's nav filter from
     * wordHighlight.ts:461.
     */
    private configLoader?: ConfigLoader,
    /**
     * Optional. When a span fill is active, the inner positions of the span
     * (everything past `entry.index`) are skipped — the whole multi-word
     * fill counts as one nav stop, anchored on its origin.
     */
    private spanFillState?: SpanFillState,
  ) {}

  subscribe(): void {
    this._unsubLeft = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['left'] },
      e => this.onArrowLeft(e),
    );
    this._unsubRight = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['right'] },
      e => this.onArrowRight(e),
    );
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
  }

  unsubscribe(): void {
    if (this._unsubLeft) { this._unsubLeft(); this._unsubLeft = null; }
    if (this._unsubRight) { this._unsubRight(); this._unsubRight = null; }
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
  }

  /**
   * User typing (or any text change we didn't initiate) clears the highlight
   * and any cycling state. Otherwise the highlight visually drifts onto an
   * unrelated word as the buffer mutates underneath.
   */
  onTextChange(event: TextChangeEvent): void {
    if (event.source === 'runtime') return;
    if (!this.hlState.active && this.dynDefs.size === 0) return;
    this.hlState.deactivate();
    this.dynDefs.clear();
  }

  onArrowLeft(event: KeyEvent): boolean {
    return this.step(event.text, +1);
  }

  onArrowRight(event: KeyEvent): boolean {
    return this.step(event.text, -1);
  }

  /**
   * Step direction: +1 is "to the left" in the v1 patch convention (Ctrl+Alt+Left),
   * −1 is "to the right" (Ctrl+Alt+Right). The v1 patch indexes from the
   * rightmost word; we follow that to keep UX identical.
   */
  private step(text: string, direction: 1 | -1): boolean {
    const words = splitWords(text);
    const targets = this.computeTargets(words);
    if (targets.length === 0) return false;

    if (!this.hlState.active) {
      // First nav: activate on the rightmost target.
      this.hlState.activate(targets[targets.length - 1], text);
      this.adapter.forceRender();
      return true;
    }

    this.hlState.setText(text);
    const current = this.hlState.wordIndex;
    const pos = current === null ? -1 : targets.indexOf(current);
    // "position from the right" — matches v1's index-from-right walk.
    const posFromRight = pos === -1 ? 0 : (targets.length - 1 - pos);

    if (direction === 1) {
      // Ctrl+Alt+Left: step left (higher posFromRight). No wrap.
      const nextPosFromRight = Math.min(posFromRight + 1, targets.length - 1);
      this.hlState.setWordIndex(targets[targets.length - 1 - nextPosFromRight]);
    } else {
      // Ctrl+Alt+Right: step right. If at rightmost (posFromRight === 0), deactivate.
      if (posFromRight === 0) {
        this.hlState.deactivate();
      } else {
        const nextPosFromRight = posFromRight - 1;
        this.hlState.setWordIndex(targets[targets.length - 1 - nextPosFromRight]);
      }
    }
    this.adapter.forceRender();
    return true;
  }

  /**
   * Decide which word indices should be navigable.
   *
   * Priority filter (mirrors v1 wordHighlight.ts:461):
   *   1. Word lowercased is in cueMap (tip-having words).
   *   2. DynDefs has an entry for that index (cycling state).
   *   3. Step-pattern match (e.g. "0.5f").
   * Fallback: all whitespace-separated words.
   *
   * Step 33 layer: when a span fill is active, also force-add the span
   * origin (so the span is always reachable even if its first word
   * isn't in cueMap), and drop any inner span positions from the
   * result so each multi-word span counts as exactly one nav stop.
   *
   * Exposed for unit testing.
   */
  computeTargets(words: readonly WordSpan[]): number[] {
    const span = this.spanFillState?.current ?? null;
    const isInsideSpan = (idx: number): boolean =>
      span !== null && idx > span.index && idx < span.index + span.spanLength;

    const baseTargets: number[] = (() => {
      if (!this.configLoader && this.dynDefs.size === 0) {
        return words.map(w => w.index);
      }
      const navigable = this.configLoader?.navigableWords;
      const filtered: number[] = [];
      for (const w of words) {
        const lc = w.word.toLowerCase().replace(/[\u200B\u200C]/g, '');
        if (lc.length === 0) continue;
        if (navigable?.has(lc)) {
          filtered.push(w.index);
        } else if (this.dynDefs.get(w.index)) {
          filtered.push(w.index);
        } else if (this.configLoader?.matchStepPattern(w.word)) {
          filtered.push(w.index);
        }
      }
      if (filtered.length > 0) return filtered;
      return words.map(w => w.index);
    })();

    if (!span) return baseTargets;

    // Drop inner span positions; ensure origin is in the list.
    const out = baseTargets.filter(i => !isInsideSpan(i));
    const spanOriginInWords = words.some(w => w.index === span.index);
    if (spanOriginInWords && !out.includes(span.index)) {
      out.push(span.index);
      out.sort((a, b) => a - b);
    }
    return out;
  }
}

/** Whitespace-split word spans with byte offsets. */
export function splitWords(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, word: m[0], index });
    index += 1;
  }
  return spans;
}
