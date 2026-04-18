/**
 * State for the prompt-improver flow (Step 30/31). When a control with
 * `blankConsumeAll: true` fires its async fill, the script's stdout is
 * parsed line-by-line — line 1 replaces the entire input; the remaining
 * lines are stashed here for Ctrl+Alt+Up/Down cycling.
 *
 * `index` is the word index where the consumed span starts (always 0
 * after consume-all since the fill replaces the whole input).
 * `currentAltIndex` and `spanLength` mutate as the user cycles.
 */
export interface ConsumeAllEntry {
  readonly index: number;
  readonly alternatives: readonly string[];
  currentAltIndex: number;
  spanLength: number;
}

export class ConsumeAllState {
  private _entry: ConsumeAllEntry | null = null;

  get current(): ConsumeAllEntry | null { return this._entry; }

  set(entry: ConsumeAllEntry | null): void {
    this._entry = entry;
  }

  clear(): void {
    this._entry = null;
  }
}
