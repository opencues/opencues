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
}

export class DynDefs {
  private _defs = new Map<number, WordDef>();

  get(wordIndex: number): WordDef | undefined {
    return this._defs.get(wordIndex);
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
