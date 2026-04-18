/**
 * State for any multi-word span fill — Step 30 (consume-all / prompt
 * improver) and Step 33 (multi-word stepValues / blankScript fills).
 *
 * Originally `ConsumeAllState`, narrowly scoped to the prompt improver.
 * Step 33 extended the same shape to cover affirmations ("I am strong"
 * → "I am brave") and any future multi-word fill, so the class was
 * renamed `SpanFillState`.
 *
 * `index` is the word index where the consumed span starts. For
 * consume-all, that's 0 (fill replaces everything). For stepValues
 * fills, it's the post-clear position of the inserted alternative.
 *
 * `currentAltIndex` and `spanLength` mutate as the user cycles —
 * spanLength must follow the new alt's word count so highlight, dim,
 * and navigation can re-derive the span on the next render.
 *
 * `lastFilledText` carries the last text we (BlankFill or Cycling)
 * pushed to the host. BlankFill's onTextChange listener compares
 * incoming text against it — if it differs, the user typed something
 * unrelated and the stash is invalidated. v1's analogue is
 * `_lastResolvedText`.
 */
export interface SpanFillEntry {
  readonly index: number;
  readonly alternatives: readonly string[];
  currentAltIndex: number;
  spanLength: number;
  /**
   * Optional control-side tip text. When set, Statusline shows this verbatim
   * when the highlight lands on the span — bypasses cueMap lookup which
   * would miss filled words like "13.9°C" or "Reddit".
   */
  readonly blankTip?: string;
}

export class SpanFillState {
  private _entry: SpanFillEntry | null = null;
  private _lastFilledText = '';

  get current(): SpanFillEntry | null { return this._entry; }
  get lastFilledText(): string { return this._lastFilledText; }

  set(entry: SpanFillEntry | null, filledText?: string): void {
    this._entry = entry;
    if (entry === null) {
      this._lastFilledText = '';
    } else if (filledText !== undefined) {
      this._lastFilledText = filledText;
    }
  }

  clear(): void {
    this._entry = null;
    this._lastFilledText = '';
  }
}
