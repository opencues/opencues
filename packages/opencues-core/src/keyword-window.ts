/**
 * keyword-window.ts — the SINGLE source of truth for "is a blank keyword
 * within reach of this `_`?", shared by every site that decides whether a
 * keyword-bound blank claims a slot:
 *
 *   - BlankSource.getCues          (resolver: which blank claims)
 *   - FluidBlankSource.supports    (resolver: cede to the keyword blank)
 *   - TransformBlankSource.supports (resolver: cede)
 *   - ConfigIntentSource.supports  (resolver: cede)
 *   - BlankFill.matchKeyword       (runtime: claim for script dispatch)
 *
 * Why centralised: these five independently decide who owns a `_`. If the
 * window drifts between them (e.g. one widened, the others not), TWO
 * sources fire on the same `_` — the June 2026 double-fire race
 * (BlankFill set `brightness 90` while FluidBlank answered "percent").
 * Routing every site through this one predicate makes that drift
 * structurally impossible.
 *
 * The window is LINE-SCOPED: a keyword claims a `_` when it sits on the
 * SAME LINE as the `_`. The per-blank `blankProximity` tuning knob was
 * retired — precise routing is the job of `blankShapes` (anchored
 * whole-line grammar, deterministic), so the keyword window only needs the
 * loose "a tool keyword is plausibly in play on this line" test. Shaped
 * blanks bypass this window entirely (they're claimed by their shape).
 */

/** Words strictly between the keyword's last word and the `_`. 0 = adjacent. */
export function keywordGap(keywordEndIdx: number, blankIdx: number): number {
  return Math.abs(blankIdx - keywordEndIdx) - 1;
}

export interface KeywordWindowOptions {
  /** Per-word 0-based line numbers, parallel to the words array (see
   *  `lineOfWords`). Required for the line-scoped window; when omitted it
   *  falls back to a wide fixed window so the predicate is still safe. */
  readonly lineOf?: readonly number[];
}

/** Defensive fallback window (in words) used only when no `lineOf` was
 *  threaded through. */
export const LINE_SCOPE_FALLBACK_PROXIMITY = 12;

/**
 * Is the keyword (whose LAST word is at `keywordEndIdx`) on the same line
 * as the `_` at `blankIdx`?
 */
export function keywordInWindow(
  keywordEndIdx: number,
  blankIdx: number,
  opts?: KeywordWindowOptions,
): boolean {
  if (opts?.lineOf && keywordEndIdx < opts.lineOf.length && blankIdx < opts.lineOf.length) {
    // Same line ⇒ no newline anywhere between the keyword and `_`
    // (lineOf is monotonic non-decreasing).
    return opts.lineOf[keywordEndIdx] === opts.lineOf[blankIdx];
  }
  return keywordGap(keywordEndIdx, blankIdx) <= LINE_SCOPE_FALLBACK_PROXIMITY;
}

/**
 * Per-word 0-based line numbers for `text`, with the SAME word order as
 * `text.split(/\s+/).filter(Boolean)` — so every existing word index stays
 * valid while recovering the newline boundaries `\s+` collapses. Built
 * per-line (split on `\n`, then whitespace). `lineOf` is monotonic
 * non-decreasing.
 */
export function lineOfWords(text: string): number[] {
  const lineOf: number[] = [];
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln += 1) {
    for (const w of lines[ln].split(/\s+/)) {
      if (w) lineOf.push(ln);
    }
  }
  return lineOf;
}
