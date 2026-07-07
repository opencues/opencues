// Deterministic blank invocation by SHAPE (type-based routing experiment).
//
// A blank may declare `blankShapes` — anchored regexes over the buffer, each
// mapped to an action (get/set/step) + an optional value capture group. When a
// `_`-bearing buffer matches one, the blank is the unambiguous owner of that
// `_`: ZERO LLM, NO blankProximity. This is the deterministic Tier-1 of the
// "match the query to the tool's declared type, not by keyword distance" idea.
//
// What it deliberately is NOT: a fuzzy/semantic matcher. A shape only fires on
// an EXACT grammar match (`volume 30 _`, `set volume to 30 _`). Conversational
// or ambiguous input matches nothing here and falls to fluid/transform — so
// this can never wrongly capture a query (a non-match is a clean cede).

import type { BlankConfig } from './cues-md';
import { segmentStart } from './segment';
import { keywordInWindow, lineOfWords } from './keyword-window';

export interface BlankShapeMatch {
  /** Blank whose shape matched. */
  readonly blankName: string;
  /** Action the matched shape implies. */
  readonly action: 'get' | 'set' | 'step';
  /** Extracted value for set/step (from the shape's valueGroup); undefined for get. */
  readonly value?: string;
}

/**
 * Strip zero-width markers, then return the command SEGMENT containing the
 * (last) `_`, trimmed. Shapes are SENTENCE-scoped: a command like `weather oslo
 * _` claims its `_` when it leads its sentence — whether that sentence starts at
 * a newline ("notes…\nweather oslo _") OR after a sentence terminator on the
 * same line ("let me check. weather oslo _" → "weather oslo _"). The
 * segment START comes from the shared `segmentStart` (the same boundary
 * fluid-config's `summonPhraseStart` uses, so the two routers agree); the END
 * stays at the next newline / buffer end. Returns null when there's no `_`.
 * Anchoring to the sentence (not the whole buffer) is what lets shapes replace
 * the old line-scoped keyword window without a stray keyword in prose hijacking
 * a `_`.
 */
function lineWithBlank(text: string): string | null {
  const s = text.replace(/[​‌]/g, '');
  const us = s.lastIndexOf('_');
  if (us === -1) return null;
  const start = segmentStart(s, us); // last sentence terminator OR newline before `_`
  let end = s.indexOf('\n', us);
  if (end === -1) end = s.length;
  return s.slice(start, end).trim();
}

/**
 * Find the blank whose declared shape matches the buffer. Returns the first
 * match (blanks are tried in iteration order) or null when nothing matches —
 * a null result means "no blank claims this deterministically", so the caller
 * lets the normal sources (fluid/transform) handle the `_`.
 *
 * Pure + synchronous: no I/O, no LLM. Safe to call on every keystroke.
 */
export function matchBlankShape(
  text: string,
  blanks: ReadonlyMap<string, Pick<BlankConfig, 'blankShapes'>>
    | Readonly<Record<string, Pick<BlankConfig, 'blankShapes'>>>,
): BlankShapeMatch | null {
  const t = lineWithBlank(text);
  if (t === null || !t.includes('_')) return null;
  const entries: Iterable<[string, Pick<BlankConfig, 'blankShapes'>]> =
    blanks instanceof Map ? blanks.entries() : Object.entries(blanks);
  for (const [name, cfg] of entries) {
    const shapes = cfg.blankShapes;
    if (!shapes || shapes.length === 0) continue;
    for (const shape of shapes) {
      let re: RegExp;
      try {
        // Case-insensitive; the pattern is author-supplied frontmatter, not
        // user input, so a bad pattern is skipped (never throws to the caller).
        re = new RegExp(shape.pattern, 'i');
      } catch {
        continue;
      }
      const m = t.match(re);
      if (!m) continue;
      const value = shape.valueGroup != null ? m[shape.valueGroup] : undefined;
      // A captured arg that contains a standalone `_` means the greedy
      // `(.+?)` swallowed an EARLIER blank slot into the arg region
      // ("affirm _ improve prompt _" → affirm's get-with-arg matching
      // value "_ improve prompt"). That's never a real invocation of
      // this shape — skip it so the earlier `_` keeps its own owner
      // and this one falls to whichever shape/keyword genuinely leads
      // its segment. Clean cede, consistent with the module contract.
      if (value !== undefined && value.split(/\s+/).includes('_')) continue;
      return { blankName: name, action: shape.action, value };
    }
  }
  return null;
}

type ClaimBlank = Pick<BlankConfig, 'blankShapes' | 'blankKeywords'>;

/**
 * Does some keyword/shaped blank CLAIM this `_`? The SINGLE shared cede
 * predicate for the three semantic-`_` sources (FluidBlank / TransformBlank /
 * ConfigIntent): each returns `false` from `supports()` when this returns true,
 * yielding the `_` to the blank. Centralised so the three can't drift — the
 * June 2026 long-buffer bug was ConfigIntent carrying a stale inline copy that
 * (unlike the other two) didn't skip shaped blanks, so an incidental keyword in
 * prose (`The volume is now 30%`) on the `_`'s line made it cede and a real
 * settings command (`voice mode off _`) silently fell through to fluid-blank.
 *
 *   - TYPE-BASED: a declared SHAPE matches the `_`'s segment (anchored grammar,
 *     e.g. `volume 30 _`). Exact, so prose can never trigger it.
 *   - LEGACY (non-shaped blanks only): a keyword sits on the same line as `_`
 *     (shared `keywordInWindow`). Shaped blanks are governed solely by the
 *     shape match above — a stray keyword in prose doesn't claim.
 */
export function blankClaimsUnderscore(
  text: string,
  words: readonly string[],
  blanks: ReadonlyMap<string, ClaimBlank> | Readonly<Record<string, ClaimBlank>>,
): boolean {
  if (matchBlankShape(text, blanks)) return true;
  const lower = words.map(w => w.toLowerCase());
  const blankIndex = lower.indexOf('_');
  if (blankIndex === -1) return false;
  const lineOf = lineOfWords(text);
  const entries: Iterable<ClaimBlank> =
    blanks instanceof Map ? blanks.values() : Object.values(blanks);
  for (const blk of entries) {
    if (blk.blankShapes?.length) continue;
    if (!blk.blankKeywords?.length) continue;
    for (const phrase of blk.blankKeywords) {
      const parts = phrase.toLowerCase().split(/\s+/);
      for (let i = 0; i <= lower.length - parts.length; i += 1) {
        let ok = true;
        for (let j = 0; j < parts.length; j += 1) {
          if (lower[i + j] !== parts[j]) { ok = false; break; }
        }
        if (!ok) continue;
        if (keywordInWindow(i + parts.length - 1, blankIndex, { lineOf })) return true;
      }
    }
  }
  return false;
}
