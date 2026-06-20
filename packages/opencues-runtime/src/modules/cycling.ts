// Cycling module — static-alt rotation + blank-aware paths
// (selector/satellite, span-fill, list blank, blank-step).
//
// Ctrl+Alt+Up/Down dispatches based on what kind of word is highlighted:
//
//   1. List blank (e.g. affirmations): rotate through stepValues in-place.
//   2. Blank-fill DynDef: cycle the originating blank's stepped value.
//   3. Plain cue word: rotate through cueMap.alternatives.
//
// Each path updates DynDefs as needed so subsequent cycles continue from
// the right state.

import type { HostAdapter, KeyEvent, ProcessHandle, Unsubscribe } from '../adapter';
import type { HighlightState } from '../state/highlight-state';
import { DynDefs, type WordDef } from '../state/dyn-defs';
import type { ConfigLoader, BlankEntry } from './config-loader';
import { splitWords } from './navigation';
import { resolveNavKeymap } from './nav-keymap';
import type { SpanFillState } from '../state/span-fill';
import type { DismissedBlanks } from '../state/dismissed-blanks';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import { isProviderValueCyclable, getProvider } from '@opencues/core';

/** Sentence-cue defs cycle over a SENTENCE whose char span (spanStart/
 *  spanEnd) is the source of truth — whitespace words don't bound it in
 *  spaceless/mixed CJK. Only these use the def char span for the cycle
 *  splice; normal multi-word blanks keep the live word-derived range
 *  (their stored span can drift). Mirrors DimRender's `isSentenceCueDef`. */
function isSentenceCueDef(def: { blankName?: string }): boolean {
  return typeof def.blankName === 'string' && def.blankName.startsWith('sentence-cue:');
}

/** Settings whose values are LLM provider ids — cycling on these
 *  filters out values whose env key isn't set so the user can't
 *  commit a broken (provider, no-key) pair via Ctrl+Alt+Up. Mirrors
 *  the chrome popup's pre-filtered dropdown. */
const PROVIDER_SCALARS: ReadonlySet<string> = new Set([
  'llm-provider',
  'cues-llm-provider',
  'auditors-llm-provider',
  'blanks-llm-provider',
]);

/**
 * Returns the sibling `*-llm-model` scalar name when `setting` is a
 * `*-llm-provider` scalar; null otherwise. Used by the satellite-cycle
 * code to reset the model whenever the provider changes, keeping the
 * (provider, model) pair valid by construction.
 */
function providerScalarToModelScalar(setting: string): string | null {
  // Only the three bucket providers carry a paired model scalar today.
  // Global `llm-provider:` does NOT — its sibling `llm-model:` is a
  // power-user file edit and we don't auto-clear it on cycle.
  const m = setting.match(/^(cues|auditors|blanks)-llm-provider$/);
  return m ? `${m[1]}-llm-model` : null;
}

export class Cycling {
  private _unsubUp: Unsubscribe | null = null;
  private _unsubDown: Unsubscribe | null = null;
  private _unsubUpShift: Unsubscribe | null = null;
  private _unsubDownShift: Unsubscribe | null = null;

  constructor(
    private adapter: HostAdapter,
    private hlState: HighlightState,
    private dynDefs: DynDefs,
    private configLoader: ConfigLoader,
    private spanFillState?: SpanFillState,
    private dismissedBlanks?: DismissedBlanks,
    private selectorSatelliteState?: SelectorSatelliteState,
    /** Resolves the API-key bag the host gathered at boot. Cycling
     *  uses this to FILTER llm-provider satellite values so the menu
     *  never advances to a value the runtime can't dispatch with —
     *  the "test before you switch" property the chrome popup enforces
     *  natively. Omit to disable filtering (back-compat default; the
     *  cycling menu then matches its pre-June-2026 behaviour of
     *  cycling blindly through every registry-declared value). */
    private getApiKeys?: () => Readonly<Record<string, string | undefined>>,
    /** Optional probe for `transport: 'cli'` providers (claude-code-cli,
     *  openai-subscription) — true iff the CLI binary is on PATH. */
    private isCliProviderAvailable?: (providerId: string) => boolean,
  ) {}

  /** Filter a setting's value list to those eligible for cycling
   *  given the current env. Today only `*-llm-provider` scalars are
   *  filtered; everything else passes through unchanged. */
  private eligibleValues(scalar: string, values: readonly string[]): readonly string[] {
    if (!PROVIDER_SCALARS.has(scalar)) return values;
    if (!this.getApiKeys) return values;
    const apiKeys = this.getApiKeys();
    const filtered = values.filter(v =>
      isProviderValueCyclable(v, apiKeys, { isCliAvailable: this.isCliProviderAvailable }),
    );
    // Safety: never collapse the list to empty. If the user has zero
    // keys + zero CLI providers wired up, fall back to the unfiltered
    // list so the cycle still steps SOMEWHERE — the runtime then
    // surfaces the resulting LLM-call failure inline rather than
    // freezing the menu.
    return filtered.length > 0 ? filtered : values;
  }

  /**
   * Try host-native blank invocation first; fall back to spawning
   * the configured script. Sandboxed hosts (Chrome) implement
   * blankInvoke; CLI hosts (OpenCode, CC) typically don't and rely
   * on the spawn path. Returns null when neither path is viable
   * (no blankInvoke + no spawn capability + no scriptPath).
   */
  private invokeOrSpawn(
    blankName: string,
    action: string,
    args: readonly string[],
    scriptPath: string | undefined,
    options: { detached?: boolean; timeoutMs?: number } = {},
  ): ProcessHandle | null {
    const native = this.adapter.blankInvoke?.({
      blankName,
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
    // See navigation.ts for the design rationale — both combos are
    // subscribed so the OPENCUES.md `nav-keymap` scalar hot-reloads;
    // chrome skips ctrl-shift because the browser owns "extend
    // selection by word" on that combo.
    this._unsubUp = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['up'] },
      e => this.matchesKeymap('ctrl-alt') ? this.step(e, +1) : false,
    );
    this._unsubDown = this.adapter.onKey(
      { requireModifiers: ['ctrl', 'alt'], keys: ['down'] },
      e => this.matchesKeymap('ctrl-alt') ? this.step(e, -1) : false,
    );
    if (this.adapter.hostName !== 'chrome') {
      this._unsubUpShift = this.adapter.onKey(
        { requireModifiers: ['ctrl', 'shift'], keys: ['up'] },
        e => this.matchesKeymap('ctrl-shift') ? this.step(e, +1) : false,
      );
      this._unsubDownShift = this.adapter.onKey(
        { requireModifiers: ['ctrl', 'shift'], keys: ['down'] },
        e => this.matchesKeymap('ctrl-shift') ? this.step(e, -1) : false,
      );
    }
  }

  unsubscribe(): void {
    if (this._unsubUp) { this._unsubUp(); this._unsubUp = null; }
    if (this._unsubDown) { this._unsubDown(); this._unsubDown = null; }
    if (this._unsubUpShift) { this._unsubUpShift(); this._unsubUpShift = null; }
    if (this._unsubDownShift) { this._unsubDownShift(); this._unsubDownShift = null; }
  }

  private matchesKeymap(combo: 'ctrl-alt' | 'ctrl-shift'): boolean {
    const configured = this.configLoader.opencuesState.navKeymap ?? 'auto';
    return resolveNavKeymap(configured, this.adapter.hostName) === combo;
  }

  /** Exposed for unit testing — direction is +1 (up, forward) / -1 (down, back). */
  step(event: KeyEvent, direction: 1 | -1): boolean {
    if (!this.hlState.active || this.hlState.wordIndex === null) return false;
    const wordIndex = this.hlState.wordIndex;

    const words = splitWords(event.text);
    const target = words[wordIndex];
    if (!target) return false;

    // -1. Selector / satellite — opencues "settings" pattern.
    //     Highlight on selector cycles setting names; on satellite
    //     cycles values. Both write back via the blank's blankScript.
    if (this.selectorSatelliteState?.current && this.cycleSelectorSatellite(event, words, wordIndex, direction)) {
      return true;
    }

    // 0. Span fill — takes precedence when the highlight falls within
    //    a consume-all span (prompt improver) or a multi-word stepValues
    //    span (affirmations). Cycles through the stashed alts.
    if (this.spanFillState?.current && this.cycleSpanFill(event, words, wordIndex, direction)) {
      return true;
    }

    // 1. List blank (stepValues) — rotate values in-place.
    const blank = this.configLoader.lookupBlank(target.word);
    if (blank && blank.blank.stepValues && blank.blank.stepValues.length > 0) {
      return this.cycleListBlank(event, target, blank, direction, 'list-blank');
    }

    // 2. Blank-fill DynDef with blankName attribution —
    //    volume/brightness `50%` cycles via the originating blank's
    //    blankStep/Suffix/Script.
    const def = this.dynDefs.get(wordIndex);
    if (def && def.blankName) {
      const blk = this.configLoader.blanks.get(def.blankName);
      if (blk && this.cycleBlankStep(event, target, blk as BlankEntry['blank'], def.blankName, direction)) {
        return true;
      }
    }

    // 3. Plain cue word — fall through to original static-alts cycling.
    return this.cycleStaticAlts(event, target, wordIndex, direction);
  }

  // ─── Path -1: selector / satellite ──────────────────────────────────

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
      // Only cycle through settings with at least one declared `values:`.
      // Free-text settings (e.g. blank-loading-colors-rgb / -ansi —
      // a comma-separated hex/ANSI list, no enumerable options) have a
      // `tip:` but no `values:` block, so they parse as definitions with
      // an empty `valueOrder`. Including them in the selector cycle
      // breaks the satellite splice (provisionalValue = '' wipes the
      // satellite word and leaves the pair shape invalid). Skip them
      // entirely — they're edited by hand in OPENCUES.md.
      const names = Array.from(definitions.entries())
        .filter(([, def]) => def.valueOrder.length > 0)
        .map(([name]) => name);
      if (names.length === 0) return false;
      const curIdx = names.indexOf(entry.currentSetting);
      const nextIdx = ((curIdx + direction) % names.length + names.length) % names.length;
      const nextSetting = names[nextIdx];
      const nextDef = definitions.get(nextSetting);
      // Same filter as the satellite cycle: when stepping the selector
      // into a `*-llm-provider` scalar, the provisional initial value
      // must already be eligible — otherwise the cycle would silently
      // land on an unusable provider before the user has even pressed
      // satellite-cycle to step it.
      const provisionalValues = nextDef ? this.eligibleValues(nextSetting, nextDef.valueOrder) : [];
      const provisionalValue = provisionalValues[0] ?? '';

      const newText = spliceSelectorSatellite(event.text, selStartWord, selEndWord, satEndWord, nextSetting, provisionalValue, entry.separator);
      const newRegionEnd = selStartWord.start + nextSetting.length + entry.separator.length + provisionalValue.length;
      // Cycling tracks the WORD, not edit-semantic offsets. Whatever the
      // user's cursor was doing before, after a selector cycle it lands
      // at end-of-new-selector — the same word the highlight is on.
      // Anything else (preserving char offset, shifting by length delta)
      // leaks the cursor onto neighbouring words and trips cursor-navigate
      // auto-highlight. End-of-selector handles multi-word selectors too:
      // selStartWord.start + nextSetting.length is end of the last char
      // of the last selector word.
      const newCursor = Math.min(selStartWord.start + nextSetting.length, newText.length);

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

      this.adapter.emitEvent?.('cycling.cycled', {
        wordIndex,
        direction,
        path: 'selector',
        fromAltIndex: curIdx,
        toAltIndex: nextIdx,
        fromText: names[curIdx],
        toText: nextSetting,
      });
      const handle = this.invokeOrSpawn(entry.blankName, 'get', [nextSetting], entry.scriptPath, { timeoutMs: 4000 });
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
          this.adapter.log('error', `Cycling: selector get failed for ${entry.blankName}`, err);
        });
      }
      return true;
    }

    // Satellite cycle. For `*-llm-provider` scalars, drop values whose
    // env key isn't set BEFORE picking the next index — the user can't
    // commit a broken pair via Ctrl+Alt+Up. Non-provider scalars pass
    // through `eligibleValues` unchanged.
    const def = definitions.get(entry.currentSetting);
    if (!def || def.valueOrder.length === 0) return false;
    const values = this.eligibleValues(entry.currentSetting, def.valueOrder);
    // Keep currentValue's index stable even when it isn't in the
    // filtered list (e.g. user manually set `blanks-llm-provider: groq`
    // without GROQ_API_KEY → cycle Up moves to the FIRST eligible
    // value, not the next slot from groq's original index).
    const valIdx = values.indexOf(entry.currentValue);
    const baseIdx = valIdx >= 0 ? valIdx : 0;
    const startIdx = valIdx >= 0 ? baseIdx + direction : 0;
    const nextValIdx = ((startIdx) % values.length + values.length) % values.length;
    const nextValue = values[nextValIdx];

    const newText = spliceSelectorSatellite(event.text, selStartWord, selEndWord, satEndWord, entry.currentSetting, nextValue, entry.separator);
    const newRegionEnd = selStartWord.start + entry.currentSetting.length + entry.separator.length + nextValue.length;
    // Same rule as the selector branch: cycling tracks the word, so
    // cursor lands at end-of-new-satellite (= newRegionEnd, since the
    // region ends at the satellite). Stable across cycles regardless of
    // where the cursor was before — no jumping, no cursor-navigate
    // bleed onto neighbour words.
    const newCursor = Math.min(newRegionEnd, newText.length);

    entry.currentValue = nextValue;
    entry.satelliteLength = Math.max(1, nextValue.split(/\s+/).filter(Boolean).length);
    entry.pairCharEnd = newRegionEnd;
    this.selectorSatelliteState!.set(entry, newText);
    // Apply the change to opencuesState immediately so TTS / Statusline
    // see the new setting without waiting for the next hot-reload.
    this.configLoader.applyOpenCuesScalar(entry.currentSetting, nextValue);
    // Pair invariant: cycling a `*-llm-provider` makes any pinned
    // sibling `*-llm-model` ambiguous (the prior model was valid only
    // for the prior provider). Reset to the NEW provider's defaultModel
    // — keeps (provider, model) valid by construction. Previously wrote
    // the literal sentinel `default` here; that was equivalent at
    // dispatch time but tripped doctor's "inert sentinel" warning and
    // confused users reading OPENCUES.md. Writing the resolved name
    // is explicit and matches what `displayValue` already shows below.
    const siblingModelScalar = providerScalarToModelScalar(entry.currentSetting);
    const siblingDefaultModel = siblingModelScalar
      ? (getProvider(nextValue)?.defaultModel ?? 'default')
      : null;
    if (siblingModelScalar && siblingDefaultModel) {
      this.configLoader.applyOpenCuesScalar(siblingModelScalar, siblingDefaultModel);
    }
    this.adapter.setText(newText);
    this.adapter.setCursorOffset(newCursor);
    this.adapter.forceRender();

    this.adapter.log('debug', `Cycling: satellite set ${entry.blankName}`, {
      script: entry.scriptPath, setting: entry.currentSetting, value: nextValue,
    });
    try {
      const handle = this.invokeOrSpawn(
        entry.blankName,
        'set',
        [entry.currentSetting, nextValue],
        entry.scriptPath,
        { detached: true, timeoutMs: 4000 },
      );
      // Fire the sibling write through the same blank-invoke path so
      // OPENCUES.md persists the model reset.
      if (siblingModelScalar && siblingDefaultModel) {
        this.invokeOrSpawn(
          entry.blankName,
          'set',
          [siblingModelScalar, siblingDefaultModel],
          entry.scriptPath,
          { detached: true, timeoutMs: 4000 },
        );
      }
      if (!handle) {
        this.adapter.log('debug', `Cycling: satellite set SKIPPED ${entry.blankName}`, {
          hasScriptPath: !!entry.scriptPath,
          hasSpawnCap: this.adapter.capabilities.includes('spawn-process'),
          hasBlankInvoke: !!this.adapter.blankInvoke,
        });
      }
    } catch (err) {
      this.adapter.log('error', `Cycling: satellite set failed for ${entry.blankName}`, err);
    }
    this.adapter.emitEvent?.('cycling.cycled', {
      wordIndex,
      direction,
      path: 'satellite',
      fromAltIndex: valIdx,
      toAltIndex: nextValIdx,
      fromText: def.valueOrder[valIdx],
      toText: nextValue,
    });
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
    const fromAltIndex = entry.currentAltIndex;
    const nextIdx = ((entry.currentAltIndex + direction) % len + len) % len;
    const nextAlt = entry.alternatives[nextIdx];
    const fromAlt = entry.alternatives[fromAltIndex];

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
    // later fallthrough to Path 3 (static-alts) — e.g. after the span
    // clears due to user edit — doesn't splice at stale spanStart /
    // spanEnd from the last multi-word replacement.
    const def = this.dynDefs.get(entry.index);
    if (def) {
      def.currentIndex = nextIdx;
      def.spanStart = spanStartWord.start;
      def.spanEnd = spanStartWord.start + nextAlt.length;
    }

    // If the user just cycled to `_`, mark the slot as
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
    this.adapter.emitEvent?.('cycling.cycled', {
      wordIndex,
      direction,
      path: 'span-fill',
      fromAltIndex,
      toAltIndex: nextIdx,
      fromText: fromAlt,
      toText: nextAlt,
    });
    return true;
  }

  // ─── Path 1: list blank (stepValues) ─────────────────────────────────

  private cycleListBlank(
    event: KeyEvent,
    target: { word: string; start: number; end: number; index: number },
    entry: BlankEntry,
    direction: 1 | -1,
    path: 'list-blank',
  ): boolean {
    const values = entry.blank.stepValues!;
    let def = this.dynDefs.get(target.index);
    if (!def) {
      // Build def from the blank's stepValues. Index 0 = current word OR
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
    return this.applyAltCycle(event, def, direction, target.index, path);
  }

  // ─── Path 2: blank-fill DynDef route (volume / brightness) ───────────

  private cycleBlankStep(
    event: KeyEvent,
    target: { word: string; start: number; end: number; index: number },
    blank: { blankStep?: number; blankSuffix?: string; blankScript?: string },
    blankName: string,
    direction: 1 | -1,
  ): boolean {
    if (blank.blankStep === undefined) return false;
    const suffix = blank.blankSuffix ?? '';
    const cleanWord = target.word.replace(/[\u200B\u200C]/g, '');
    const numStr = suffix && cleanWord.endsWith(suffix)
      ? cleanWord.slice(0, cleanWord.length - suffix.length)
      : cleanWord;
    const cur = parseFloat(numStr);
    if (Number.isNaN(cur)) return false;
    let next = cur + direction * blank.blankStep;
    // Clamp to 0..100 by default for percentage-style blanks.
    if (next < 0) next = 0;
    if (next > 100) next = 100;
    const decimals = (blank.blankStep.toString().split('.')[1] ?? '').length;
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

    // Sync spanFillState.lastFilledText to the new buffer BEFORE setText —
    // otherwise BlankFill._onTextChangeImpl sees the cycle output as a
    // user edit inside the clear-on-edit span and wipes everything.
    // Mirrors what cycleSpanFill does at the equivalent point.
    const spanEntry = this.spanFillState?.current;
    if (spanEntry && spanEntry.index === target.index) {
      this.spanFillState!.set(spanEntry, newText);
    }

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(clampedCursor);
    this.adapter.forceRender();

    // Write back via script set <num> (no suffix — script expects raw
    // number). Sandboxed hosts route through blankInvoke; CLI hosts
    // spawn the configured blankScript.
    const home = process.env.HOME ?? '~';
    const scriptPath = blank.blankScript?.startsWith('~')
      ? home + blank.blankScript.slice(1)
      : blank.blankScript;
    try {
      this.invokeOrSpawn(blankName, 'set', [formatted], scriptPath, { detached: true, timeoutMs: 4000 });
    } catch (err) {
      this.adapter.log('error', `Cycling: blankScript set failed for ${blankName}`, err);
    }
    this.adapter.emitEvent?.('cycling.cycled', {
      wordIndex: target.index,
      direction,
      path: 'blank-step',
      fromText: target.word,
      toText: nextWord,
    });
    return true;
  }

  // ─── Path 3: plain cue word (static-alt rotation) ──────────────────────

  private cycleStaticAlts(
    event: KeyEvent,
    target: { word: string; start: number; end: number; index: number },
    wordIndex: number,
    direction: 1 | -1,
  ): boolean {
    // Inner-span redirect: if this index is inside a multi-word
    // static-alt span (not the origin), cycle the origin instead so
    // the whole span rotates as one unit. Mirrors what cycleSpanFill
    // does for blank-fills. Pass `words` so sentence-cue spans are
    // bounded by their CHAR span, not the overshooting alt word-count —
    // otherwise a later CJK sentence's origin is mistaken for an inner
    // word of the prior sentence and cycling it wrongly rotates the
    // PRIOR sentence (the buffer's word-count > char-bounded span in CJK).
    const words = splitWords(event.text);
    const span = this.dynDefs.findSpanContaining(wordIndex, words);
    if (span && span.originIdx !== wordIndex) {
      const origin = words[span.originIdx];
      if (origin) {
        return this.cycleStaticAlts(event, {
          word: origin.word, start: origin.start, end: origin.end, index: span.originIdx,
        }, span.originIdx, direction);
      }
    }

    let def = this.dynDefs.get(wordIndex);
    if (!def) {
      const built = this.buildDefFrom(target);
      if (!built) return false;
      this.dynDefs.set(wordIndex, built);
      def = built;
    }
    if (def.alternatives.length <= 1) return false;
    return this.applyAltCycle(event, def, direction, wordIndex, 'static-alts');
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

  private applyAltCycle(event: KeyEvent, def: WordDef, direction: 1 | -1, wordIndex: number, path: 'static-alts' | 'list-blank'): boolean {
    const len = def.alternatives.length;
    if (len <= 1) return false;

    // Compute the char range to REPLACE from live word positions, not
    // from def.spanStart/spanEnd — those can drift across multi-word
    // cycles (applyAltCycle updates them, cycleSpanFill updates them,
    // user edits don't update them), so a stale span would splice at
    // the wrong character offsets after a multi-word swap.
    //
    // Blank-fills compute their range fresh each cycle (cycleSpanFill
    // reads words[entry.index..entry.index+spanLen-1] on every call).
    // Same pattern here — one source of truth is the live words array.
    const words = splitWords(event.text);
    const startWord = words[wordIndex];
    if (!startWord) return false;
    let rangeStart: number;
    let rangeEnd: number;
    if (isSentenceCueDef(def) && def.spanEnd > def.spanStart) {
      // CJK / sentence-cue: whitespace words don't bound the sentence —
      // a spaceless Japanese buffer is ONE giant word, so the word-derived
      // range would replace the WHOLE buffer and wipe every other sentence
      // on cycle. The def's char span IS the sentence; use it. Sentence-cues
      // are passive + re-resolved on edit (and this cycle keeps spanStart/
      // spanEnd current below), so the span doesn't go stale the way a
      // normal blank's can.
      rangeStart = def.spanStart;
      rangeEnd = def.spanEnd;
    } else {
      const currentAlt = def.alternatives[def.currentIndex] ?? '';
      const currentAltWordCount = Math.max(1, currentAlt.split(/\s+/).filter(Boolean).length);
      const endWord = words[wordIndex + currentAltWordCount - 1] ?? startWord;
      rangeStart = startWord.start;
      rangeEnd = endWord.end;
    }

    // Advance the cycle AFTER we've captured the current range.
    const fromAltIndex = def.currentIndex;
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

    // Keep DOWNSTREAM span-bound defs' char offsets current. A
    // length-changing splice shifts every char after `rangeEnd`; defs
    // that begin at/after it (e.g. later sentence-cues in a multi-
    // paragraph CJK buffer) would otherwise point at stale chars and
    // mis-splice on their next cycle. Sentence-cue defs are locked
    // against re-resolution, so this is the only thing that keeps them
    // honest. The just-cycled def starts at `rangeStart` (< rangeEnd) so
    // it's excluded — its own span was set above.
    if (lenDiff !== 0) this.dynDefs.shiftCharSpansAfter(rangeEnd, lenDiff);

    const cursorBefore = event.cursorOffset;
    const newCursor = cursorBefore <= rangeStart
      ? cursorBefore
      : cursorBefore >= rangeEnd
        ? cursorBefore + lenDiff
        : rangeStart + nextWord.length;
    const clampedCursor = Math.max(0, Math.min(newCursor, newText.length));

    // Multi-word static-alt spans live in DynDefs, NOT SpanFillState
    // (which is reserved for blank-fills — one slot at a time). The
    // span is implicit: a DynDef's currentAlt with N words occupies
    // N consecutive word positions. Navigation, DimRender, and
    // Cycling all derive span ranges via DynDefs.findSpanContaining,
    // which scales naturally to N concurrent spans.

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(clampedCursor);

    // If the cycle changed word count (single ↔ multi-word alt, or
    // multi-word ↔ multi-word with different lengths), every DynDef at
    // index > wordIndex now sits at the wrong key — the words it
    // belongs to have shifted by `delta`. SHIFT first so resolved-but-
    // unrelated words keep their dim/cycling continuity, THEN prune
    // any genuinely stale entries (e.g. defs whose word actually
    // changed).
    const prevAlt = def.alternatives[(def.currentIndex - direction + len) % len];
    const prevCount = Math.max(1, prevAlt.split(/\s+/).filter(Boolean).length);
    const newCount = Math.max(1, nextWord.split(/\s+/).filter(Boolean).length);
    const delta = newCount - prevCount;
    if (delta !== 0) {
      this.dynDefs.shiftAfter(wordIndex, delta);
      this.dynDefs.pruneStale(splitWords(newText));
    }

    this.adapter.forceRender();
    this.adapter.emitEvent?.('cycling.cycled', {
      wordIndex,
      direction,
      path,
      fromAltIndex,
      toAltIndex: def.currentIndex,
      fromText: prevAlt,
      toText: nextWord,
    });
    return true;
  }
}

/**
 * Replace selector + separator + satellite in `text` using the current
 * char positions of the two anchor words. Range replaced is
 * [selStartWord.start .. satEndWord.end].
 */
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
