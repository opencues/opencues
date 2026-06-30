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

export interface BlankShapeMatch {
  /** Blank whose shape matched. */
  readonly blankName: string;
  /** Action the matched shape implies. */
  readonly action: 'get' | 'set' | 'step';
  /** Extracted value for set/step (from the shape's valueGroup); undefined for get. */
  readonly value?: string;
}

/**
 * Strip zero-width markers, then return the LINE containing the (last) `_`,
 * trimmed. Shapes are LINE-scoped: a command like `weather oslo _` claims its
 * `_` even when there's prior content on earlier lines ("notes…\nweather oslo
 * _"). Returns null when there's no `_`. Anchoring to the line (not the whole
 * buffer) is what lets shapes replace the old line-scoped keyword window.
 */
function lineWithBlank(text: string): string | null {
  const s = text.replace(/[​‌]/g, '');
  const us = s.lastIndexOf('_');
  if (us === -1) return null;
  const start = s.lastIndexOf('\n', us) + 1; // 0 when there's no preceding newline
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
      return { blankName: name, action: shape.action, value };
    }
  }
  return null;
}
