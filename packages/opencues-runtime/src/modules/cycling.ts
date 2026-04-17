// Cycling module — Phase 3.
//
// Ctrl+Alt+Up / Ctrl+Alt+Down rotate the highlighted word through its
// alternatives. Alts come from the static cue map (ConfigLoader) for now;
// later phases add LLM-driven alts via cues-core's Resolver.
//
// Flow:
//   1. On up/down, require an active highlight + a word at that index.
//   2. If DynDefs has no entry for this word yet, build one from the cue map.
//   3. Advance currentIndex, replace text, update spanEnd, adjust cursor.
//   4. adapter.setText + setCursorOffset + forceRender — the bootstrap
//      returns a rebuilt InputZone on the next dispatch boundary.

import type { HostAdapter, KeyEvent, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import { DynDefs, type WordDef } from '../state/dyn-defs';
import type { ConfigLoader } from './config-loader';
import { splitWords } from './navigation';

export class Cycling {
  private _unsubUp: Unsubscribe | null = null;
  private _unsubDown: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader: ConfigLoader,
  ) {}

  subscribe(): void {
    this._unsubUp = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['up'] },
      e => this.step(e, +1),
    );
    this._unsubDown = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['down'] },
      e => this.step(e, -1),
    );
  }

  unsubscribe(): void {
    if (this._unsubUp) { this._unsubUp(); this._unsubUp = null; }
    if (this._unsubDown) { this._unsubDown(); this._unsubDown = null; }
  }

  /** Exposed for unit testing — direction is +1 (up, forward) / -1 (down, back). */
  step(event: KeyEvent, direction: 1 | -1): boolean {
    if (!this.hlState.active || this.hlState.wordIndex === null) return false;
    const wordIndex = this.hlState.wordIndex;

    let def = this.dynDefs.get(wordIndex);
    if (!def) {
      const built = this.buildDefFrom(event.text, wordIndex);
      if (!built) return false;
      this.dynDefs.set(wordIndex, built);
      def = built;
    }

    const alts = def.alternatives;
    if (alts.length <= 1) return false;

    const len = alts.length;
    def.currentIndex = ((def.currentIndex + direction) % len + len) % len;
    const nextWord = alts[def.currentIndex];

    const before = event.text.slice(0, def.spanStart);
    const after = event.text.slice(def.spanEnd);
    const newText = before + nextWord + after;

    const oldLen = def.spanEnd - def.spanStart;
    const lenDiff = nextWord.length - oldLen;
    def.spanEnd = def.spanStart + nextWord.length;

    // Keep cursor stable if it was before the word; shift by lenDiff if after.
    const cursorBefore = event.cursorOffset;
    const newCursor = cursorBefore <= def.spanStart
      ? cursorBefore
      : cursorBefore >= def.spanEnd - lenDiff // cursor was past the old span
        ? cursorBefore + lenDiff
        : def.spanEnd; // cursor was inside → snap to end

    // Clamp against the NEW text length here — the adapter cannot do this
    // safely on hosts where bindings.getText is a stale closure (Claude Code
    // v2.1 captures the InputZone variable from a dead React invocation).
    const clampedCursor = Math.max(0, Math.min(newCursor, newText.length));

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(clampedCursor);
    this.adapter.forceRender();
    return true;
  }

  private buildDefFrom(text: string, wordIndex: number): WordDef | null {
    const words = splitWords(text);
    const target = words[wordIndex];
    if (!target) return null;

    const lookup = this.configLoader.lookup(target.word);
    if (!lookup || !lookup.alternatives || lookup.alternatives.length === 0) return null;

    // Index 0 is the original word as typed; cycling wraps through the alts.
    const alternatives: string[] = [target.word];
    for (const alt of lookup.alternatives) {
      if (alt !== target.word && !alternatives.includes(alt)) {
        alternatives.push(alt);
      }
    }
    if (alternatives.length <= 1) return null;

    return {
      originalWord: target.word,
      alternatives,
      currentIndex: 0,
      spanStart: target.start,
      spanEnd: target.end,
    };
  }
}
