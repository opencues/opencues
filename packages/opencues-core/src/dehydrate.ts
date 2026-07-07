/**
 * Dehydration — outbound value→token scrub for identity-context safe mode.
 *
 * The inverse of `identity-context.ts`'s post-processor (hydration):
 * before any buffer text ships to an LLM provider, real identity values
 * from the IDENTITY.md catalog are replaced with their canonical
 * `[TOKEN]` forms, so PII the user *typed* never leaves the machine —
 * closing the other half of the loop that safe mode's token-only
 * catalog already covers on the prompt side. The LLM works on the
 * dehydrated text and echoes tokens; the existing `postProcessContext`
 * hydrates real values back in locally.
 *
 * PURE — no I/O, no `node:*` imports, no `process` access (must run in
 * the chrome content script; see `scripts/lint-runtime-browser-safe.sh`).
 *
 * Matching contract:
 *   - word-boundary via Unicode lookarounds (`\b` is wrong for values
 *     with non-word edges — emails, `+44…` phones — and for CJK);
 *   - case-insensitive (typed `wilfred` is still PII);
 *   - longest-value-first so `Wilfred Kasekende` wins over `Wilfred`
 *     at the same start position;
 *   - internal whitespace runs match flexibly (`\s+`);
 *   - possessive `'s` / trailing punctuation need no special casing —
 *     the boundary permits a following apostrophe/punct, so
 *     `Wilfred's` dehydrates to `[FIRST NAME]'s` and hydrates back.
 *
 * Values too short (<3 chars) or too common (dictionary words, month /
 * day names) to match safely are SKIPPED — surfaced on
 * `CompiledDehydrator.skipped` and warned once per compile with the
 * value redacted. Visible residual, never silent.
 *
 * Determinism: a single left-to-right pass over one compiled regex —
 * same input + same catalog ⇒ byte-identical output, so Cerebras
 * prefix caching keeps hitting across calls.
 *
 * Docs: `docs/architecture/hydration-dehydration.md`.
 */

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface DehydrationSpan {
  /** Replaced range in the ORIGINAL text. */
  origStart: number;
  origEnd: number;
  /** Corresponding token range in the DEHYDRATED text. */
  outStart: number;
  outEnd: number;
  /** Catalog token substituted in. */
  token: string;
  /** Exact surface form matched (case may differ from the catalog
   *  value — `wilfred` vs `Wilfred`). Kept for observability; the
   *  documented residual is that hydration restores the CANONICAL
   *  catalog value, so non-canonical casing round-trips to canonical.
   *  Cosmetic, never data loss. */
  matched: string;
}

export interface DehydrationSkip {
  token: string;
  value: string;
  reason: 'too-short' | 'common-word' | 'bracket-token';
}

export interface DehydrationResult {
  /** Dehydrated text (=== input when nothing matched). */
  readonly text: string;
  readonly spans: readonly DehydrationSpan[];
  /** Canonical tokens this call introduced — thread into
   *  `postProcessContext`'s `introducedTokens` so the hydrator can
   *  distinguish our substitutions from user-typed bracket text. */
  readonly introduced: ReadonlySet<string>;
  readonly changed: boolean;
  /**
   * Map an original-text offset into dehydrated coordinates. Offsets
   * landing INSIDE a replaced value snap to the token boundary —
   * `bias: 'right'` (default 'left') snaps to the end of the token.
   * Used for `[CURSOR]` sentinel injection so the sentinel can never
   * split a value mid-word (`Wil[CURSOR]fred` would defeat matching
   * and leak fragments).
   */
  mapOffset(origOffset: number, bias?: 'left' | 'right'): number;
}

export interface CompiledDehydrator {
  /** Total: never throws. On an internal error the input is returned
   *  unchanged and `onWarn` fires — the dispatch-level floor still
   *  covers the call, so a bug degrades to a loud warning, not a
   *  silent PII ship. */
  dehydrate(text: string): DehydrationResult;
  /** Word-level test used by word-cue routing to withhold PII words
   *  from LLM dispatch entirely (no alternatives for your name). */
  isPiiWord(word: string): boolean;
  /** Static per-catalog skips — logged once at compile time. */
  readonly skipped: readonly DehydrationSkip[];
  /** Count of eligible (matchable) values. */
  readonly size: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Skip rules
// ───────────────────────────────────────────────────────────────────────────

const MIN_VALUE_LENGTH = 3;

/**
 * Single-word values in this set are too common to match safely — a
 * catalog value of `will` or `may` would tokenize ordinary prose (or
 * every date mention) and mangle what the LLM sees. Includes month and
 * day names: `June` as a first name is a real loss, but it is surfaced
 * via the skip warning rather than silently corrupting `June 2026`.
 * Lowercased membership test.
 */
const COMMON_WORDS = new Set([
  // high-frequency English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
  'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did',
  'its', 'let', 'put', 'say', 'she', 'too', 'use', 'that', 'with',
  'have', 'this', 'will', 'your', 'from', 'they', 'know', 'want',
  'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come',
  'here', 'just', 'like', 'long', 'make', 'many', 'more', 'only',
  'over', 'such', 'take', 'than', 'them', 'well', 'were', 'what',
  'work', 'year', 'back', 'call', 'came', 'each', 'even', 'find',
  'give', 'hand', 'high', 'keep', 'last', 'late', 'left', 'life',
  'live', 'look', 'made', 'most', 'move', 'must', 'name', 'need',
  'next', 'open', 'part', 'play', 'said', 'same', 'seem', 'show',
  'side', 'tell', 'turn', 'used', 'week', 'went', 'word', 'home',
  'house', 'world', 'still', 'should', 'could', 'would', 'about',
  'after', 'again', 'also', 'always', 'around', 'because', 'before',
  'below', 'between', 'both', 'down', 'during', 'every', 'first',
  'found', 'great', 'help', 'large', 'little', 'never', 'off', 'once',
  'other', 'own', 'people', 'place', 'right', 'small', 'sound',
  'their', 'there', 'these', 'thing', 'think', 'three', 'through',
  'under', 'until', 'water', 'where', 'which', 'while', 'why',
  'write', 'may', 'mark', 'bill', 'rose', 'grace', 'sunny',
  // months + days (date mentions would otherwise tokenize)
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sunday',
]);

/** Redact a value for warn logs: first char + length. Never log PII. */
function redact(value: string): string {
  return value.length === 0 ? '(empty)' : `${value[0]}…(${value.length} chars)`;
}

// ───────────────────────────────────────────────────────────────────────────
// Compilation
// ───────────────────────────────────────────────────────────────────────────

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIALS, '\\$&');
}

/** CJK scripts don't delimit words with spaces, so a letter-class
 *  boundary would block every in-prose match (a Han name inside a Han
 *  sentence would silently LEAK). For a value edge in these scripts we
 *  drop the boundary on that side — substring adjacency is the norm. */
const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Escape a value into a regex branch: parts escaped verbatim, internal
 *  whitespace runs matched flexibly, boundaries applied per-side unless
 *  that side's edge character is CJK. */
function valueToBranch(value: string): string {
  const v = value.trim();
  const body = v.split(/\s+/).map(escapeRegex).join('\\s+');
  const lead = CJK_EDGE.test(v[0]) ? '' : '(?<![\\p{L}\\p{N}])';
  const tail = CJK_EDGE.test(v[v.length - 1]) ? '' : '(?![\\p{L}\\p{N}])';
  return `${lead}${body}${tail}`;
}

/** Normalise a matched surface form for reverse lookup (case-fold +
 *  collapse whitespace). Must agree with the key used at compile time. */
function normalizeSurface(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function classifySkip(value: string): DehydrationSkip['reason'] | null {
  const v = value.trim();
  if (v.length < MIN_VALUE_LENGTH) return 'too-short';
  if (v.startsWith('[') && v.endsWith(']')) return 'bracket-token';
  if (!/\s/.test(v) && COMMON_WORDS.has(v.toLowerCase())) return 'common-word';
  return null;
}

export function compileDehydrator(
  catalog: ReadonlyMap<string, string>,
  onWarn?: (msg: string) => void,
): CompiledDehydrator {
  interface Entry { token: string; value: string }
  const entries: Entry[] = [];
  const skipped: DehydrationSkip[] = [];
  // Reverse index: normalized surface → token. Two tokens sharing a
  // value: first catalog entry wins (Map iteration order), matching
  // the parser's existing first-wins collision policy.
  const surfaceToToken = new Map<string, string>();

  for (const [token, value] of catalog) {
    const reason = classifySkip(value);
    if (reason) {
      skipped.push({ token, value, reason });
      continue;
    }
    const norm = normalizeSurface(value);
    if (surfaceToToken.has(norm)) continue; // duplicate value — first wins
    surfaceToToken.set(norm, token);
    entries.push({ token, value: value.trim() });
  }

  if (skipped.length > 0 && onWarn) {
    const detail = skipped
      .map(s => `${s.token} ${redact(s.value)} (${s.reason})`)
      .join(', ');
    onWarn(
      `dehydration: ${skipped.length} catalog value(s) too short/common to ` +
      `match safely — these remain in outbound text: ${detail}`,
    );
  }

  // Longest-value-first: JS alternation is ordered, so sorting branches
  // by length descending guarantees the longer value wins when two
  // start at the same position.
  entries.sort((a, b) => b.value.length - a.value.length);

  // Unicode lookaround boundaries instead of \b: correct for values
  // with non-word edges (emails, phone numbers). Boundaries live INSIDE
  // each branch so CJK-edged values can opt out per side (see CJK_EDGE).
  const pattern = entries.length > 0
    ? `(?:${entries.map(e => valueToBranch(e.value)).join('|')})`
    : null;

  // Word-level PII set for word-cue withholding: every whitespace-split
  // word of every eligible value, filtered through the same skip rules
  // ("of" inside "Bank of America" must not drop the word "of"
  // everywhere). Over-dropping only costs a cue; under-dropping ships
  // a name to the provider.
  const piiWords = new Set<string>();
  for (const e of entries) {
    for (const w of e.value.split(/\s+/)) {
      if (!classifySkip(w)) piiWords.add(w.toLowerCase());
    }
  }

  const compile = (): RegExp | null =>
    pattern ? new RegExp(pattern, 'giu') : null;

  function dehydrate(text: string): DehydrationResult {
    const unchanged: DehydrationResult = {
      text,
      spans: [],
      introduced: new Set(),
      changed: false,
      mapOffset: (o) => o,
    };
    if (!pattern || !text) return unchanged;
    try {
      const re = compile()!;
      const spans: DehydrationSpan[] = [];
      const introduced = new Set<string>();
      let out = '';
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const matched = m[0];
        const token = surfaceToToken.get(normalizeSurface(matched));
        if (token === undefined) {
          // Shouldn't happen (every branch came from an entry), but if
          // normalization ever disagrees, fail open on this match.
          continue;
        }
        out += text.slice(last, m.index);
        spans.push({
          origStart: m.index,
          origEnd: m.index + matched.length,
          outStart: out.length,
          outEnd: out.length + token.length,
          token,
          matched,
        });
        out += token;
        introduced.add(token);
        last = m.index + matched.length;
      }
      if (spans.length === 0) return unchanged;
      out += text.slice(last);

      const mapOffset = (origOffset: number, bias: 'left' | 'right' = 'left'): number => {
        let delta = 0;
        for (const s of spans) {
          if (origOffset <= s.origStart) break;
          if (origOffset < s.origEnd) {
            // Inside a replaced value — snap to the token boundary.
            return bias === 'right' ? s.outEnd : s.outStart;
          }
          delta += (s.outEnd - s.outStart) - (s.origEnd - s.origStart);
        }
        return origOffset + delta;
      };

      return { text: out, spans, introduced, changed: true, mapOffset };
    } catch (err) {
      // Total by contract: fail open per source (the dispatchChat floor
      // still scrubs), but never silently.
      onWarn?.(`dehydration: internal error, sending text unmodified (floor still active): ${String(err)}`);
      return unchanged;
    }
  }

  function isPiiWord(word: string): boolean {
    if (!word) return false;
    // Strip possessive + edge punctuation the way typed words carry it.
    const stripped = word
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/(?:'s|’s)$/i, '')
      .replace(/[^\p{L}\p{N}]+$/u, '');
    if (!stripped) return false;
    return piiWords.has(stripped.toLowerCase());
  }

  return { dehydrate, isPiiWord, skipped, size: entries.length };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-catalog cache
// ───────────────────────────────────────────────────────────────────────────

/**
 * `ConfigLoader.load()` builds a fresh `Identity.catalog` Map instance
 * per hot reload, so keying on the Map instance recompiles exactly when
 * IDENTITY.md changes — every source, AgentRewrite, and the dispatch
 * floor share one compiled matcher per config generation.
 */
const dehydratorCache = new WeakMap<ReadonlyMap<string, string>, CompiledDehydrator>();

export function getDehydrator(
  catalog: ReadonlyMap<string, string>,
  onWarn?: (msg: string) => void,
): CompiledDehydrator {
  const hit = dehydratorCache.get(catalog);
  if (hit) return hit;
  const compiled = compileDehydrator(catalog, onWarn);
  dehydratorCache.set(catalog, compiled);
  return compiled;
}
