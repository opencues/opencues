export interface WordDef {
  /** Original word as found in text at populate time. */
  readonly originalWord: string;
  /** List of cycle options. Index 0 is the original word; cycling rotates through all. */
  readonly alternatives: readonly string[];
  /** Which alternative is currently displayed. */
  currentIndex: number;
  /** Start offset of the current alt in the text. */
  spanStart: number;
  /** End offset (exclusive) of the current alt in the text. */
  spanEnd: number;
  /**
   * Optional control attribution. Set by BlankFill when the def came
   * from a blank fill so cycling can route to the originating control's
   * blankStep / blankScript instead of guessing via stepPattern (which
   * is ambiguous when multiple controls share the same suffix, e.g.
   * volume + brightness both use `%`).
   */
  readonly controlName?: string;
}

export class DynDefs {
  private _defs = new Map<number, WordDef>();

  get(wordIndex: number): WordDef | undefined {
    return this._defs.get(wordIndex);
  }

  /**
   * Remove entries whose current word no longer matches what the def
   * represents. Called:
   *   - on user text change (Navigation.onTextChange) — keystrokes,
   *     paste, delete, etc.
   *   - on runtime-source text change when multi-word cycling shifts
   *     word indices (Cycling.applyAltCycle) — e.g. cycling
   *     "lawyer" → "legal eagle" moves everything after index+1 by
   *     one, and DynDefs that haven't been reindexed would splice
   *     against the wrong positions on the next cycle.
   *
   * A def survives if:
   *   - its originalWord equals the current word (fresh def, untouched)
   *   - its current alt is a single word === current word (mid-cycle)
   *   - its current alt is multi-word AND all N words match
   *     contiguously at [index..index+N-1] (mid-cycle multi-word span)
   */
  pruneStale(words: readonly { word: string }[]): void {
    for (const [index, def] of this._defs.entries()) {
      const actual = words[index]?.word;
      if (!actual) { this._defs.delete(index); continue; }
      if (def.originalWord === actual) continue;
      const currentAlt = def.alternatives[def.currentIndex] ?? '';
      const altWords = currentAlt.split(/\s+/).filter(Boolean);
      if (altWords.length === 1) {
        if (currentAlt === actual) continue;
      } else if (altWords.length > 1) {
        const allMatch = altWords.every((w, k) => words[index + k]?.word === w);
        if (allMatch) continue;
      }
      this._defs.delete(index);
    }
  }

  set(wordIndex: number, def: WordDef): void {
    this._defs.set(wordIndex, def);
  }

  delete(wordIndex: number): void {
    this._defs.delete(wordIndex);
  }

  clear(): void {
    this._defs.clear();
  }

  entries(): IterableIterator<[number, WordDef]> {
    return this._defs.entries();
  }

  get size(): number {
    return this._defs.size;
  }
}
