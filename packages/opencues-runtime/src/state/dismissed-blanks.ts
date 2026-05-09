/**
 * Tracks slot positions where the user has cycled the fill back to `_`
 * (blankDismissible). BlankFill.maybeRunScripts skips slots
 * whose word index is dismissed so the script doesn't immediately
 * re-fill what the user just dismissed.
 *
 * Cleared when the surrounding text changes such that the span is no
 * longer valid (BlankFill.onTextChange clears alongside SpanFillState).
 */
export class DismissedBlanks {
  private _wordIndices = new Set<number>();

  has(wordIndex: number): boolean {
    return this._wordIndices.has(wordIndex);
  }

  add(wordIndex: number): void {
    this._wordIndices.add(wordIndex);
  }

  delete(wordIndex: number): void {
    this._wordIndices.delete(wordIndex);
  }

  clear(): void {
    this._wordIndices.clear();
  }
}
