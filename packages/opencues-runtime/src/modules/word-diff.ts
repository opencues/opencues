// Word-level diff + three-way merge for AgentRewrite.
//
// ─── INVARIANTS THIS MODULE ENFORCES ────────────────────────────────
// (regardless of what the LLM emits — defense in depth on top of the
//  prompt rules)
//
//   1. **User content is never silently destroyed.** Any LLM hunk
//      whose A-region overlaps a user hunk drops; the user wins on
//      conflict. Boundary case included: a deletion touching a user
//      insertion at its edge counts as overlap (the deleted region was
//      the natural separator between snapshot and user-typed content).
//
//   2. **Paragraph breaks the user typed cannot be collapsed.** Any
//      LLM hunk whose original contains a `\n\n+` run that the
//      replacement reduces gets dropped.
//
//   3. **Trailing whitespace at end-of-buffer survives.** When an LLM
//      hunk reaches end-of-snapshot and would shorten the trailing
//      whitespace run, we splice the missing whitespace back onto the
//      replacement instead of dropping the whole hunk (preserves any
//      legitimate word edit bundled with a trim).
//
//   4. **No surprise terminal punctuation at end-of-buffer.** When an
//      LLM hunk reaches end-of-snapshot and would add a `.`/`?`/`!`
//      the original didn't have, we strip it. The user may still be
//      typing the in-flight sentence.
//
// All four are implemented in `surviveAndAdjustHunk`, run once per
// LLM hunk in `threeWayMerge`. Each invariant has a dedicated test
// scenario in `word-diff.scenarios.test.ts`.
//
// ─── DIFF GEOMETRY ─────────────────────────────────────────────────
//
// LCS walk over ALTERNATING word + gap (whitespace-run) tokens of
// each string. Gap tokens make whitespace differences visible to the
// diff — structural changes (paragraph breaks, line breaks,
// indentation) generate hunks just like word substitutions.
//
// Tokens compare by (kind, exact-text). Two single-space gaps match;
// a single-space gap vs a `\n\n` gap doesn't. Pure-whitespace user
// edits (e.g. typing Enter twice between two unchanged sentences)
// produce a user hunk that the merge can detect and translate
// against — without this, the merge's char-position math drifts
// when whitespace shifts between snapshot and live.

type TokKind = 'word' | 'gap';

interface Tok {
  readonly kind: TokKind;
  readonly text: string;
  readonly start: number;     // char position in source string
  readonly end: number;       // exclusive
}

export interface DiffHunk {
  /** Inclusive char start in A. */
  readonly aStart: number;
  /** Exclusive char end in A. */
  readonly aEnd: number;
  /** Text drawn from B that replaces A[aStart..aEnd). */
  readonly replacement: string;
}

/**
 * Tokenize into alternating word + gap runs. Empty strings produce
 * empty token lists. A leading or trailing gap is captured (so a
 * trailing newline shows up as a token).
 */
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  if (s.length === 0) return out;
  let pos = 0;
  let isWS = /\s/.test(s.charAt(0));
  let runStart = 0;
  for (let i = 1; i <= s.length; i += 1) {
    const atEnd = i === s.length;
    const charIsWS = atEnd ? !isWS : /\s/.test(s.charAt(i));
    if (atEnd || charIsWS !== isWS) {
      out.push({
        kind: isWS ? 'gap' : 'word',
        text: s.slice(runStart, i),
        start: runStart,
        end: i,
      });
      runStart = i;
      isWS = charIsWS;
    }
    pos = i;
  }
  return out;
}

/**
 * Diff. Returns hunks that, when applied to A right-to-left, yield B.
 *
 * LCS over (kind, text) tokens. Quadratic in token count; fine for
 * the buffer sizes inline editors deal with (a few hundred words).
 *
 * Whitespace handling: gap tokens are first-class. A whitespace-only
 * change between A and B (e.g. " " → "\n\n") emits a hunk just like a
 * word substitution would. Word-level fixups (consume-one-space-on-
 * deletion, pad-on-insertion) are no longer needed because the gap
 * tokens are part of the LCS and the hunks include them naturally.
 */
export function wordDiff(a: string, b: string): DiffHunk[] {
  const aT = tokenize(a);
  const bT = tokenize(b);
  const m = aT.length, n = bT.length;

  // Token equality: same kind AND same exact text.
  const eq = (ti: Tok, tj: Tok): boolean => ti.kind === tj.kind && ti.text === tj.text;

  // LCS DP table over tokens.
  const dp: Int32Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = eq(aT[i - 1], bT[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Walk backwards to extract aligned token pairs.
  const pairs: Array<{ ai: number; bi: number }> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (eq(aT[i - 1], bT[j - 1])) {
      pairs.push({ ai: i - 1, bi: j - 1 });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();

  // Walk pairs and emit a hunk for each gap of unaligned tokens.
  const hunks: DiffHunk[] = [];
  let aPrev = 0;
  let bPrev = 0;
  const emitHunk = (aStartIdx: number, aEndIdx: number, bStartIdx: number, bEndIdx: number) => {
    if (aStartIdx === aEndIdx && bStartIdx === bEndIdx) return;
    let aStart: number;
    let aEnd: number;
    if (aStartIdx < aEndIdx) {
      aStart = aT[aStartIdx].start;
      aEnd = aT[aEndIdx - 1].end;
    } else {
      // Pure insertion: position is between two A-tokens (or at a doc end).
      const pos = aStartIdx === 0 ? 0 : aT[aStartIdx - 1].end;
      aStart = pos;
      aEnd = pos;
    }
    const replacement = bStartIdx < bEndIdx
      ? b.slice(bT[bStartIdx].start, bT[bEndIdx - 1].end)
      : '';
    hunks.push({ aStart, aEnd, replacement });
  };
  for (const p of pairs) {
    emitHunk(aPrev, p.ai, bPrev, p.bi);
    aPrev = p.ai + 1;
    bPrev = p.bi + 1;
  }
  emitHunk(aPrev, m, bPrev, n);

  // Coalesce adjacent hunks that touch (LCS may produce a word-hunk
  // followed immediately by a gap-hunk; merge them so callers see one
  // contiguous edit). Same A's char range coalescing as patch tools do.
  if (hunks.length < 2) return hunks;
  const merged: DiffHunk[] = [hunks[0]];
  for (let k = 1; k < hunks.length; k += 1) {
    const prev = merged[merged.length - 1];
    const cur = hunks[k];
    if (prev.aEnd === cur.aStart) {
      merged[merged.length - 1] = {
        aStart: prev.aStart,
        aEnd: cur.aEnd,
        replacement: prev.replacement + cur.replacement,
      };
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * Apply hunks (right-to-left, since they're in A's char frame) to A,
 * producing the rewritten string. Convenience for tests + sanity checks.
 */
export function applyHunks(a: string, hunks: ReadonlyArray<DiffHunk>): string {
  const sortedDesc = hunks.slice().sort((x, y) => y.aStart - x.aStart);
  let out = a;
  for (const h of sortedDesc) {
    out = out.slice(0, h.aStart) + h.replacement + out.slice(h.aEnd);
  }
  return out;
}

/**
 * Translate a position in A's char frame to the corresponding position
 * in C's char frame, given the user's hunks (snapshot→live).
 * Each user hunk before `aPos` shifts the position by its length delta.
 */
/**
 * Translate aPos to its char position in C. For point-insertions in
 * userHunks the boundary case (aPos === insertion.aStart) is ambiguous
 * — `anchor` disambiguates:
 *   - 'start' (LLM hunk's aStart): translate AFTER the user insertion
 *     so the LLM hunk operates on snapshot content, not user content.
 *   - 'end'   (LLM hunk's aEnd):   translate BEFORE the user insertion
 *     so the slice doesn't consume the user's typed content.
 *
 * For non-boundary positions and range user hunks, anchor doesn't
 * matter — the rule is symmetric.
 */
export function translateAToC(
  aPos: number,
  userHunks: ReadonlyArray<DiffHunk>,
  anchor: 'start' | 'end' = 'start',
): number {
  let cPos = aPos;
  for (const u of userHunks) {
    const isInsertion = u.aStart === u.aEnd;
    if (isInsertion) {
      const shouldShift = anchor === 'start'
        ? u.aStart <= aPos              // start: shift AT or AFTER insertion
        : u.aStart < aPos;              // end: shift only AFTER insertion
      if (shouldShift) cPos += u.replacement.length;
    } else {
      // Range hunk shifts positions at or after its end.
      if (u.aEnd <= aPos) cPos += u.replacement.length - (u.aEnd - u.aStart);
    }
  }
  return cPos;
}

export interface ThreeWayMergeResult {
  /** The merged buffer text. */
  readonly newText: string;
  /** LLM hunks that survived the merge (no user-overlap). */
  readonly appliedLlmHunks: ReadonlyArray<DiffHunk>;
  /** LLM hunks dropped because the user touched the same A-region. */
  readonly droppedLlmHunks: ReadonlyArray<DiffHunk>;
  /** User hunks (snapshot → live) — exposed so callers can translate cursor. */
  readonly userHunks: ReadonlyArray<DiffHunk>;
}

/**
 * Run an LLM hunk through every merge-layer invariant in sequence and
 * return either `drop` (skip the hunk) or `keep` with the (possibly
 * adjusted) hunk to apply.
 *
 * The four invariants enforced — every one grounded in a real-LLM
 * misbehaviour the harness caught:
 *
 *  1. **User-region overlap** — drop if any user hunk in A's frame
 *     overlaps this LLM hunk. Includes the boundary case where a user
 *     insertion sits exactly at a deletion's edge (the deleted region
 *     was the natural separator between snapshot and user content).
 *
 *  2. **Paragraph-break preservation** — drop if the hunk's original
 *     contains a `\n\n+` run that the replacement reduces. The user
 *     explicitly typed that structure; the LLM doesn't get to
 *     canonicalise.
 *
 *  3. **Trailing-whitespace preservation** — when the hunk reaches
 *     end-of-snapshot and would shorten the trailing whitespace run,
 *     splice the missing whitespace back onto the replacement. Keeps
 *     "food? " from being trimmed to "food?" round after round.
 *
 *  4. **No-auto-terminator** — when the hunk reaches end-of-snapshot
 *     and would add a terminator (`.`, `?`, `!`) the original didn't
 *     have, strip it. The in-flight sentence may still be typed;
 *     stable-buffer rounds shouldn't surprise-terminate.
 *
 * Each rule short-circuits — order matters. Overlap checks come first
 * (drop fast); whitespace-restore and terminator-strip come last (apply
 * to the SURVIVING replacement so they layer cleanly).
 */
function surviveAndAdjustHunk(
  raw: DiffHunk,
  snapshot: string,
  userHunks: ReadonlyArray<DiffHunk>,
): { kind: 'drop' } | { kind: 'keep'; hunk: DiffHunk } {
  // 1. User-region overlap.
  if (userHunks.some(u => overlaps(raw, u))) return { kind: 'drop' };

  const origText = snapshot.slice(raw.aStart, raw.aEnd);

  // 2. Paragraph-break preservation.
  const origPB = countParagraphBreaks(origText);
  if (origPB > 0 && countParagraphBreaks(raw.replacement) < origPB) {
    return { kind: 'drop' };
  }

  // Following two rules only apply at end-of-snapshot.
  if (raw.aEnd !== snapshot.length) {
    return { kind: 'keep', hunk: raw };
  }

  let replacement = raw.replacement;

  // 3. Trailing-whitespace preservation.
  const origTail = origText.match(/\s*$/)![0];
  const replTail = replacement.match(/\s*$/)![0];
  if (origTail.length > replTail.length) {
    replacement = replacement + origTail.slice(replTail.length);
  }

  // 4. No-auto-terminator.
  const origLastCh = origText.replace(/\s+$/, '').slice(-1);
  const replLastCh = replacement.replace(/\s+$/, '').slice(-1);
  const isTerminator = (c: string) => c === '.' || c === '?' || c === '!';
  if (isTerminator(replLastCh) && !isTerminator(origLastCh)) {
    replacement = replacement.replace(/[.!?](\s*)$/, '$1');
  }

  return { kind: 'keep', hunk: { aStart: raw.aStart, aEnd: raw.aEnd, replacement } };
}

/**
 * Count paragraph-break runs (consecutive newlines, 2 or more) in a
 * string. Used by the merge to detect when an LLM hunk would collapse
 * a \n\n paragraph break into fewer newlines.
 */
function countParagraphBreaks(s: string): number {
  let count = 0;
  const re = /\n{2,}/g;
  while (re.exec(s) !== null) count += 1;
  return count;
}

function overlaps(h1: DiffHunk, h2: DiffHunk): boolean {
  const h1Pt = h1.aStart === h1.aEnd;
  const h2Pt = h2.aStart === h2.aEnd;
  // Two point-insertions at the same position conflict (both want to
  // expand at the same slot — user wins).
  if (h1Pt && h2Pt) return h1.aStart === h2.aStart;
  // Point insertion vs range: overlap iff the point sits strictly inside
  // the range — EXCEPT when the range is a pure DELETION touching the
  // insertion at its boundary. The deleted region was the natural
  // separator between snapshot content and user's appended content;
  // applying the deletion would concatenate them ("Hi name. " + LLM
  // delete " " trailing + user " is wilfred" appended → "Hi name.is
  // wilfred"). Treat boundary-touch deletion-vs-insertion as overlap.
  if (h1Pt) {
    if (h2.replacement === '' && (h1.aStart === h2.aEnd || h1.aStart === h2.aStart)) return true;
    return h1.aStart > h2.aStart && h1.aStart < h2.aEnd;
  }
  if (h2Pt) {
    if (h1.replacement === '' && (h2.aStart === h1.aEnd || h2.aStart === h1.aStart)) return true;
    return h2.aStart > h1.aStart && h2.aStart < h1.aEnd;
  }
  // Two ranges: standard interval overlap.
  return !(h1.aEnd <= h2.aStart || h2.aEnd <= h1.aStart);
}

/**
 * Three-way merge:
 *   A = snapshot (what the LLM saw)
 *   B = LLM rewrite (what the LLM wants)
 *   C = live (current buffer; may include user typing since A)
 *
 * For each LLM hunk (A→B), check whether any user hunk (A→C) overlaps
 * it in A's frame. Non-overlapping LLM hunks splice into C at their
 * translated positions; overlapping ones are dropped (user wins).
 *
 * The result is C with LLM's safe edits layered in. User-typed regions
 * survive verbatim.
 */
export function threeWayMerge(snapshot: string, rewrite: string, live: string): ThreeWayMergeResult {
  const llmHunks = wordDiff(snapshot, rewrite);
  const userHunks = wordDiff(snapshot, live);
  const applied: DiffHunk[] = [];
  const dropped: DiffHunk[] = [];
  for (const raw of llmHunks) {
    const verdict = surviveAndAdjustHunk(raw, snapshot, userHunks);
    if (verdict.kind === 'drop') dropped.push(raw);
    else applied.push(verdict.hunk);
  }
  // Apply right-to-left in C's frame.
  const sortedDesc = applied.slice().sort((a, b) => b.aStart - a.aStart);
  let result = live;
  for (const h of sortedDesc) {
    const cStart = translateAToC(h.aStart, userHunks, 'start');
    const cEnd = translateAToC(h.aEnd, userHunks, 'end');
    result = result.slice(0, cStart) + h.replacement + result.slice(cEnd);
  }
  return { newText: result, appliedLlmHunks: applied, droppedLlmHunks: dropped, userHunks };
}
