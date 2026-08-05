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
  /**
   * Optional dynamic tip for the status line. Unlike static word-cue tips
   * (which the statusline reads from the config-loader by word), this carries
   * a per-result advisory computed at resolve time — e.g. a sentence-cue's
   * calendar-conflict heads-up ("⚠ Dentist today, 3:00–3:45pm"). The statusline
   * surfaces it when the cursor is on the def's span, so the advisory shows
   * passively without cycling.
   */
  readonly cueTip?: string;
  /**
   * Source priority of the cue that registered this def (for passive
   * sentence-cues). Used to resolve an overlap DETERMINISTICALLY by priority:
   * a higher-priority sentence-cue evicts a lower-priority one on the same span,
   * regardless of which registered first (so a contradiction cue at 87 always
   * beats a formalizer at 85, not by timing). Absent → treated as 0.
   */
  readonly priority?: number;
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
/** Sentence-cue defs (blankName `sentence-cue:<name>`) are the only ones
 *  whose char span (spanStart/spanEnd) is authoritative over the word-count-
 *  derived range. Mirrors the predicate in dim-render.ts / cycling.ts. */
function isSentenceCueDef(def: WordDef): boolean {
  return typeof def.blankName === 'string' && def.blankName.startsWith('sentence-cue:');
}

/**
 * The inline-note text for a def, or `undefined` if the def has no note. A def
 * is NOTE-BEARING when it either:
 *   - carries a `cueTip` (sentence-cue / contradiction — an advisory), OR
 *   - is a history-bearing LLM blank (transform / fluid) with >1 alternative —
 *     so its walkable transform history is discoverable + `_`-steppable.
 *
 * Shared SINGLE SOURCE OF TRUTH for "what gets a note", used by both DimRender
 * (paints the note) and Cycling (`_`-cycle) so the two can't drift on which
 * spans are note-bearing. The blank labels are PLACEHOLDERS — the indicator
 * text/style is deliberately deferred (see docs/architecture/inline-cue-cycle.md).
 */
// ── Inline-note format (2026-08 redesign) ──────────────────────────────────
//
// One rule: an EMOJI leads a note that is a NOTIFICATION (something's flagged —
// a factual conflict ⚠/🧢, a clarifying question ❓, a spelling error ✍️); a
// cycleable IMPROVEMENT (a formality lift, a transform result, a lookup answer)
// carries NO emoji, just a leading number + a label. Every cycleable note shows
// a COUNTDOWN number (options remaining, N→1) followed by ` | ` — for a
// notification the emoji leads (`⚠ 6 | msg`), for an improvement the number
// leads (`3 | Improve formality`).
// The right-aligned `(underscore to cycle)` affordance is added by the host
// renderer (it needs the session cycle state — see hasCycledEver()).

/** Emoji that lead a NOTIFICATION note. `✍️` carries a VS16 selector. */
const NOTE_EMOJIS = ['⚠', '🧢', '❓', '✍️', '⚠️'];

/** Short label shown for a cycleable sentence cue instead of a preview. Keyed
 *  by the cue name (the `sentence-cue:<name>` blankName suffix). */
const SENTENCE_CUE_LABELS: Record<string, string> = {
  'more-formal': 'Improve formality',
};

/** Split a leading note emoji off a cueTip, if present. */
function splitNoteEmoji(s: string): { emoji?: string; rest: string } {
  for (const e of NOTE_EMOJIS) {
    if (s.startsWith(e)) return { emoji: e === '⚠️' ? '⚠' : e, rest: s.slice(e.length).trimStart() };
  }
  return { rest: s };
}

/** Up-to-2-word preview of the alternative the def would cycle TO next — the
 *  DESTINATION, not the current buffer text. A transform/fluid note that
 *  previewed `alternatives[currentIndex]` just mirrored what's already on
 *  screen; the useful thing is "press `_` → you get THIS" (e.g. after a
 *  transform, the revert-to-original preview). Falls back to the current
 *  alternative only when there's nothing else to cycle to. Ellipsised. */
function previewTwoWords(def: WordDef): string {
  const alt = upcomingAlternatives(def, 1)[0]
    || def.alternatives[def.currentIndex]
    || def.alternatives[def.alternatives.length - 1]
    || '';
  const words = alt.split(/\s+/).filter(Boolean);
  const head = words.slice(0, 2).join(' ');
  return words.length > 2 ? `${head}…` : head;
}

/**
 * How many cycle stops REMAIN from the current position — the countdown number
 * shown in the inline note. Starts at the total (alternatives.length) at the
 * original and decrements as the user cycles, flooring at 1 on the last stop
 * (cycling once more wraps back to the original). Never 0.
 */
export function inlineNoteCount(def: WordDef): number {
  return Math.max(1, def.alternatives.length - def.currentIndex);
}

export function inlineNoteText(def: WordDef): string | undefined {
  const n = inlineNoteCount(def);

  // NOTIFICATION — carries a cueTip whose first glyph is the type emoji
  // (contradiction/calendar ⚠/🧢, ask-cues ❓). A CYCLEABLE notification
  // (contradiction's reconciled value, ask-cues options) gets the countdown;
  // a pure ADVISORY with nothing to cycle to (calendar conflict, alternatives
  // = [original]) shows just the emoji + message — no number, no pipe.
  if (def.cueTip) {
    const { emoji, rest } = splitNoteEmoji(def.cueTip);
    const em = emoji ?? '⚠';
    const msg = rest.replace(/\s*[·▸]\s*/g, ' | ');
    return def.alternatives.length > 1 ? `${em} ${n} | ${msg}` : `${em} ${msg}`;
  }

  if (def.alternatives.length <= 1) return undefined;

  // IMPROVEMENTS — number FIRST, no emoji, then ` | ` then the label/preview.
  if (def.blankName === 'transform-blank' || def.blankName === 'fluid-blank') {
    const preview = previewTwoWords(def);
    return preview ? `${n} | ${preview}` : `${n}`;
  }
  if (isSentenceCueDef(def)) {
    const name = def.blankName!.slice('sentence-cue:'.length);
    const label = SENTENCE_CUE_LABELS[name] ?? previewTwoWords(def);
    return label ? `${n} | ${label}` : `${n}`;
  }

  // SPELLING (plain word-cue, no blankName) — a NOTIFICATION (an error): lead
  // with ✍️ + the countdown, list the options you can still cycle TO,
  // pipe-separated. The list ROTATES with currentIndex — cycling drops the one
  // you're on and advances the rest, wrapping through EVERY stop INCLUDING the
  // original (you can cycle back to it), so the note always shows where the
  // next presses lead.
  if (!def.blankName) {
    const upcoming = upcomingAlternatives(def, 3);
    if (upcoming.length > 0) return `✍️ ${n} | ${upcoming.join(' | ')}`;
  }
  return undefined;
}

/**
 * The alternatives a def can still cycle TO from the current position, in cycle
 * order (wrapping), EXCLUDING only the one currently in the buffer. Includes the
 * original (index 0) — it's a real cycle stop you can return to. Rotates as
 * `currentIndex` advances so the note tracks the cycle. Capped at `max`.
 */
function upcomingAlternatives(def: WordDef, max: number): string[] {
  const alts = def.alternatives.filter(Boolean);
  if (alts.length <= 1) return [];
  const cur = def.currentIndex;
  const out: string[] = [];
  for (let i = 1; i < alts.length; i++) out.push(alts[(cur + i) % alts.length]);
  return out.slice(0, max);
}

// ── First-cycle affordance state ───────────────────────────────────────────
// The `(underscore to cycle)` hint shows until the user cycles ANY note once —
// then they've learned the gesture and it drops off everywhere for the rest of
// the session. Session-scoped (in-memory); a fresh host process shows it again.
let _hasCycledEver = false;
/** True once the user has cycled at least one inline note this session. */
export function hasCycledEver(): boolean { return _hasCycledEver; }
/** Record that the user cycled a note (called from Cycling on every step). */
export function markCycledEver(): void { _hasCycledEver = true; }
/** Test hook — reset the session affordance flag. */
export function _resetCycledEverForTests(): void { _hasCycledEver = false; }

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

  /** Optional debug sink for span-lifecycle tracing (slide / prune / drop /
   *  relocate). Off unless a host wires it (debug-mode gated at the sink). Used
   *  to diagnose the "span dies then reattaches" flicker where a def is dropped
   *  by one keystroke and relocated by the next. */
  private _debugLog: ((msg: string) => void) | null = null;
  setDebugLog(fn: ((msg: string) => void) | null): void { this._debugLog = fn; }

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
   * Shift the CHAR span (spanStart/spanEnd) of every span-bound def that
   * begins at or after `charOffset` by `delta` chars. Companion to
   * `shiftAfter` (which shifts the word-index keys): when a cycle splices
   * a length-changing alt, downstream defs keep their word position but
   * their stored char offsets go stale.
   *
   * This matters specifically for sentence-cue defs, whose char span IS
   * the splice/highlight source of truth AND which are LOCKED against
   * re-resolution (the resolver's blankName guard), so they never
   * self-heal a stale span. In spaceless/mixed CJK, cycling an earlier
   * sentence changes char offsets without changing the whitespace-word
   * count — so `shiftAfter`'s `delta` is 0 and the word-index path alone
   * leaves later sentences pointing at the wrong chars, mis-splicing the
   * next cycle. Keying off the char offset (not the word index) closes
   * that gap. Defs at-or-before the splice point are untouched.
   */
  /**
   * Every registered sentence-cue def (`blankName` = `sentence-cue:*`) with a
   * valid char span, sorted by span start. Includes defs at synthetic keys
   * (same-word CJK collisions) that the word-iterating consumers can't see —
   * DimRender uses this for a dedicated dim pass, Cycling to resolve the
   * sentence under the cursor. The map key is returned as `key` so callers
   * can address the exact entry (synthetic or natural).
   */
  sentenceCueDefs(): Array<{ key: number; def: WordDef }> {
    const out: Array<{ key: number; def: WordDef }> = [];
    for (const [key, def] of this._defs.entries()) {
      if (typeof def.blankName !== 'string' || !def.blankName.startsWith('sentence-cue:')) continue;
      if (typeof def.spanStart !== 'number' || typeof def.spanEnd !== 'number') continue;
      if (def.spanEnd <= def.spanStart) continue;
      out.push({ key, def });
    }
    out.sort((a, b) => a.def.spanStart - b.def.spanStart);
    return out;
  }

  shiftCharSpansAfter(charOffset: number, delta: number): void {
    if (delta === 0) return;
    for (const def of this._defs.values()) {
      if (typeof def.spanStart !== 'number' || typeof def.spanEnd !== 'number') continue;
      if (def.spanEnd <= def.spanStart) continue;
      if (def.spanStart < charOffset) continue;
      def.spanStart += delta;
      def.spanEnd += delta;
    }
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
  findSpanContaining(
    index: number,
    words?: ReadonlyArray<{ start: number; end: number }>,
  ): { originIdx: number; spanLength: number; def: WordDef } | null {
    for (const [originIdx, def] of this._defs.entries()) {
      if (originIdx > index) continue;
      // Sentence-cue defs carry an AUTHORITATIVE char span. Deriving the
      // word range from alt word-count overshoots for CJK: with no space
      // after `。`, a sentence's first token fuses into the prior word, so
      // the alt has MORE whitespace-tokens than the buffer words it
      // actually occupies — adjacent sentence spans then overlap and the
      // later sentence's origin gets swallowed as an "inner" word (its dim
      // vanishes). When live word positions are available, bound the span
      // by the char span instead: the last covered word is the last one
      // that STARTS before spanEnd.
      if (words && isSentenceCueDef(def) && def.spanEnd > def.spanStart) {
        let lastIdx = originIdx;
        for (let i = originIdx; i < words.length; i++) {
          if (words[i].start < def.spanEnd) lastIdx = i; else break;
        }
        if (index <= lastIdx) {
          return { originIdx, spanLength: lastIdx - originIdx + 1, def };
        }
        continue;
      }
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
    for (const [idx, { def, decision }] of decisions) {
      if (decision.kind === 'drop') {
        this._debugLog?.(`pruneStale: def@${idx} DROPPED (blank=${def.blankName ?? 'none'}, alt[${def.currentIndex}]="${(def.alternatives[def.currentIndex] ?? '').slice(0, 24)}" not found at index and no unique relocate)`);
      } else if (decision.kind === 'move') {
        this._debugLog?.(`pruneStale: def@${idx} → relocated to @${decision.to} (blank=${def.blankName ?? 'none'})`);
      }
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

  /**
   * Register a def at `wordIndex`. Returns `true` if it was stored, `false` if
   * REJECTED by the managed-span invariant below.
   *
   * ## Managed-span ownership invariant (the centralised guard)
   *
   * A def WITHOUT a `blankName` (a plain word-cue / static-alt) is REJECTED if
   * its char span overlaps the span of an existing def WITH a `blankName` (a
   * managed owner: transform-blank / fluid-blank / config-intent / sentence-cue
   * / volume / brightness / list-blank …). The owner owns its region; a word-cue
   * overlapping it registers a competing DynDef that fights the owner on every
   * re-resolve / cycle (wrong dim, wrong cycle target, or a data-loss splice).
   *
   * This used to be enforced ad-hoc at one call site (the resolver's word-cue
   * branch), keyed by WORD INDEX — which missed overlaps where the owner sits
   * at a different index than the word-cue (a spaceless-CJK paragraph is one
   * giant word; the owner is registered elsewhere). Centralising it here, keyed
   * by SPAN OVERLAP, means every external caller (resolver, cycling's
   * buildDefFrom, blank-fill, any future code) is protected — the guard can't
   * be forgotten per-site.
   *
   * SAFE for internal mechanics: `shiftAfter` / `pruneStale` / `relocate`
   * re-insert via `this._defs` DIRECTLY (not this method), so a key shift never
   * trips the guard. Managed owners (def HAS a blankName) are always allowed —
   * owner-vs-owner overlap is arbitrated upstream (e.g. the sentence-cue branch
   * refuses to register over an active managed span). The slot at `wordIndex`
   * itself is excluded (updating / refreshing a def is always allowed).
   */
  set(wordIndex: number, def: WordDef): boolean {
    if (
      typeof def.blankName !== 'string'
      && typeof def.spanStart === 'number' && typeof def.spanEnd === 'number'
      && def.spanEnd > def.spanStart
    ) {
      for (const [k, d] of this._defs) {
        if (k === wordIndex) continue;
        if (typeof d.blankName !== 'string') continue; // only managed owners block
        if (typeof d.spanStart !== 'number' || typeof d.spanEnd !== 'number' || d.spanEnd <= d.spanStart) continue;
        if (def.spanStart < d.spanEnd && d.spanStart < def.spanEnd) {
          return false; // overlaps a managed span — reject
        }
      }
    }
    this._defs.set(wordIndex, def);
    return true;
  }

  delete(wordIndex: number): void {
    this._defs.delete(wordIndex);
  }

  /**
   * Wipe every word-index → WordDef entry.
   *
   * Lifecycle note: DynDefs entries are keyed by word-index in the
   * CURRENT buffer. For single-buffer-per-session hosts (CC, OC,
   * gemini-cli) the runtime's lifetime matches the buffer's, so this
   * is rarely called outside tests. For multi-buffer hosts (chrome's
   * normal-input mode — every `<input>` on the page is a separate
   * buffer) the integration MUST call `clear()` on focus change.
   *
   * Why: a `blankName`-bound entry from buffer A silently blocks the
   * Resolver from substituting in buffer B at the same wordIndex
   * (`if (existing.blankName) continue`). Surfaces as "fluid-blank
   * works on one input then stops working on the next." See
   * `docs/architecture/universal-integration.md` § "Per-buffer state
   * must reset on focus change" for the full per-state-object table
   * and `BootResult.resetBufferState()` for the runtime entry point.
   */
  clear(): void {
    this._defs.clear();
  }

  /**
   * SLIDE char spans across a user edit that happened entirely BEFORE
   * them — never stretch, never adopt. A user edit shifts every later
   * char offset, but (unlike runtime cycles, which call
   * shiftCharSpansAfter) nothing updated user-edit offsets, so an Enter
   * typed above a span left the def alive (word indices unchanged) with
   * a stale char span - the dim died while cycling kept working.
   * Slide-only is deliberately the WHOLE fix: the reverted rebase's
   * adopt/stretch step absorbed adjacent typing on ambiguous diff
   * boundaries; with slide-only, a misjudged boundary at worst leaves
   * the span stale (dim drops - the previous status quo), never wrong.
   */
  slideCharSpans(oldText: string, newText: string): void {
    if (oldText === newText || this._defs.size === 0) return;
    const maxP = Math.min(oldText.length, newText.length);
    let p = 0;
    while (p < maxP && oldText[p] === newText[p]) p++;
    let sfx = 0;
    while (sfx < maxP - p
      && oldText[oldText.length - 1 - sfx] === newText[newText.length - 1 - sfx]) sfx++;
    const oldEditEnd = oldText.length - sfx;   // edit range in OLD text: [p, oldEditEnd)
    const d = newText.length - oldText.length;
    if (d === 0 && p >= oldEditEnd) return;    // no-op change
    for (const [idx, def] of this._defs.entries()) {
      if (typeof def.spanStart !== 'number' || typeof def.spanEnd !== 'number') continue;
      if (def.spanEnd <= def.spanStart || def.spanEnd > oldText.length) {
        this._debugLog?.(`slideCharSpans: def@${idx} [${def.spanStart},${def.spanEnd}] out-of-range vs oldLen=${oldText.length} — NOT slid (will likely prune)`);
        continue;
      }
      // Only spans LIVE against the old text may slide - arithmetic must
      // never resurrect an already-stale span.
      const expected = def.alternatives[def.currentIndex];
      if (typeof expected !== 'string'
        || oldText.slice(def.spanStart, def.spanEnd) !== expected) {
        this._debugLog?.(`slideCharSpans: def@${idx} [${def.spanStart},${def.spanEnd}] STALE (buffer slice ≠ alt[${def.currentIndex}]="${(expected ?? '').slice(0, 24)}") — NOT slid`);
        continue;
      }
      if (oldEditEnd <= def.spanStart) {
        this._debugLog?.(`slideCharSpans: def@${idx} [${def.spanStart},${def.spanEnd}]→[${def.spanStart + d},${def.spanEnd + d}] (edit [${p},${oldEditEnd}) before span, d=${d})`);
        def.spanStart += d;
        def.spanEnd += d;
      } else {
        this._debugLog?.(`slideCharSpans: def@${idx} [${def.spanStart},${def.spanEnd}] kept (edit [${p},${oldEditEnd}) not before span, d=${d}) — span survives`);
      }
    }
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
   * whole span" so user backspaces don't leave the buffer in an
   * inconsistent partial state. See navigation.onTextChange for the
   * buffer mutation.
   *
   * Returns the FIRST edited span found, or null. One per text-change
   * event is enough; the next event re-scans.
   */
  /**
   * Find an existing LLM-blank def whose current alt is still verbatim in
   * `liveText` at its recorded span, AND whose span is fully contained in
   * the new substitute's `[newSpanStart, newSpanEnd)`. Used by the
   * fluid-blank / transform-blank chain extension at substitute time so a
   * sequence of LLM rewrites builds one walkable history instead of
   * clobbering the prior result.
   *
   * Containment + verbatim is the structural fix that scopes "extend the
   * chain" to "this new substitute fully encompasses an unchanged prior
   * substitute". User edits inside the prior result break verbatim → fresh
   * def, no chain. User edits outside the prior result preserve verbatim →
   * chain extends with the new outer body as the pre-substitute question.
   *
   * `blankNames` lets the caller scope which class of chain to look for
   * (e.g. only `['transform-blank']` so a fluid-blank doesn't graft onto a
   * transform-blank chain — different pipelines, different intent).
   *
   * Returns the FIRST match. Sequential whole-buffer LLM substitutes
   * structurally produce at most one matching def; FILL-mode FB at the
   * same word position likewise. Ambiguity is not expected in practice.
   */
  findChainableLlmDef(
    liveText: string,
    newSpanStart: number,
    newSpanEnd: number,
    blankNames: readonly string[],
  ): { wordIndex: number; def: WordDef } | null {
    for (const [wordIndex, def] of this._defs.entries()) {
      if (!def.blankName || !blankNames.includes(def.blankName)) continue;
      // Existing def's span must be fully contained in the new substitute's range.
      if (def.spanStart < newSpanStart) continue;
      if (def.spanEnd > newSpanEnd) continue;
      // Verbatim check — the current alt must still be at its recorded
      // position. Any edit inside the prior result breaks the chain.
      const currentAlt = def.alternatives[def.currentIndex];
      if (currentAlt === undefined) continue;
      if (liveText.slice(def.spanStart, def.spanEnd) !== currentAlt) continue;
      return { wordIndex, def };
    }
    return null;
  }

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
    // Only revert AGENT-driven rewrites in the as-typed view. The
    // as-typed shim exists so EXTRACT sees the user's TYPED text even
    // after the agent (AgentRewrite module) has changed words —
    // canonical example: user typed "agentically X _", agent
    // translated "agentically" to something else in visible; EXTRACT
    // still needs to recognise the trigger word.
    //
    // User-driven substitutions (spelling correction the user accepted
    // by cycling Up, cue-word synonym they picked) MUST NOT be
    // reverted — the user CHOSE that word; re-injecting the original
    // would overwrite their explicit fix on the next substitute pass.
    // Same rationale as the transform-blank skip (originalWord there
    // is the whole prior body) but broader: any non-agent def is the
    // user's choice.
    const isAgentRewrite = def?.blankName === 'agent-task';
    if (def && def.currentIndex > 0 && def.originalWord && isAgentRewrite) {
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
