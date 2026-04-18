// Cycling module — Phase 3 (static alts) + Bucket C (control-aware).
//
// Ctrl+Alt+Up/Down dispatches based on what kind of word is highlighted:
//
//   1. Script-backed control (e.g. volume): spawn the configured script
//      with upArgs/downArgs, no text mutation.
//   2. List control (e.g. affirmations): rotate through stepValues in-place.
//   3. Step-pattern numeric (e.g. "0.5f"): arithmetic increment by `step`.
//   4. Plain cue word: rotate through cueMap.alternatives (Phase 3 path).
//
// Each path updates DynDefs as needed so subsequent cycles continue from
// the right state.

import type { HostAdapter, KeyEvent, ProcessSpec, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import { DynDefs, type WordDef } from '../state/dyn-defs';
import type { ConfigLoader, ControlEntry, StepPattern } from './config-loader';
import { splitWords } from './navigation';
import type { SpanFillState } from '../state/span-fill';
import type { DismissedBlanks } from '../state/dismissed-blanks';

export class Cycling {
  private _unsubUp: Unsubscribe | null = null;
  private _unsubDown: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader: ConfigLoader,
    private spanFillState?: SpanFillState,
    private dismissedBlanks?: DismissedBlanks,
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

    const words = splitWords(event.text);
    const target = words[wordIndex];
    if (!target) return false;

    // 0. Span fill — takes precedence when the highlight falls within
    //    a consume-all span (prompt improver) or a multi-word stepValues
    //    span (affirmations). Cycles through the stashed alts.
    if (this.spanFillState?.current && this.cycleSpanFill(event, words, wordIndex, direction)) {
      return true;
    }

    // 1. Script-backed control — spawn script, no text change.
    const control = this.configLoader.lookupControl(target.word);
    if (control && control.control.script) {
      return this.runScriptControl(control, direction);
    }

    // 2. List control (stepValues) — rotate values in-place.
    if (control && control.control.stepValues && control.control.stepValues.length > 0) {
      return this.cycleListControl(event, target, control, direction);
    }

    // 3. Step-pattern numeric — arithmetic on the matched number.
    const stepMatch = this.configLoader.matchStepPattern(target.word);
    if (stepMatch) {
      return this.cycleStepPattern(event, target, stepMatch.pattern, direction);
    }

    // 4. Plain cue word — fall through to original static-alts cycling.
    return this.cycleStaticAlts(event, target, wordIndex, direction);
  }

  // ─── Path 0: span fill (consume-all + multi-word stepValues) ──────────

  private cycleSpanFill(
    event: KeyEvent,
    words: ReadonlyArray<{ word: string; start: number; end: number; index: number }>,
    wordIndex: number,
    direction: 1 | -1,
  ): boolean {
    const entry = this.spanFillState!.current!;
    const spanLen = entry.spanLength || 1;
    if (wordIndex < entry.index || wordIndex >= entry.index + spanLen) return false;

    const len = entry.alternatives.length;
    if (len <= 1) return false;
    const nextIdx = ((entry.currentAltIndex + direction) % len + len) % len;
    const nextAlt = entry.alternatives[nextIdx];

    // Span char positions: from start of the first span word to end of the
    // last span word in the *current* text. If the user edited and the
    // span moved, abort — invalidation should already have cleared this
    // state, but defend anyway.
    const spanStartWord = words[entry.index];
    const spanEndWord = words[entry.index + spanLen - 1];
    if (!spanStartWord || !spanEndWord) return false;

    const before = event.text.slice(0, spanStartWord.start);
    const after = event.text.slice(spanEndWord.end);
    const newText = before + nextAlt + after;
    const newCursor = spanStartWord.start + nextAlt.length;

    // Update stash BEFORE setText so onTextChange's invalidator sees the
    // matching lastFilledText and doesn't drop the entry.
    entry.currentAltIndex = nextIdx;
    entry.spanLength = nextAlt.split(/\s+/).filter(Boolean).length;
    this.spanFillState!.set(entry, newText);

    // Phase F.b — if the user just cycled to `_`, mark the slot as
    // dismissed so BlankFill doesn't immediately re-fill (script path)
    // or auto-populate (sync path) on the next text-change. Cycling
    // away from `_` clears the flag.
    if (this.dismissedBlanks) {
      if (nextAlt === '_') this.dismissedBlanks.add(entry.index);
      else this.dismissedBlanks.delete(entry.index);
    }

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(newCursor);
    this.adapter.forceRender();
    return true;
  }

  // ─── Path 1: script-backed ─────────────────────────────────────────────

  private runScriptControl(entry: ControlEntry, direction: 1 | -1): boolean {
    if (!this.adapter.capabilities.includes('spawn-process')) return false;
    const c = entry.control;
    const args = direction === 1 ? c.upArgs ?? [] : c.downArgs ?? [];
    const scriptPath = c.script as string;
    const spec: ProcessSpec = {
      command: 'bash',
      args: [scriptPath, ...args],
      detached: true,
    };
    try {
      this.adapter.spawnProcess(spec);
    } catch (err) {
      this.adapter.log('error', `Cycling: script spawn failed for ${entry.name}`, err);
      return false;
    }
    // No text change — but trigger a render so downstream consumers
    // (Statusline) can update timestamp / state.
    this.adapter.forceRender();
    return true;
  }

  // ─── Path 2: list control (stepValues) ─────────────────────────────────

  private cycleListControl(
    event: KeyEvent,
    target: { word: string; start: number; end: number; index: number },
    entry: ControlEntry,
    direction: 1 | -1,
  ): boolean {
    const values = entry.control.stepValues!;
    let def = this.dynDefs.get(target.index);
    if (!def) {
      // Build def from the control's stepValues. Index 0 = current word OR
      // first stepValue if current word matches a known one.
      const startIndex = Math.max(0, values.findIndex(v => v.toLowerCase() === target.word.toLowerCase()));
      def = {
        originalWord: target.word,
        alternatives: [target.word, ...values.filter(v => v !== target.word)],
        currentIndex: 0,
        spanStart: target.start,
        spanEnd: target.end,
      };
      // If current word IS one of the stepValues, currentIndex already
      // points at index 0 (the word) — alternatives[1+] are the rest.
      void startIndex;
      this.dynDefs.set(target.index, def);
    }
    return this.applyAltCycle(event, def, direction);
  }

  // ─── Path 3: step-pattern numeric ──────────────────────────────────────

  private cycleStepPattern(
    event: KeyEvent,
    target: { word: string; start: number; end: number; index: number },
    pattern: StepPattern,
    direction: 1 | -1,
  ): boolean {
    const c = pattern.control;
    const step = c.step ?? 1;
    // splitWords may include trailing ZWS noise from our re-render toggles.
    // Strip before matching so the regex anchor `$` lines up.
    const cleanWord = target.word.replace(/[\u200B\u200C]/g, '');
    const m = cleanWord.match(pattern.regex);
    if (!m) return false;
    const numStr = m[1];
    const current = Number(numStr);
    if (Number.isNaN(current)) return false;
    let next = current + direction * step;
    if (c.stepMin !== undefined && next < c.stepMin) next = c.stepMin;
    if (c.stepMax !== undefined && next > c.stepMax) next = c.stepMax;
    // Preserve decimal precision: if step is fractional, keep one decimal.
    const decimals = (step.toString().split('.')[1] ?? '').length;
    const formatted = decimals > 0 ? next.toFixed(decimals) : String(next);
    // Preserve the suffix (everything after the captured numeric portion in
    // the cleaned word — preserves ZWS in cleanWord-vs-target.word noise).
    const suffix = cleanWord.slice(numStr.length);
    const nextWord = formatted + suffix;

    const before = event.text.slice(0, target.start);
    const after = event.text.slice(target.end);
    const newText = before + nextWord + after;
    const lenDiff = nextWord.length - target.word.length;
    const newCursor = event.cursorOffset <= target.start
      ? event.cursorOffset
      : event.cursorOffset >= target.end
        ? event.cursorOffset + lenDiff
        : target.start + nextWord.length;
    const clampedCursor = Math.max(0, Math.min(newCursor, newText.length));

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(clampedCursor);
    this.adapter.forceRender();
    return true;
  }

  // ─── Path 4: plain cue word (Phase 3 behaviour) ────────────────────────

  private cycleStaticAlts(
    event: KeyEvent,
    target: { word: string; start: number; end: number; index: number },
    wordIndex: number,
    direction: 1 | -1,
  ): boolean {
    let def = this.dynDefs.get(wordIndex);
    if (!def) {
      const built = this.buildDefFrom(target);
      if (!built) return false;
      this.dynDefs.set(wordIndex, built);
      def = built;
    }
    if (def.alternatives.length <= 1) return false;
    return this.applyAltCycle(event, def, direction);
  }

  private buildDefFrom(target: { word: string; start: number; end: number; index: number }): WordDef | null {
    const lookup = this.configLoader.lookup(target.word);
    if (!lookup || !lookup.alternatives || lookup.alternatives.length === 0) return null;
    const alternatives: string[] = [target.word];
    for (const alt of lookup.alternatives) {
      if (alt !== target.word && !alternatives.includes(alt)) alternatives.push(alt);
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

  // ─── Shared alt-cycling loop ───────────────────────────────────────────

  private applyAltCycle(event: KeyEvent, def: WordDef, direction: 1 | -1): boolean {
    const len = def.alternatives.length;
    if (len <= 1) return false;
    def.currentIndex = ((def.currentIndex + direction) % len + len) % len;
    const nextWord = def.alternatives[def.currentIndex];

    const before = event.text.slice(0, def.spanStart);
    const after = event.text.slice(def.spanEnd);
    const newText = before + nextWord + after;
    const oldLen = def.spanEnd - def.spanStart;
    const lenDiff = nextWord.length - oldLen;
    def.spanEnd = def.spanStart + nextWord.length;

    const cursorBefore = event.cursorOffset;
    const newCursor = cursorBefore <= def.spanStart
      ? cursorBefore
      : cursorBefore >= def.spanEnd - lenDiff
        ? cursorBefore + lenDiff
        : def.spanEnd;
    const clampedCursor = Math.max(0, Math.min(newCursor, newText.length));

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(clampedCursor);
    this.adapter.forceRender();
    return true;
  }
}
