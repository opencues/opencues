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

import type { HostAdapter, KeyEvent, ProcessHandle, ProcessSpec, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import { DynDefs, type WordDef } from '../state/dyn-defs';
import type { ConfigLoader, ControlEntry, StepPattern } from './config-loader';
import { splitWords } from './navigation';
import type { SpanFillState } from '../state/span-fill';
import type { DismissedBlanks } from '../state/dismissed-blanks';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import type { ControlValuesCache } from '../state/control-values';

export class Cycling {
  private _unsubUp: Unsubscribe | null = null;
  private _unsubDown: Unsubscribe | null = null;
  /** Per-control debounce timers for script up/down (50ms coalesce). */
  private _scriptTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader: ConfigLoader,
    private spanFillState?: SpanFillState,
    private dismissedBlanks?: DismissedBlanks,
    private selectorSatelliteState?: SelectorSatelliteState,
    private controlValues?: ControlValuesCache,
  ) {}

  /**
   * Try host-native control invocation first; fall back to spawning
   * the configured script. Sandboxed hosts (Chrome) implement
   * controlInvoke; CLI hosts (OpenCode, CC) typically don't and rely
   * on the spawn path. Returns null when neither path is viable
   * (no controlInvoke + no spawn capability + no scriptPath).
   */
  private invokeOrSpawn(
    controlName: string,
    action: string,
    args: readonly string[],
    scriptPath: string | undefined,
    options: { detached?: boolean; timeoutMs?: number } = {},
  ): ProcessHandle | null {
    const native = this.adapter.controlInvoke?.({
      controlName,
      action,
      args,
      timeoutMs: options.timeoutMs,
    });
    if (native) return native;
    if (!scriptPath) return null;
    if (!this.adapter.capabilities.includes('spawn-process')) return null;
    return this.adapter.spawnProcess({
      command: 'bash',
      args: [scriptPath, action, ...args],
      detached: options.detached,
      timeoutMs: options.timeoutMs,
    });
  }

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

    // -1. Selector / satellite — opencues "settings" pattern (Step 35).
    //     Highlight on selector cycles setting names; on satellite
    //     cycles values. Both write back via the control's blankScript.
    if (this.selectorSatelliteState?.current && this.cycleSelectorSatellite(event, words, wordIndex, direction)) {
      return true;
    }

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

    // 3a. Blank-fill DynDef with controlName attribution (Phase I.8) —
    //     volume/brightness `50%` cycles via the originating control's
    //     blankStep/Suffix/Script. Checked BEFORE matchStepPattern so
    //     sibling controls sharing a suffix don't ambiguously route.
    const def = this.dynDefs.get(wordIndex);
    if (def && def.controlName) {
      const ctrl = this.configLoader.controls.get(def.controlName);
      if (ctrl && this.cycleBlankStep(event, target, ctrl as ControlEntry['control'], def.controlName, direction)) {
        return true;
      }
    }

    // 3. Step-pattern numeric — arithmetic on the matched number.
    const stepMatch = this.configLoader.matchStepPattern(target.word);
    if (stepMatch) {
      return this.cycleStepPattern(event, target, stepMatch.pattern, direction);
    }

    // 4. Plain cue word — fall through to original static-alts cycling.
    return this.cycleStaticAlts(event, target, wordIndex, direction);
  }

  // ─── Path -1: selector / satellite (Step 35 / G.b) ──────────────────

  private cycleSelectorSatellite(
    event: KeyEvent,
    words: ReadonlyArray<{ word: string; start: number; end: number; index: number }>,
    wordIndex: number,
    direction: 1 | -1,
  ): boolean {
    const entry = this.selectorSatelliteState!.current!;
    const selLen = Math.max(1, entry.selectorLength);
    const satLen = Math.max(1, entry.satelliteLength);
    const selEnd = entry.selectorIndex + selLen - 1;
    const satEnd = entry.satelliteIndex + satLen - 1;
    const isSelector = wordIndex >= entry.selectorIndex && wordIndex <= selEnd;
    const isSatellite = wordIndex >= entry.satelliteIndex && wordIndex <= satEnd;
    if (!isSelector && !isSatellite) return false;

    const definitions = this.configLoader.opencuesState.definitions;
    if (definitions.size === 0) return false;

    const selStartWord = words[entry.selectorIndex];
    const selEndWord = words[selEnd];
    const satStartWord = words[entry.satelliteIndex];
    const satEndWord = words[satEnd];
    if (!selStartWord || !selEndWord || !satStartWord || !satEndWord) return false;

    if (isSelector) {
      const names = Array.from(definitions.keys());
      const curIdx = names.indexOf(entry.currentSetting);
      const nextIdx = ((curIdx + direction) % names.length + names.length) % names.length;
      const nextSetting = names[nextIdx];
      const nextDef = definitions.get(nextSetting);
      const provisionalValue = nextDef?.valueOrder[0] ?? '';

      const newText = spliceSelectorSatellite(event.text, selStartWord, selEndWord, satEndWord, nextSetting, provisionalValue, entry.separator);
      const oldRegionStart = selStartWord.start;
      const oldRegionEnd = satEndWord.end;
      const newRegionEnd = selStartWord.start + nextSetting.length + entry.separator.length + provisionalValue.length;
      const newCursor = preservedCursor(event.cursorOffset, oldRegionStart, oldRegionEnd, newRegionEnd, newText.length);

      entry.currentSetting = nextSetting;
      entry.currentValue = provisionalValue;
      entry.selectorLength = Math.max(1, nextSetting.split(/\s+/).filter(Boolean).length);
      entry.satelliteIndex = entry.selectorIndex + entry.selectorLength;
      entry.satelliteLength = Math.max(1, provisionalValue.split(/\s+/).filter(Boolean).length);
      entry.pairCharStart = selStartWord.start;
      entry.pairCharEnd = newRegionEnd;
      this.selectorSatelliteState!.set(entry, newText);
      this.adapter.setText(newText);
      this.adapter.setCursorOffset(newCursor);
      this.adapter.forceRender();

      const handle = this.invokeOrSpawn(entry.controlName, 'get', [nextSetting], entry.scriptPath, { timeoutMs: 4000 });
      if (handle) {
        handle.result.then(res => {
          if (res.exitCode !== 0 || res.timedOut) return;
          const fetched = res.stdout.split(/\n/)[0]?.trim();
          if (!fetched || fetched === provisionalValue) return;
          const cur = this.adapter.getText();
          const cleaned = cur.replace(/[\u200B\u200C]/g, '');
          const curWords = splitWords(cleaned);
          const newSatEnd = entry.satelliteIndex + Math.max(1, entry.satelliteLength) - 1;
          const ts = curWords[entry.satelliteIndex];
          const te = curWords[newSatEnd];
          if (!ts || !te) return;
          const replaced = cleaned.slice(0, ts.start) + fetched + cleaned.slice(te.end);
          entry.currentValue = fetched;
          entry.satelliteLength = Math.max(1, fetched.split(/\s+/).filter(Boolean).length);
          entry.pairCharEnd = ts.start + fetched.length;
          this.selectorSatelliteState!.set(entry, replaced);
          // Don't move the cursor — the user already moved it (or didn't)
          // synchronously; this is a background update.
          if (this.adapter.pushText) this.adapter.pushText(replaced);
          else { this.adapter.setText(replaced); this.adapter.forceRender(); }
        }).catch(err => {
          this.adapter.log('error', `Cycling: selector get failed for ${entry.controlName}`, err);
        });
      }
      return true;
    }

    // Satellite cycle.
    const def = definitions.get(entry.currentSetting);
    if (!def || def.valueOrder.length === 0) return false;
    const valIdx = def.valueOrder.indexOf(entry.currentValue);
    const nextValIdx = ((valIdx + direction) % def.valueOrder.length + def.valueOrder.length) % def.valueOrder.length;
    const nextValue = def.valueOrder[nextValIdx];

    const newText = spliceSelectorSatellite(event.text, selStartWord, selEndWord, satEndWord, entry.currentSetting, nextValue, entry.separator);
    const oldRegionStart = selStartWord.start;
    const oldRegionEnd = satEndWord.end;
    const newRegionEnd = selStartWord.start + entry.currentSetting.length + entry.separator.length + nextValue.length;
    const newCursor = preservedCursor(event.cursorOffset, oldRegionStart, oldRegionEnd, newRegionEnd, newText.length);

    entry.currentValue = nextValue;
    entry.satelliteLength = Math.max(1, nextValue.split(/\s+/).filter(Boolean).length);
    entry.pairCharEnd = newRegionEnd;
    this.selectorSatelliteState!.set(entry, newText);
    // Apply the change to opencuesState immediately so TTS / Statusline
    // see the new setting without waiting for the next hot-reload.
    this.configLoader.applyOpenCuesScalar(entry.currentSetting, nextValue);
    this.adapter.setText(newText);
    this.adapter.setCursorOffset(newCursor);
    this.adapter.forceRender();

    this.adapter.log('debug', `Cycling: satellite set ${entry.controlName}`, {
      script: entry.scriptPath, setting: entry.currentSetting, value: nextValue,
    });
    try {
      const handle = this.invokeOrSpawn(
        entry.controlName,
        'set',
        [entry.currentSetting, nextValue],
        entry.scriptPath,
        { detached: true, timeoutMs: 4000 },
      );
      if (!handle) {
        this.adapter.log('debug', `Cycling: satellite set SKIPPED ${entry.controlName}`, {
          hasScriptPath: !!entry.scriptPath,
          hasSpawnCap: this.adapter.capabilities.includes('spawn-process'),
          hasControlInvoke: !!this.adapter.controlInvoke,
        });
      }
    } catch (err) {
      this.adapter.log('error', `Cycling: satellite set failed for ${entry.controlName}`, err);
    }
    return true;
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

    // Mirror the new char range to any DynDef at the span origin so a
    // later fallthrough to Path 4 (static-alts) — e.g. after the span
    // clears due to user edit — doesn't splice at stale spanStart /
    // spanEnd from the last multi-word replacement.
    const def = this.dynDefs.get(entry.index);
    if (def) {
      def.currentIndex = nextIdx;
      def.spanStart = spanStartWord.start;
      def.spanEnd = spanStartWord.start + nextAlt.length;
    }

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
    // Hosts without spawn-process AND without controlInvoke can't drive
    // the script. Sandboxed hosts that implement controlInvoke handle
    // both the up/down and the post-fetch via their native API.
    if (!this.adapter.capabilities.includes('spawn-process') && !this.adapter.controlInvoke) return false;
    const c = entry.control;
    const args = direction === 1 ? c.upArgs ?? [] : c.downArgs ?? [];
    // First arg is the action (e.g. "up"); remainder are extra args.
    const action = args[0] ?? (direction === 1 ? 'up' : 'down');
    const restArgs = args.slice(1);
    const scriptPath = c.script as string;
    // Debounce + post-spawn fetch — mirrors v1's wordHighlight.ts:1015.
    // Holding Up key issues many key dispatches; without the debounce
    // we'd spawn a script per dispatch. After the script settles
    // (~200ms — per volume.sh / brightness.sh comments), fetch the
    // actual new value via `script get` so statusline shows the real
    // post-clamp number, not a guess.
    const existing = this._scriptTimers.get(entry.name);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._scriptTimers.delete(entry.name);
      try {
        this.invokeOrSpawn(entry.name, action, restArgs, scriptPath, { detached: true });
      } catch (err) {
        this.adapter.log('error', `Cycling: script invoke failed for ${entry.name}`, err);
        return;
      }
      // After ~200ms the OS-side change has settled — fetch new value.
      setTimeout(() => {
        if (!this.controlValues) return;
        try {
          const getHandle = this.invokeOrSpawn(entry.name, 'get', [], scriptPath, { timeoutMs: 2000 });
          if (!getHandle) return;
          getHandle.result.then(res => {
            if (res.exitCode !== 0 || res.timedOut) return;
            const value = res.stdout.split(/\n/)[0]?.trim();
            if (!value) return;
            this.controlValues!.set(entry.name, value);
            this.adapter.forceRender();
          }).catch(() => { /* swallow */ });
        } catch { /* swallow */ }
      }, 200);
    }, 50);
    this._scriptTimers.set(entry.name, timer);
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
    return this.applyAltCycle(event, def, direction, target.index);
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

  // ─── Path 3a: blank-fill DynDef route (volume / brightness) ───────────

  private cycleBlankStep(
    event: KeyEvent,
    target: { word: string; start: number; end: number; index: number },
    control: { blankStep?: number; blankSuffix?: string; blankScript?: string; stepMin?: number; stepMax?: number },
    controlName: string,
    direction: 1 | -1,
  ): boolean {
    if (control.blankStep === undefined) return false;
    const suffix = control.blankSuffix ?? '';
    const cleanWord = target.word.replace(/[\u200B\u200C]/g, '');
    const numStr = suffix && cleanWord.endsWith(suffix)
      ? cleanWord.slice(0, cleanWord.length - suffix.length)
      : cleanWord;
    const cur = parseFloat(numStr);
    if (Number.isNaN(cur)) return false;
    let next = cur + direction * control.blankStep;
    if (control.stepMin !== undefined && next < control.stepMin) next = control.stepMin;
    if (control.stepMax !== undefined && next > control.stepMax) next = control.stepMax;
    // Clamp to 0..100 by default for percentage-style controls.
    if (control.stepMin === undefined && next < 0) next = 0;
    if (control.stepMax === undefined && next > 100) next = 100;
    const decimals = (control.blankStep.toString().split('.')[1] ?? '').length;
    const formatted = decimals > 0 ? next.toFixed(decimals) : String(Math.round(next));
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

    // Update the DynDef in-place so subsequent cycles see the new value.
    const def = this.dynDefs.get(target.index);
    if (def) {
      this.dynDefs.set(target.index, {
        ...def,
        originalWord: nextWord,
        spanStart: target.start,
        spanEnd: target.start + nextWord.length,
      });
    }

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(clampedCursor);
    this.adapter.forceRender();

    // Write back via script set <num> (no suffix — script expects raw
    // number). Sandboxed hosts route through controlInvoke; CLI hosts
    // spawn the configured blankScript.
    const home = process.env.HOME ?? '~';
    const scriptPath = control.blankScript?.startsWith('~')
      ? home + control.blankScript.slice(1)
      : control.blankScript;
    try {
      this.invokeOrSpawn(controlName, 'set', [formatted], scriptPath, { detached: true, timeoutMs: 4000 });
    } catch (err) {
      this.adapter.log('error', `Cycling: blankScript set failed for ${controlName}`, err);
    }
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
    return this.applyAltCycle(event, def, direction, wordIndex);
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

  private applyAltCycle(event: KeyEvent, def: WordDef, direction: 1 | -1, wordIndex: number): boolean {
    const len = def.alternatives.length;
    if (len <= 1) return false;

    // Compute the char range to REPLACE from live word positions, not
    // from def.spanStart/spanEnd — those can drift across multi-word
    // cycles (applyAltCycle updates them, cycleSpanFill updates them,
    // user edits don't update them). Trusting them was the root cause
    // of "swapping multi-word alts repositions words incorrectly":
    // after cycling legal eagle → defendant counsel through Path 0,
    // def.spanEnd lagged, and the next cycle spliced at stale chars.
    //
    // Blank-fills have always computed their range fresh each cycle
    // (cycleSpanFill reads words[entry.index..entry.index+spanLen-1]
    // on every call). Same pattern here — one source of truth is the
    // live words array.
    const words = splitWords(event.text);
    const startWord = words[wordIndex];
    if (!startWord) return false;
    const currentAlt = def.alternatives[def.currentIndex] ?? '';
    const currentAltWordCount = Math.max(1, currentAlt.split(/\s+/).filter(Boolean).length);
    const endWord = words[wordIndex + currentAltWordCount - 1] ?? startWord;
    const rangeStart = startWord.start;
    const rangeEnd = endWord.end;

    // Advance the cycle AFTER we've captured the current range.
    def.currentIndex = ((def.currentIndex + direction) % len + len) % len;
    const nextWord = def.alternatives[def.currentIndex];

    const before = event.text.slice(0, rangeStart);
    const after = event.text.slice(rangeEnd);
    const newText = before + nextWord + after;
    const lenDiff = nextWord.length - (rangeEnd - rangeStart);

    // Refresh the cache so DimRender's other readers see current
    // positions until the next cycle recomputes.
    def.spanStart = rangeStart;
    def.spanEnd = rangeStart + nextWord.length;

    const cursorBefore = event.cursorOffset;
    const newCursor = cursorBefore <= rangeStart
      ? cursorBefore
      : cursorBefore >= rangeEnd
        ? cursorBefore + lenDiff
        : rangeStart + nextWord.length;
    const clampedCursor = Math.max(0, Math.min(newCursor, newText.length));

    // Register / clear the span. Multi-word alts live in SpanFillState
    // so Navigation skips inner positions, DimRender groups them, and
    // the next cycle routes through Path 0. Cycling back to a single-
    // word alt clears the span. Same semantics as blanks.
    if (this.spanFillState) {
      const spanLength = nextWord.split(/\s+/).filter(Boolean).length;
      if (spanLength > 1) {
        this.spanFillState.set({
          kind: 'static-alt',
          index: wordIndex,
          alternatives: def.alternatives,
          currentAltIndex: def.currentIndex,
          spanLength,
        }, newText);
      } else if (this.spanFillState.current?.index === wordIndex) {
        this.spanFillState.clear();
      }
    }

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(clampedCursor);

    // If the cycle changed word count (single ↔ multi-word alt, or
    // multi-word ↔ multi-word with different lengths), every DynDef at
    // index > wordIndex now points at the WRONG word. Prune them so
    // the next cycle / render doesn't splice against stale positions.
    // Navigation.onTextChange skips runtime-source events, so this
    // can't piggyback on that — we prune explicitly here.
    const prevAlt = def.alternatives[(def.currentIndex - direction + len) % len];
    const prevCount = Math.max(1, prevAlt.split(/\s+/).filter(Boolean).length);
    const newCount = Math.max(1, nextWord.split(/\s+/).filter(Boolean).length);
    if (prevCount !== newCount) {
      this.dynDefs.pruneStale(splitWords(newText));
    }

    this.adapter.forceRender();
    return true;
  }
}

/**
 * Replace selector + separator + satellite in `text` using the current
 * char positions of the two anchor words. Cleaner than a 5-arg slice
 * call in two places.
 */
/**
 * Cursor placement after a region [oldStart..oldEnd] in `oldText` is
 * replaced with content ending at `newEnd` in `newText`:
 *
 *   - cursor before oldStart → unchanged.
 *   - cursor past oldEnd → shifted by lenDiff so it stays at the same
 *     "position relative to the right side".
 *   - cursor inside [oldStart..oldEnd] → snapped to newEnd (end of the
 *     replaced region in the new text).
 */
function preservedCursor(
  oldCursor: number,
  oldStart: number,
  oldEnd: number,
  newEnd: number,
  newTextLength: number,
): number {
  let result: number;
  if (oldCursor <= oldStart) result = oldCursor;
  else if (oldCursor >= oldEnd) result = oldCursor + (newEnd - oldEnd);
  else result = newEnd;
  return Math.max(0, Math.min(result, newTextLength));
}

function spliceSelectorSatellite(
  text: string,
  selStartWord: { start: number; end: number },
  selEndWord: { start: number; end: number },
  satEndWord: { start: number; end: number },
  newSelector: string,
  newSatellite: string,
  separator: string,
): string {
  void selEndWord; // signature consistency; range is [selStartWord.start..satEndWord.end]
  return text.slice(0, selStartWord.start)
    + newSelector
    + separator
    + newSatellite
    + text.slice(satEndWord.end);
}
