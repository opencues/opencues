// BlankFill — Phase E foundation (Step 23).
//
// Scans the input text on every change for `_` placeholders. For each `_`,
// walks backward word-by-word looking for a match against any control's
// blankKeywords (single or multi-word). When matched, records a BlankSlot
// with the control name + match positions for downstream consumers
// (auto-populate, blank-script fetch, span tracking, dismiss, etc.).
//
// This module is detection-only in E.1. Auto-fill behaviours come in E.2+.

import type { HostAdapter, KeyEvent, TextChangeEvent, Unsubscribe } from '../adapter';
import type { ConfigLoader } from './config-loader';
import { splitWords } from './navigation';
import type { ConsumeAllState } from '../state/consume-all';

export interface BlankSlot {
  /** Word index of the `_`. */
  readonly index: number;
  /** Matched keyword string (lowercased, may contain spaces for multi-word). */
  readonly keyword: string;
  /** Lowercased control name. */
  readonly controlName: string;
  /** First word index of the matched keyword. */
  readonly keywordStart: number;
  /** Last word index of the matched keyword. */
  readonly keywordEnd: number;
  /** Words between keywordEnd and the `_` (0 = adjacent). */
  readonly proximity: number;
}

export class BlankFill {
  private _slots: readonly BlankSlot[] = [];
  private _unsubText: Unsubscribe | null = null;
  private _unsubKey: Unsubscribe | null = null;
  /** Dedup key (text + slot index) → in-flight script promise. */
  private _pendingScripts = new Set<string>();

  constructor(
    private adapter: HostAdapter,
    private configLoader: ConfigLoader,
    private consumeAllState?: ConsumeAllState,
  ) {}

  subscribe(): void {
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
    // Auto-populate path (Step 24): intercept the '_' key BEFORE the host
    // applies it. If the simulated insertion would create a fillable slot,
    // we fill it ourselves and consume the keystroke. Otherwise return
    // false and let the host insert '_' normally.
    this._unsubKey = this.adapter.onKey({ keys: ['_'] }, e => this.onUnderscoreKey(e));
    // Also scan immediately in case text already has blanks at boot.
    this.scan(this.adapter.getText());
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._unsubKey) { this._unsubKey(); this._unsubKey = null; }
  }

  /** Currently-detected slots (latest scan). */
  get slots(): readonly BlankSlot[] { return this._slots; }

  /** Pure scanner — exposed for unit tests. */
  scan(text: string): readonly BlankSlot[] {
    const cleanText = text.replace(/[\u200B\u200C]/g, '');
    const words = cleanText.split(/\s+/).filter(Boolean);
    const slots: BlankSlot[] = [];
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] !== '_') continue;
      const found = this.matchKeyword(words, i);
      if (found) slots.push(found);
    }
    this._slots = slots;
    return slots;
  }

  private onTextChange(e: TextChangeEvent): void {
    // Step 31 invalidation: if the consume-all stash is live and the
    // current text doesn't match what we last filled (cycle or initial),
    // the user edited it — drop the stash so a stale alt isn't spliced
    // into newly-edited text.
    if (this.consumeAllState && this.consumeAllState.current && e.text.replace(/[\u200B\u200C]/g, '') !== this.consumeAllState.lastFilledText) {
      this.consumeAllState.clear();
    }
    const slots = this.scan(e.text);
    if (e.source === 'user') {
      this.maybeRunScripts(e.text, slots);
    }
  }

  /**
   * Step 25 — for any blank slot whose control has a `blankScript` (and no
   * `stepValues`, since stepValues path was already handled by E.2's
   * onUnderscoreKey), spawn `bash <script> get <keyword>` async and splice
   * stdout into the `_` position when the call returns. The pendingScripts
   * dedupe stops repeated spawns for the same (text, slotIndex) pair.
   */
  private maybeRunScripts(text: string, slots: readonly BlankSlot[]): void {
    if (slots.length > 0) this.adapter.log('debug', `BlankFill: ${slots.length} slot(s) on text-change`, slots);
    if (!this.adapter.capabilities.includes('spawn-process')) return;

    // Pre-split words for context extraction (used for every slot).
    const cleaned = text.replace(/[\u200B\u200C]/g, '');
    const words = cleaned.split(/\s+/).filter(Boolean);
    const home = process.env.HOME ?? '~';

    for (const slot of slots) {
      const control = this.configLoader.controls.get(slot.controlName) as
        | (Record<string, unknown> & {
            stepValues?: readonly string[];
            blankScript?: string;
            blankAutoPopulate?: boolean;
            blankClearKeywords?: boolean;
            model?: string;
            apiUrl?: string;
            apiKeyEnv?: string;
            altCount?: number;
            includeOriginal?: boolean;
            prompts?: Record<string, string>;
          })
        | undefined;
      if (!control) continue;
      if (control.blankAutoPopulate === false) continue;
      // stepValues path is handled synchronously in onUnderscoreKey.
      if (Array.isArray(control.stepValues) && control.stepValues.length > 0) continue;
      const script = control.blankScript;
      if (!script || typeof script !== 'string') continue;

      const dedupKey = `${text}::${slot.index}`;
      if (this._pendingScripts.has(dedupKey)) continue;
      this._pendingScripts.add(dedupKey);

      // Context words: every word except the matched keyword span and the blank.
      // Index-based filter (vs v1's string-match) handles multi-word keywords
      // correctly — REPAIR.md / steps.md Step 26 deviation note.
      const contextWords: string[] = [];
      for (let wi = 0; wi < words.length; wi += 1) {
        if (wi >= slot.keywordStart && wi <= slot.keywordEnd) continue;
        if (wi === slot.index) continue;
        contextWords.push(words[wi]);
      }

      // Expand ~ in script path.
      const scriptPath = script.startsWith('~') ? home + script.slice(1) : script;

      // Build per-control env. Inherits process.env.
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      if (control.model) env.CUES_MODEL = control.model;
      if (control.apiUrl) env.CUES_API_URL = control.apiUrl;
      if (control.apiKeyEnv) env.CUES_API_KEY_ENV = control.apiKeyEnv;
      if (control.altCount !== undefined) env.CUES_ALT_COUNT = String(control.altCount);
      if (control.includeOriginal !== undefined) env.CUES_INCLUDE_ORIGINAL = String(control.includeOriginal);
      if (control.prompts) {
        for (const [k, v] of Object.entries(control.prompts)) {
          const envKey = 'CUES_PROMPT_' + k.toUpperCase().replace(/[^A-Z0-9]/g, '_');
          env[envKey] = String(v);
        }
      }

      this.adapter.log('debug', `BlankFill: spawn ${scriptPath} get ${slot.keyword}`, { contextWords, envExtras: extraEnvKeys(control) });
      const handle = this.adapter.spawnProcess({
        command: 'bash',
        args: [scriptPath, 'get', slot.keyword, ...contextWords],
        env,
        timeoutMs: 8000,
      });
      handle.result.then(res => {
        this._pendingScripts.delete(dedupKey);
        this.adapter.log('debug', `BlankFill: script result for ${slot.controlName}`, { exitCode: res.exitCode, timedOut: res.timedOut, stdoutLen: res.stdout?.length ?? 0, stdoutPreview: res.stdout?.slice(0, 80) });
        if (res.exitCode !== 0 || res.timedOut) return;
        const stdout = res.stdout.trim();
        if (!stdout) return;
        this.applyAsyncFill(slot, stdout);
      }).catch(err => {
        this._pendingScripts.delete(dedupKey);
        this.adapter.log('error', `BlankFill: script promise rejected for ${slot.controlName}`, err);
      });
    }
  }

  /**
   * Apply an async fill: re-read the host's text via getText, find the
   * matching `_` at the slot's word index, splice stdout in. Push via
   * adapter.pushText (calls onChange), since this runs outside any
   * dispatch.
   */
  private applyAsyncFill(slot: BlankSlot, fillValue: string): void {
    const currentText = this.adapter.getText();
    const cleaned = currentText.replace(/[\u200B\u200C]/g, '');
    const words = splitWords(cleaned);
    const target = words[slot.index];
    const control = this.configLoader.controls.get(slot.controlName) as
      | (Record<string, unknown> & {
          blankClearKeywords?: boolean;
          blankConsumeContext?: boolean;
          blankConsumeAll?: boolean;
          blankKeywordExpansions?: Record<string, string>;
        })
      | undefined;

    // Staleness guard — if the user moved on or already filled the slot,
    // drop the late callback. Applies to all three downstream paths
    // (consume-all, range-clear, char-splice).
    if (!target || target.word !== '_') return;

    // Step 30 — consume-all short-circuits the splice/expand/clear pipeline.
    // Multi-line stdout: line 1 replaces ALL text; remaining lines stash for
    // Step 31 cycling. Skip if there's nothing to fill (defensive).
    if (control?.blankConsumeAll === true) {
      const lines = fillValue.split(/\n/).map(s => s.trim()).filter(Boolean);
      this.adapter.log('debug', `BlankFill: consume-all ${slot.controlName}`, {
        altCount: lines.length,
        firstAltLen: lines[0]?.length ?? 0,
      });
      if (lines.length === 0) return;
      const newText = lines[0];
      const newCursor = newText.length;
      if (this.consumeAllState && lines.length > 1) {
        this.consumeAllState.set({
          index: 0,
          alternatives: lines,
          currentAltIndex: 0,
          spanLength: newText.split(/\s+/).filter(Boolean).length,
        }, newText);
      } else if (this.consumeAllState) {
        this.consumeAllState.clear();
      }
      if (this.adapter.pushText) {
        this.adapter.pushText(newText, newCursor);
      } else {
        this.adapter.setText(newText);
        this.adapter.setCursorOffset(newCursor);
        this.adapter.forceRender();
      }
      return;
    }

    const { clearEnd, expansion } = computeFillRange(control ?? {}, slot);
    this.adapter.log('debug', `BlankFill: applyAsyncFill ${slot.controlName}`, {
      currentTextLen: currentText.length,
      cleanedLen: cleaned.length,
      slotIndex: slot.index,
      targetWord: target.word,
      fillValueLen: fillValue.length,
      hasPushText: !!this.adapter.pushText,
      clearEnd: clearEnd ?? null,
      expansion: expansion ?? null,
    });

    const { newText, newCursor } = clearEnd !== undefined || expansion != null
      ? buildClearKeywordText(cleaned, slot, fillValue, expansion, clearEnd)
      : { newText: cleaned.slice(0, target.start) + fillValue + cleaned.slice(target.end),
          newCursor: target.start + fillValue.length };

    if (this.adapter.pushText) {
      this.adapter.pushText(newText, newCursor);
    } else {
      this.adapter.setText(newText);
      this.adapter.setCursorOffset(newCursor);
      this.adapter.forceRender();
    }
  }

  /**
   * Handler for the '_' key. Simulates the insertion that the host would
   * make, scans the result, and if a fillable slot lands at the inserted
   * position we replace '_' with the control's stepValues[0] in the same
   * dispatch. Returns true to consume the key (host's default insert is
   * skipped); false otherwise (host inserts '_' normally).
   */
  onUnderscoreKey(event: KeyEvent): boolean {
    // Only intercept plain '_' presses (no nav modifiers etc.).
    const m = event.modifiers;
    if (m.ctrl || m.alt || m.meta) return false;

    const insertedText =
      event.text.slice(0, event.cursorOffset) +
      '_' +
      event.text.slice(event.cursorOffset);

    // Find the word index of our just-inserted '_' in the simulated text.
    // Only count it as a blank when it's surrounded by whitespace (or BOL/EOL).
    const insertedWord = findUnderscoreAtChar(insertedText, event.cursorOffset);
    if (!insertedWord) return false;

    const slots = this.scan(insertedText);
    const slot = slots.find(s => s.index === insertedWord.index);
    if (!slot) return false;

    const control = this.configLoader.controls.get(slot.controlName) as
      | (Record<string, unknown> & {
          stepValues?: readonly string[];
          blankAutoPopulate?: boolean;
          blankClearKeywords?: boolean;
          blankConsumeContext?: boolean;
          blankKeywordExpansions?: Record<string, string>;
        })
      | undefined;
    if (!control) return false;
    if (control.blankAutoPopulate === false) return false;
    const stepValues = control.stepValues;
    if (!Array.isArray(stepValues) || stepValues.length === 0) return false;
    const fillValue = stepValues[0];

    const { clearEnd, expansion } = computeFillRange(control, slot);

    const { newText, newCursor } = clearEnd !== undefined || expansion != null
      ? buildClearKeywordText(insertedText, slot, fillValue, expansion, clearEnd)
      : { newText: insertedText.slice(0, insertedWord.start) + fillValue + insertedText.slice(insertedWord.end),
          newCursor: insertedWord.start + fillValue.length };

    this.adapter.setText(newText);
    this.adapter.setCursorOffset(newCursor);
    this.adapter.forceRender();
    return true;
  }

  /** Walk backward from blankIdx looking for a control's blankKeywords match. */
  private matchKeyword(words: readonly string[], blankIdx: number): BlankSlot | null {
    for (let j = blankIdx - 1; j >= 0; j -= 1) {
      for (const [name, control] of this.configLoader.controls.entries()) {
        const blankKeywords = (control as { blankKeywords?: readonly string[] }).blankKeywords;
        if (!blankKeywords || blankKeywords.length === 0) continue;
        const blankProximity = (control as { blankProximity?: number }).blankProximity;
        if (blankProximity != null && (blankIdx - j - 1) > blankProximity) continue;
        for (const kw of blankKeywords) {
          const kwLc = kw.toLowerCase();
          const kwWords = kwLc.split(/\s+/);
          const start = j - kwWords.length + 1;
          if (start < 0) continue;
          let matches = true;
          for (let k = 0; k < kwWords.length; k += 1) {
            if ((words[start + k] ?? '').toLowerCase() !== kwWords[k]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            return {
              index: blankIdx,
              keyword: kwLc,
              controlName: name,
              keywordStart: start,
              keywordEnd: j,
              proximity: blankIdx - j - 1,
            };
          }
        }
      }
    }
    return null;
  }
}

/** Debug helper — keys actually injected into the script env. */
function extraEnvKeys(control: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (control.model) keys.push('CUES_MODEL');
  if (control.apiUrl) keys.push('CUES_API_URL');
  if (control.apiKeyEnv) keys.push('CUES_API_KEY_ENV');
  if (control.altCount !== undefined) keys.push('CUES_ALT_COUNT');
  if (control.includeOriginal !== undefined) keys.push('CUES_INCLUDE_ORIGINAL');
  if (control.prompts && typeof control.prompts === 'object') {
    for (const k of Object.keys(control.prompts as object)) {
      keys.push('CUES_PROMPT_' + k.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
    }
  }
  return keys;
}

/**
 * Step 27/28/29 — derive the (clearEnd, expansion) pair that the helper
 * loop will apply, given a control's flags. Lets callers stay short.
 *
 *   - blankConsumeContext: clearEnd = slot.index - 1 (drop keyword +
 *     anything between it and the blank).
 *   - blankClearKeywords (alone): clearEnd = slot.keywordEnd (just the
 *     keyword span).
 *   - blankKeywordExpansions[keyword] (alone): no clear range widening
 *     beyond the keyword span; expansion fills the start.
 *   - Both clear flags + expansion: expansion is suppressed (clear wins).
 */
export function computeFillRange(
  control: {
    blankClearKeywords?: boolean;
    blankConsumeContext?: boolean;
    blankKeywordExpansions?: Record<string, string>;
  },
  slot: { index: number; keyword: string; keywordEnd: number },
): { clearEnd: number | undefined; expansion: string | undefined } {
  const consumeContext = control.blankConsumeContext === true;
  const clearKw = control.blankClearKeywords === true;
  let clearEnd: number | undefined;
  if (consumeContext) clearEnd = slot.index - 1;
  else if (clearKw) clearEnd = slot.keywordEnd;
  const expansion = (clearKw || consumeContext)
    ? undefined
    : control.blankKeywordExpansions?.[slot.keyword];
  return { clearEnd, expansion };
}

/**
 * Steps 27 + 28 + 29 — word-array reconstruction that handles keyword
 * clearing, keyword expansion, and consume-context in one pass.
 *
 *   - The range [keywordStart..clearEnd] is dropped (default clearEnd =
 *     keywordEnd, which clears just the keyword span — Step 27). When
 *     `clearEnd = slot.index - 1`, words between keyword and blank are
 *     also dropped — that's Step 29's blankConsumeContext.
 *   - If `expansion` is given, it's placed at keywordStart in the output
 *     (replacing the dropped keyword) — that's Step 28. Callers should
 *     suppress `expansion` when consume-context is widening clearEnd to
 *     the blank, since dropping context with an expansion still floating
 *     at the start reads weirdly. v1 didn't combine the two; we follow.
 *   - The slot.index entry is replaced with `fillValue`.
 *
 * Joining with a single space collapses any whitespace runs around the
 * modified positions — same trade-off v1 made when it switched off
 * char-position splice.
 *
 * If both blankClearKeywords and blankKeywordExpansions are set, the
 * caller passes `expansion: undefined` (clear wins). Matches v1's "same
 * net result" note.
 */
export function buildClearKeywordText(
  text: string,
  slot: { index: number; keywordStart: number; keywordEnd: number },
  fillValue: string,
  expansion?: string,
  clearEnd?: number,
): { newText: string; newCursor: number } {
  const cleaned = text.replace(/[\u200B\u200C]/g, '');
  const words = cleaned.split(/\s+/).filter(Boolean);
  const end = clearEnd ?? slot.keywordEnd;
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (i >= slot.keywordStart && i <= end) {
      if (i === slot.keywordStart && expansion) out.push(expansion);
      continue;
    }
    if (i === slot.index) {
      out.push(fillValue);
      cursor = out.join(' ').length;
    } else {
      out.push(words[i]);
    }
  }
  return { newText: out.join(' '), newCursor: cursor };
}

/**
 * Find the word in `text` containing the character at `charOffset` IF that
 * character is the lone '_' word at its position. Returns null if the '_'
 * is part of a larger word (e.g. `affirm_xyz`).
 */
function findUnderscoreAtChar(text: string, charOffset: number): { index: number; start: number; end: number } | null {
  const words = splitWords(text);
  for (const w of words) {
    if (w.start <= charOffset && charOffset < w.end && w.word === '_') {
      return { index: w.index, start: w.start, end: w.end };
    }
  }
  return null;
}
