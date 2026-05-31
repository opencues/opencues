// Navigation module.
//
// Handles Ctrl+Alt+Left and Ctrl+Alt+Right by walking the
// whitespace-separated word list from the right-hand side and updating
// HighlightState. Cue filtering uses DynDefs + the cueMap to restrict
// targets to navigable words.

import type { HostAdapter, KeyEvent, TextChangeEvent, CursorChangeEvent, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import type { DynDefs } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import type { SpanFillState } from '../state/span-fill';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import { resolveNavKeymap } from './nav-keymap';

export interface WordSpan {
  readonly start: number;
  readonly end: number;
  readonly word: string;
  readonly index: number;
}

export class Navigation {
  private _unsubLeft: Unsubscribe | null = null;
  private _unsubRight: Unsubscribe | null = null;
  private _unsubLeftShift: Unsubscribe | null = null;
  private _unsubRightShift: Unsubscribe | null = null;
  private _unsubEscape: Unsubscribe | null = null;
  private _unsubText: Unsubscribe | null = null;
  private _unsubCursor: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    /**
     * Optional. When provided, navigation prefers cueMap-mapped words; falls
     * back to all-words when no matches. Mirrors v1's nav filter from
     * the original CC patch.
     */
    private configLoader?: ConfigLoader,
    /**
     * Optional. When a span fill is active, the inner positions of the span
     * (everything past `entry.index`) are skipped — the whole multi-word
     * fill counts as one nav stop, anchored on its origin.
     */
    private spanFillState?: SpanFillState,
    /**
     * Optional. Selector + satellite indices are forced into the nav
     * target list so the user can step onto either word even if neither
     * "voice-mode" nor "active" appears in cueMap.
     */
    private selectorSatelliteState?: SelectorSatelliteState,
  ) {}

  subscribe(): void {
    // Subscribe to both modifier combos so flipping `nav-keymap` in
    // OPENCUES.md hot-reloads without re-subscribing. Each handler
    // gates on the resolved keymap per-keystroke; the unmatched combo
    // returns false so the host's own behaviour (or nothing) takes
    // over. Chrome is exempt — ctrl-shift+arrow is the canonical
    // browser "extend selection by word" shortcut, so we don't even
    // subscribe to avoid any chance of a stray preventDefault.
    this._unsubLeft = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['left'] },
      e => this.matchesKeymap('ctrl-alt') ? this.onArrowLeft(e) : false,
    );
    this._unsubRight = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['right'] },
      e => this.matchesKeymap('ctrl-alt') ? this.onArrowRight(e) : false,
    );
    if (this.adapter.hostName !== 'chrome') {
      this._unsubLeftShift = this.adapter.onKey(
        { requireModifiers: ['ctrl', 'shift'], keys: ['left'] },
        e => this.matchesKeymap('ctrl-shift') ? this.onArrowLeft(e) : false,
      );
      this._unsubRightShift = this.adapter.onKey(
        { requireModifiers: ['ctrl', 'shift'], keys: ['right'] },
        e => this.matchesKeymap('ctrl-shift') ? this.onArrowRight(e) : false,
      );
    }
    // Escape deactivates the highlight without changing text.
    // No required modifier — bare Escape; forbidModifiers prevents
    // accidental capture during a Ctrl+Esc / Alt+Esc shortcut chord.
    this._unsubEscape = this.adapter.onKey(
      { keys: ['escape'], forbidModifiers: ['ctrl', 'alt', 'shift', 'meta'] },
      () => {
        if (!this.hlState.active) return false;
        this.hlState.deactivate();
        this.adapter.forceRender();
        return true;
      },
    );
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
    // Cursor-only events (mouse click, arrow keys) are optional — hosts
    // that can't distinguish them omit the method, in which case
    // cursor-navigate falls back to "highlight follows typing".
    if (this.adapter.onCursorChange) {
      this._unsubCursor = this.adapter.onCursorChange(e => this.onCursorChange(e));
    }
  }

  unsubscribe(): void {
    if (this._unsubLeft) { this._unsubLeft(); this._unsubLeft = null; }
    if (this._unsubRight) { this._unsubRight(); this._unsubRight = null; }
    if (this._unsubLeftShift) { this._unsubLeftShift(); this._unsubLeftShift = null; }
    if (this._unsubRightShift) { this._unsubRightShift(); this._unsubRightShift = null; }
    if (this._unsubEscape) { this._unsubEscape(); this._unsubEscape = null; }
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._unsubCursor) { this._unsubCursor(); this._unsubCursor = null; }
  }

  private matchesKeymap(combo: 'ctrl-alt' | 'ctrl-shift'): boolean {
    const configured = this.configLoader?.opencuesState.navKeymap ?? 'auto';
    return resolveNavKeymap(configured, this.adapter.hostName) === combo;
  }

  /**
   * Cursor-only move (no text change). When cursor-navigate is on,
   * update the highlight to track the new cursor position. When off,
   * no-op — manual Ctrl+Alt nav owns the highlight.
   */
  onCursorChange(event: CursorChangeEvent): void {
    if (event.source === 'runtime') return;
    if (this.configLoader?.opencuesState.cursorNavigate !== 'active') return;
    const target = this.findWordAtCursor(event.text, event.cursorOffset);
    if (target !== null) {
      this.hlState.activate(target, event.text);
    } else if (this.hlState.active) {
      this.hlState.deactivate();
    }
    this.adapter.forceRender();
  }

  /**
   * User typing (or any text change we didn't initiate) clears the
   * highlight and PRUNES stale DynDefs. "Stale" = the word(s) at the
   * def's position no longer match what cycling last produced.
   *
   * Survive pruning if one of:
   *   - word at index === def.originalWord (def is fresh, untouched)
   *   - single-word current alt === word at index (mid-cycle)
   *   - multi-word current alt — ALL N words match contiguously at
   *     [index..index+N-1]. Just matching the first word isn't enough
   *     because the def's cached char range (spanStart/spanEnd) would
   *     still point at the OLD multi-word replacement, and the next
   *     cycle would splice the wrong substring.
   *
   * Fresh defs survive, so dim/cycling keep working without the
   * 500 ms dim-flash that the old `dynDefs.clear()` caused. Stale
   * multi-word span defs get dropped cleanly when the user breaks
   * the span.
   */
  onTextChange(event: TextChangeEvent): void {
    if (event.source === 'runtime') return;
    // Task-span atomic delete: when the user edits any character of an
    // agent-task span (TASK_SHOW prompt insertion today, future task-*
    // surfaces tomorrow), the whole span deletes as a unit. Scoped via
    // `def.blankName?.startsWith('task-')`. Built-in — not a user-
    // configurable knob. Fluid-blank and transform-blank spans are NOT
    // covered; their substitutions are intended as drop-in answers the
    // user might tweak in place, so partial edits leave them alone and
    // pruneStale handles def cleanup.
    if (this.dynDefs.size > 0) {
      const edited = this.dynDefs.findEditedSpan(
        event.text,
        (def) => def.blankName?.startsWith('task-') ?? false,
      );
      if (edited !== null) {
        const newText = event.text.slice(0, edited.spanStart) + event.text.slice(edited.spanEnd);
        // Drop the def first so subsequent pruneStale doesn't double-handle.
        this.dynDefs.delete(edited.defIndex);
        this.adapter.log('info', `Navigation: task span at [${edited.spanStart},${edited.spanEnd}] was edited — deleting whole span`);
        if (this.adapter.pushText) {
          this.adapter.pushText(newText, edited.spanStart);
        } else {
          this.adapter.setText(newText);
          this.adapter.setCursorOffset(edited.spanStart);
          this.adapter.forceRender();
        }
        // Don't pruneStale — the buffer just changed; the next text
        // event (runtime-source-filtered out at the top of this method)
        // will not re-enter, and the resolver's own onTextChange will
        // re-prune on the next user keystroke.
        return;
      }
      this.dynDefs.pruneStale(splitWords(event.text));
    }
    // cursor-navigate: when ON, the highlight follows the cursor across
    // edits — find the word at the cursor and activate (or deactivate
    // when in whitespace). When OFF, fall back to the legacy "drop the
    // highlight on every edit" behaviour so manual Ctrl+Alt navigation
    // doesn't drift across keystrokes.
    if (this.configLoader?.opencuesState.cursorNavigate === 'active') {
      const target = this.findWordAtCursor(event.text, event.cursorOffset);
      if (target !== null) {
        this.hlState.activate(target, event.text);
      } else if (this.hlState.active) {
        this.hlState.deactivate();
      } else {
        // Keep hlState in sync with the latest text even when nothing
        // is highlighted (so the next Ctrl+Alt nav uses fresh text).
        this.hlState.setText(event.text);
      }
      this.adapter.forceRender();
    } else {
      if (this.hlState.active) this.hlState.deactivate();
    }
  }

  /** Pick the navigable word containing `cursorOffset`, or null. Cursor
   *  is treated as "in" a word when it's inside [start, end] inclusive
   *  (so being right next to either edge also counts). Whitespace
   *  positions return null so the highlight clears. */
  private findWordAtCursor(text: string, cursorOffset: number): number | null {
    const words = splitWords(text);
    if (words.length === 0) return null;
    const targets = this.computeTargets(words);
    if (targets.length === 0) return null;
    const targetSet = new Set<number>(targets);
    for (const w of words) {
      if (!targetSet.has(w.index)) continue;
      if (cursorOffset >= w.start && cursorOffset <= w.end) return w.index;
    }
    return null;
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
      // Ctrl+Alt+Right: step right. At rightmost (posFromRight === 0)
      // deactivate — matches CC/OC where right-past-end always
      // unselects, including the single-target case.
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
   * A word is navigable when something has an opinion about it:
   *   1. Word lowercased is in cueMap (tip-having word).
   *   2. DynDefs has an entry for that index (cycling state — LLM alts,
   *      blank-fill substitution, selector/satellite, span fill).
   *
   * No cues, no DynDefs → no navigable words → Ctrl+Alt+Left/Right does
   * nothing. Earlier we fell through to all whitespace-separated words
   * when nothing matched, but that lets users hop between plain words
   * even though Up/Down has nothing to cycle. Silence is better than
   * pointless navigation.
   *
   * Span layer: when a span fill is active, force-add the span origin
   * (so the span is always reachable even if its first word isn't in
   * cueMap), and drop any inner span positions from the result so each
   * multi-word span counts as exactly one nav stop.
   *
   * Exposed for unit testing.
   */
  computeTargets(words: readonly WordSpan[]): number[] {
    const span = this.spanFillState?.current ?? null;
    const isInsideSpan = (idx: number): boolean =>
      span !== null && idx > span.index && idx < span.index + span.spanLength;

    const baseTargets: number[] = (() => {
      // Decision tree:
      //   1. Some word matched cueMap or has a DynDef → target only those.
      //   2. cueMap is loaded + non-empty but no word in this input matches
      //      → return [] (silence). No cue source has an opinion on the
      //      word, so navigation should not hop between plain words.
      //   3. cueMap missing or empty (test scaffold / fresh install with
      //      no tips) → fall back to all words so the system isn't dead
      //      out of the box and unit tests without a wired ConfigLoader
      //      still navigate.
      const navigable = this.configLoader?.navigableWords;
      const filtered: number[] = [];
      for (const w of words) {
        // Skip inner positions of any multi-word static-alt span —
        // navigation lands only on the origin so the span behaves as
        // one unit. Same semantics as SpanFillState span handling
        // below (which handles blank-fills).
        const innerSpan = this.dynDefs.findSpanContaining(w.index);
        if (innerSpan && innerSpan.originIdx !== w.index) continue;
        const lc = w.word.toLowerCase().replace(/[\u200B\u200C]/g, '');
        if (lc.length === 0) continue;
        if (navigable?.has(lc)) {
          filtered.push(w.index);
        } else if (this.dynDefs.get(w.index)) {
          filtered.push(w.index);
        }
      }
      if (filtered.length > 0) return filtered;
      const cueMapEmpty = !navigable || navigable.size === 0;
      const noDynDefs = this.dynDefs.size === 0;
      // Production path: cueMap is populated → silence.
      // Test scaffold path: no cueMap, no DynDefs → fall back.
      if (cueMapEmpty && noDynDefs) return words.map(w => w.index);
      return [];
    })();

    // Force-include selector-start + satellite-start. Drop
    // inner words of either side (multi-word selectors like "display
    // mode" or values like "plain text" cycle as single units).
    const ss = this.selectorSatelliteState?.current ?? null;
    const withSelectorSatellite = (ins: number[]): number[] => {
      if (!ss) return ins;
      const selLen = Math.max(1, ss.selectorLength);
      const satLen = Math.max(1, ss.satelliteLength);
      const selEnd = ss.selectorIndex + selLen - 1;
      const satEnd = ss.satelliteIndex + satLen - 1;
      const isInner = (i: number): boolean =>
        (i > ss.selectorIndex && i <= selEnd) ||
        (i > ss.satelliteIndex && i <= satEnd);
      const out = ins.filter(i => !isInner(i));
      for (const idx of [ss.selectorIndex, ss.satelliteIndex]) {
        if (!out.includes(idx) && words.some(w => w.index === idx)) out.push(idx);
      }
      out.sort((a, b) => a - b);
      return out;
    };

    if (!span) return withSelectorSatellite(baseTargets);

    // Drop inner span positions; ensure origin is in the list.
    const out = baseTargets.filter(i => !isInsideSpan(i));
    const spanOriginInWords = words.some(w => w.index === span.index);
    if (spanOriginInWords && !out.includes(span.index)) {
      out.push(span.index);
      out.sort((a, b) => a - b);
    }
    return withSelectorSatellite(out);
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
