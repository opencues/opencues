/**
 * Post-processor for sentinel-mode user-context output.
 *
 * Takes the LLM's raw answer + the catalog + optionally the user's
 * pre-edit body text, and produces a safe-to-insert string.
 *
 * Two refinements over naive verbatim substitution:
 *
 *   - TOLERANT MATCHING: an LLM-emitted token that doesn't match the
 *     catalog verbatim (e.g. `[WORK_CITY]` underscore vs catalog's
 *     `[WORK CITY]` space) is normalised — uppercase, spaces/underscores
 *     unified — and looked up again. Recovers Claude's format drift
 *     without the LLM having to be perfect.
 *
 *   - HALLUCINATION STRIP: a `[TOKEN]` pattern that doesn't resolve
 *     (after tolerant matching) is removed from the output, because
 *     leaving the literal text in the user's buffer would surface
 *     bracket-noise the user didn't ask for. Specifically catches
 *     Claude's `[DATE OF BIRTH]` / `[BLOOD TYPE]` invention.
 *
 * Both rules respect a load-bearing exception:
 *
 *   - PRESERVE WHAT THE USER WROTE: if `originalBody` is supplied and
 *     it contains a literal `[TOKEN]`, the post-processor LEAVES that
 *     exact bracket-string alone. The user might be writing
 *     documentation about the sentinel API, or referencing their own
 *     hand-written placeholder — we don't get to overwrite that.
 *
 * Returns the safe string plus a report enumerating every action
 * taken for debugging / audit logging.
 */

export interface PostProcessOptions {
  /** The catalog: sentinel-token (verbatim form) → resolved value. */
  catalog: ReadonlyMap<string, string>;
  /** The text that was in the user's buffer BEFORE the LLM ran. Any
   *  bracket-token already present here is preserved untouched. */
  originalBody?: string;
}

export interface PostProcessReport {
  /** Exact verbatim matches that resolved against the catalog. */
  resolved: Array<{ token: string; value: string }>;
  /** Tolerant matches — token wasn't verbatim, but normalised form
   *  found a catalog hit. Each entry records both the raw form the
   *  LLM emitted AND the canonical catalog token it mapped to. */
  tolerantMatches: Array<{ written: string; canonical: string; value: string }>;
  /** Bracket-tokens stripped from output (not in catalog after
   *  tolerant lookup, and not in originalBody). */
  stripped: string[];
  /** Bracket-tokens left untouched because they were in originalBody. */
  preserved: string[];
}

/** Canonicalise a token for tolerant matching: uppercase, swap
 *  underscores for spaces, collapse multi-space. The shape `[X Y Z]`
 *  is preserved; only what's INSIDE the brackets is normalised. */
function canonicalise(token: string): string {
  const inner = token.slice(1, -1); // strip outer [ and ]
  const norm = inner.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return `[${norm}]`;
}

/** Build a lookup from canonical form → verbatim catalog token, so a
 *  tolerant match can report which catalog entry it landed on. */
function buildCanonicalIndex(catalog: ReadonlyMap<string, string>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const tok of catalog.keys()) idx.set(canonicalise(tok), tok);
  return idx;
}

/** Bracket-token pattern. Matches `[` + at-least-one-char + `]`,
 *  uppercase + space/underscore/hyphen body. Intentionally NOT matching
 *  prose like `[note]` or `[1]` to avoid false-positives in long-form
 *  LLM output. */
const TOKEN_RE = /\[[A-Z][A-Z0-9 _-]*\]/g;

export interface PostProcessResult {
  output: string;
  report: PostProcessReport;
}

export function postProcess(llmOutput: string, opts: PostProcessOptions): PostProcessResult {
  const { catalog, originalBody } = opts;
  const canonicalIndex = buildCanonicalIndex(catalog);
  const report: PostProcessReport = {
    resolved: [],
    tolerantMatches: [],
    stripped: [],
    preserved: [],
  };

  const output = llmOutput.replace(TOKEN_RE, (match) => {
    // 1. The user already had THIS exact bracket-string in the
    //    original body → preserve it verbatim. Don't substitute, don't
    //    strip, even if it happens to match the catalog. Their text
    //    wins. This catches the "writing documentation about sentinels"
    //    case AND the "user accidentally typed [WORK_CITY] themselves
    //    and the LLM echoed it back unchanged" case.
    if (originalBody && originalBody.includes(match)) {
      report.preserved.push(match);
      return match;
    }
    // 2. Verbatim catalog match → resolve to value.
    const exactValue = catalog.get(match);
    if (exactValue !== undefined) {
      report.resolved.push({ token: match, value: exactValue });
      return exactValue;
    }
    // 3. Tolerant match — normalise and re-lookup. Only fires when the
    //    user did NOT already have this exact form in their body
    //    (so we don't "fix" what they intentionally typed).
    const canonical = canonicalise(match);
    const canonicalToken = canonicalIndex.get(canonical);
    if (canonicalToken !== undefined) {
      const value = catalog.get(canonicalToken)!;
      report.tolerantMatches.push({ written: match, canonical: canonicalToken, value });
      return value;
    }
    // 4. Unresolved — strip from output. The LLM invented a token
    //    with no catalog entry; leaving the literal text would
    //    surface `[DATE OF BIRTH]` / `[BLOOD TYPE]` in the user's
    //    buffer.
    report.stripped.push(match);
    return '';
  });

  return { output, report };
}
