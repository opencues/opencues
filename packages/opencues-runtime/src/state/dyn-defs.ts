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
   * Return the DynDef at this index IFF the word currently at that
   * position is still "owned" by the def. Ownership = one of:
   *   - the current word equals def.originalWord (def is fresh)
   *   - the current word equals one of def.alternatives (user has
   *     cycled to an alt; def still drives subsequent cycles)
   * Otherwise the entry is stale (word indices shifted / user edited)
   * and callers treat the position as unresolved. Resolver's next
   * pass overwrites stale entries cleanly.
   *
   * Replaces the old blunt `dynDefs.clear()` on text-change. Clearing
   * caused a dim-flash on every keystroke (Navigation wiped the defs,
   * DimRender lost its data, Resolver re-populated 500 ms later).
   * Keeping defs + validating on read eliminates the flash without
   * letting stale entries leak visual glitches.
   */
  getValid(wordIndex: number, currentWord: string): WordDef | undefined {
    const def = this._defs.get(wordIndex);
    if (!def) return undefined;
    if (def.originalWord === currentWord) return def;
    if (def.alternatives.includes(currentWord)) return def;
    return undefined;
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
