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

  constructor(
    private adapter: HostAdapter,
    private configLoader: ConfigLoader,
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
    this.scan(e.text);
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
      | (Record<string, unknown> & { stepValues?: readonly string[]; blankAutoPopulate?: boolean })
      | undefined;
    if (!control) return false;
    if (control.blankAutoPopulate === false) return false;
    const stepValues = control.stepValues;
    if (!Array.isArray(stepValues) || stepValues.length === 0) return false;
    const fillValue = stepValues[0];

    const filled =
      insertedText.slice(0, insertedWord.start) +
      fillValue +
      insertedText.slice(insertedWord.end);
    const newCursor = insertedWord.start + fillValue.length;

    this.adapter.setText(filled);
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
