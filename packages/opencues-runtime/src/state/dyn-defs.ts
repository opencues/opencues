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
   * Optional blank attribution. Set by BlankFill when the def
   * came from a blank fill so cycling can route to the originating
   * blank's blankStep / blankScript.
   */
  readonly blankName?: string;
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
  /**
   * Shift every DynDef at index > origin by `delta` positions.
   * Called after a runtime-source cycle changes word count (single ↔
   * multi-word static-alt swap) — every downstream DynDef now lives at
   * a word position N steps to the left/right and would otherwise be
   * pruned (their originalWord no longer matches the new word at the
   * old index). Shifting first preserves dim/cycling continuity for
   * those resolved-but-unrelated words; pruneStale runs afterwards to
   * mop up any genuinely stale entries.
   *
   * Order-safe: snapshots all to-be-shifted entries first, then
   * deletes + re-inserts. No collision possible with the entries
   * staying put (origin and below).
   */
  shiftAfter(originIndex: number, delta: number): void {
    if (delta === 0) return;
    const moves: Array<[number, WordDef]> = [];
    for (const [idx, def] of this._defs.entries()) {
      if (idx > originIndex) {
        moves.push([idx, def]);
      }
    }
    for (const [idx] of moves) this._defs.delete(idx);
    for (const [idx, def] of moves) this._defs.set(idx + delta, def);
  }

  /**
   * Find the multi-word static-alt span (if any) that covers `index`.
   * Returns the span's origin DynDef and length, or null if the
   * position isn't inside any multi-word span.
   *
   * A multi-word span = a DynDef whose currentAlt contains spaces.
   * The span occupies [originIdx .. originIdx + N - 1] where N is the
   * alt's word count. After Apr 2026 (the multi-span refactor) this is
   * the SOLE source of static-alt span info — DimRender, Navigation,
   * and Cycling all consult it instead of SpanFillState (which now
   * holds only blank-fills, one slot at a time).
   *
   * O(defs * 1). Linear in the number of active DynDefs, fine for the
   * tens-of-words contexts the runtime sees in practice.
   */
  findSpanContaining(index: number): { originIdx: number; spanLength: number; def: WordDef } | null {
    for (const [originIdx, def] of this._defs.entries()) {
      if (originIdx > index) continue;
      const currentAlt = def.alternatives[def.currentIndex] ?? '';
      const altWords = currentAlt.split(/\s+/).filter(Boolean);
      if (altWords.length <= 1) continue;
      if (index >= originIdx + altWords.length) continue;
      return { originIdx, spanLength: altWords.length, def };
    }
    return null;
  }

  /**
   * Reconcile DynDefs with the current text: keep entries that still
   * match at their existing index, RELOCATE entries whose content
   * appears at exactly one different position (deterministic
   * re-anchor), and drop everything else.
   *
   * Snapshot → classify → resolve collisions → apply, in three phases.
   *
   * Why three phases: relocate decisions can collide (two defs both
   * want to move to the same target, or a relocate target is occupied
   * by a "keep") — collision detection has to see all decisions before
   * any mutation. Single-pass mutation would also break iteration
   * order: a def moved to a higher index could be re-evaluated under
   * its new index and double-act.
   *
   * Relocate is deterministic (only fires when EXACTLY ONE match
   * exists); ambiguity always drops. This is the design
   * trade-off: we'd rather force the user to re-cycle than silently
   * relocate a def to the wrong position. See
   * docs/architecture/spans-and-cycling.md § "Deterministic relocate".
   */
  pruneStale(words: readonly { word: string }[]): void {
    type Decision =
      | { kind: 'keep' }
      | { kind: 'drop' }
      | { kind: 'move'; to: number };
    const decisions = new Map<number, { def: WordDef; decision: Decision }>();

    // Phase 1 — classify each entry without mutating.
    for (const [index, def] of this._defs.entries()) {
      if (this._defMatchesAt(def, index, words)) {
        decisions.set(index, { def, decision: { kind: 'keep' } });
        continue;
      }
      const target = this._findUniqueMatch(def, words);
      if (target !== null && target !== index) {
        decisions.set(index, { def, decision: { kind: 'move', to: target } });
      } else {
        decisions.set(index, { def, decision: { kind: 'drop' } });
      }
    }

    // Phase 2 — resolve collisions. A move is dropped when:
    //  - another move targets the same destination (ambiguous outcome)
    //  - the destination is currently occupied by a 'keep' def
    //    (we don't overwrite a fresh def with a relocated one)
    const moveTargets = new Map<number, number[]>();
    for (const [from, { decision }] of decisions) {
      if (decision.kind === 'move') {
        const arr = moveTargets.get(decision.to) ?? [];
        arr.push(from);
        moveTargets.set(decision.to, arr);
      }
    }
    for (const [target, fromIndices] of moveTargets) {
      const occupiedByKeep = decisions.get(target)?.decision.kind === 'keep';
      if (fromIndices.length > 1 || occupiedByKeep) {
        for (const from of fromIndices) {
          decisions.set(from, { def: decisions.get(from)!.def, decision: { kind: 'drop' } });
        }
      }
    }

    // Phase 3 — apply. Delete first (clears slots for incoming moves),
    // then re-insert moved entries.
    for (const [idx, { decision }] of decisions) {
      if (decision.kind !== 'keep') this._defs.delete(idx);
    }
    for (const [, { def, decision }] of decisions) {
      if (decision.kind === 'move') this._defs.set(decision.to, def);
    }
  }

  /** Does `def` correctly describe the word(s) at `index` in `words`? */
  private _defMatchesAt(def: WordDef, index: number, words: readonly { word: string }[]): boolean {
    const actual = words[index]?.word;
    if (actual === undefined) return false;
    if (def.originalWord === actual) return true;
    const currentAlt = def.alternatives[def.currentIndex] ?? '';
    const altWords = currentAlt.split(/\s+/).filter(Boolean);
    if (altWords.length === 1) return currentAlt === actual;
    if (altWords.length > 1) {
      return altWords.every((w, k) => words[index + k]?.word === w);
    }
    return false;
  }

  /**
   * Return the unique index where `def`'s current alt appears
   * contiguously in `words`, or null if zero or more than one match
   * exists. Conservative: ambiguity = no relocate.
   */
  private _findUniqueMatch(def: WordDef, words: readonly { word: string }[]): number | null {
    const currentAlt = def.alternatives[def.currentIndex] ?? '';
    const altWords = currentAlt.split(/\s+/).filter(Boolean);
    if (altWords.length === 0) return null;
    let foundAt: number | null = null;
    for (let i = 0; i <= words.length - altWords.length; i += 1) {
      let ok = true;
      for (let k = 0; k < altWords.length; k += 1) {
        if (words[i + k]?.word !== altWords[k]) { ok = false; break; }
      }
      if (ok) {
        if (foundAt !== null) return null; // ambiguous — bail
        foundAt = i;
      }
    }
    return foundAt;
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
