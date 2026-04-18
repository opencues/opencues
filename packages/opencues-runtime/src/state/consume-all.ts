/**
 * State for the prompt-improver flow (Step 30/31). When a control with
 * `blankConsumeAll: true` fires its async fill, the script's stdout is
 * parsed line-by-line — line 1 replaces the entire input; the remaining
 * lines are stashed here for Ctrl+Alt+Up/Down cycling.
 *
 * `index` is the word index where the consumed span starts (always 0
 * after consume-all since the fill replaces the whole input).
 * `currentAltIndex` and `spanLength` mutate as the user cycles.
 *
 * `lastFilledText` carries the last text we (BlankFill or Cycling)
 * pushed to the host. BlankFill's onTextChange listener compares
 * incoming text against this — if it differs, the user typed something
 * unrelated and the stash is invalidated. v1's analogue is
 * `_lastResolvedText`.
 */
export interface ConsumeAllEntry {
  readonly index: number;
  readonly alternatives: readonly string[];
  currentAltIndex: number;
  spanLength: number;
}

export class ConsumeAllState {
  private _entry: ConsumeAllEntry | null = null;
  private _lastFilledText = '';

  get current(): ConsumeAllEntry | null { return this._entry; }
  get lastFilledText(): string { return this._lastFilledText; }

  set(entry: ConsumeAllEntry | null, filledText?: string): void {
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
