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

/**
 * Tokenise the def's currently-shown alt into words, caching the result on
 * the def so the regex split runs once per (def, currentIndex) instead of
 * once per call. Hot path — DimRender + pruneStale + findSpanContaining
 * call this O(W × D) times per keystroke; without the cache, ~7,700 splits
 * per keypress on a doc with 88 words and 88 defs.
 *
 * Cache invalidates whenever `currentIndex` changes (cycling), since that
 * picks a different alt string. Stored on the def directly via a
 * non-enumerable backdoor property; GC'd along with the def.
 */
function altWordsOf(def: WordDef): string[] {
  const cache = def as WordDef & { _altWordsCache?: { idx: number; words: string[] } };
  const idx = def.currentIndex;
  if (cache._altWordsCache !== undefined && cache._altWordsCache.idx === idx) {
    return cache._altWordsCache.words;
  }
  const words = (def.alternatives[idx] ?? '').split(/\s+/).filter(Boolean);
  // Non-enumerable so JSON.stringify and deep-equality assertions ignore it.
  Object.defineProperty(cache, '_altWordsCache', {
    value: { idx, words },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return words;
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
      const altWords = altWordsOf(def);
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

    // Pass 1 — classify each entry without mutating.
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

    // Pass 2 — resolve collisions. A move is dropped when:
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

    // Pass 3 — apply. Delete first (clears slots for incoming moves),
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
    const altWords = altWordsOf(def);
    if (altWords.length === 1) return altWords[0] === actual;
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
    const altWords = altWordsOf(def);
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

  /**
   * Find a span def whose content has been edited in `currentText` but
   * cannot be located elsewhere in the buffer (i.e. the user mutated the
   * span itself, not just inserted/deleted text around it).
   *
   * Spans that have shifted (because the user typed BEFORE the span)
   * still exist verbatim somewhere in the new text — those are returned
   * as `null` and left for `pruneStale` to relocate via word-walk.
   *
   * Spans whose current alt no longer appears as a substring anywhere
   * are returned as edited — the runtime treats those as "delete the
   * whole span" so user backspaces don't leave the buffer in a weird
   * partial state. See navigation.onTextChange for the buffer mutation.
   *
   * Returns the FIRST edited span found, or null. One per text-change
   * event is enough; the next event re-scans.
   */
  findEditedSpan(
    currentText: string,
    filter?: (def: WordDef) => boolean,
  ): { defIndex: number; spanStart: number; spanEnd: number } | null {
    for (const [index, def] of this._defs.entries()) {
      // Only consider character-range spans (multi-word substitutions).
      if (def.spanEnd <= def.spanStart) continue;
      // Caller-supplied scope filter — e.g. only `task-*` spans.
      if (filter && !filter(def)) continue;
      const expected = def.alternatives[def.currentIndex];
      if (!expected) continue; // empty alt — no content to defend
      const slice = currentText.slice(def.spanStart, def.spanEnd);
      if (slice === expected) continue; // intact at original position
      // Span shifted? If the expected content appears verbatim somewhere
      // else, the span just moved; let pruneStale relocate it.
      if (currentText.indexOf(expected) >= 0) continue;
      // Content not found anywhere → the span itself was mutated.
      return { defIndex: index, spanStart: def.spanStart, spanEnd: def.spanEnd };
    }
    return null;
  }
}

/**
 * Build the "as the user typed it" view of `visible` by replacing every
 * word the agent has edited (DynDef with `currentIndex > 0`) with its
 * `originalWord`. Multi-word agent edits collapse back to a single
 * word in the as-typed view (the def's currentAlt covers multiple
 * visible words; only the originalWord goes into the reconstruction).
 *
 * Used by transform-blank's EXTRACT pass: TASK_* commands resolve
 * against what the user TYPED, not what the agent rendered. So if
 * the agent translated `agentically` to `agentisch` for some reason,
 * `agentically X _` typed by the user is still recognised as
 * TASK_ARM.
 *
 * Whitespace and punctuation are preserved verbatim. Only word
 * content swaps.
 */
export function reconstructAsTyped(
  visible: string,
  dynDefs: DynDefs,
  splitWordsFn: (text: string) => Array<{ start: number; end: number; word: string; index: number }>,
): string {
  return reconstructAsTypedWithMap(visible, dynDefs, splitWordsFn).asTyped;
}

/**
 * Same reconstruction as `reconstructAsTyped` but also returns a
 * char-by-char mapping `asTypedToVisible[i]` = the visible char index
 * that asTyped char `i` represents. Used by `trimTriggerFromText` to
 * find a trigger keyword in the as-typed view, then strip the
 * corresponding span from the visible buffer (preserving the agent's
 * other edits).
 *
 * Mapping rule: identity for whitespace/punctuation between words.
 * Inside an agent-edited word, asTyped chars map proportionally to
 * the visible word's character range (`visibleStart + j * vlen /
 * altLen`). The exact distribution doesn't matter for trim — we
 * use the START of the trigger word and the position of the `_`,
 * both of which fall on word boundaries where the mapping is exact.
 */
export interface AsTypedReconstruction {
  readonly asTyped: string;
  readonly asTypedToVisible: readonly number[];
}

export function reconstructAsTypedWithMap(
  visible: string,
  dynDefs: DynDefs,
  splitWordsFn: (text: string) => Array<{ start: number; end: number; word: string; index: number }>,
): AsTypedReconstruction {
  const words = splitWordsFn(visible);
  const visited = new Set<number>();
  let asTyped = '';
  const map: number[] = [];
  let lastEnd = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (visited.has(i)) continue;
    const w = words[i];
    // Whitespace gap before this word — identity mapping.
    const ws = visible.slice(lastEnd, w.start);
    for (let j = 0; j < ws.length; j += 1) {
      asTyped += ws[j];
      map.push(lastEnd + j);
    }
    let writeWord = w.word;
    let visibleStart = w.start;
    let visibleEnd = w.end;
    const def = dynDefs.get(i);
    if (def && def.currentIndex > 0 && def.originalWord) {
      writeWord = def.originalWord;
      const span = dynDefs.findSpanContaining(i);
      if (span && span.originIdx === i && span.spanLength > 1) {
        for (let k = i; k < i + span.spanLength; k += 1) visited.add(k);
        const lastSpanWord = words[i + span.spanLength - 1];
        if (lastSpanWord) visibleEnd = lastSpanWord.end;
      }
    }
    // Map each asTyped char of the (possibly substituted) word to a
    // visible char in the span [visibleStart, visibleEnd).
    const visibleLen = visibleEnd - visibleStart;
    for (let j = 0; j < writeWord.length; j += 1) {
      asTyped += writeWord[j];
      const vc = writeWord.length === 0
        ? visibleStart
        : visibleStart + Math.min(visibleLen - 1, Math.floor(j * visibleLen / writeWord.length));
      map.push(Math.max(visibleStart, vc));
    }
    lastEnd = visibleEnd;
  }
  // Trailing whitespace.
  const trail = visible.slice(lastEnd);
  for (let j = 0; j < trail.length; j += 1) {
    asTyped += trail[j];
    map.push(lastEnd + j);
  }
  return { asTyped, asTypedToVisible: map };
}
