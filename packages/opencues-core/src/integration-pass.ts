/**
 * Integration pass — polish a blank's raw substituted value to fit the
 * surrounding prose context with a single LLM call.
 *
 * Example: stocks blank returns "$254.00"; user's surrounding prose uses
 * whole-dollar formatting ("NVIDIA is at ___"). The integration pass
 * returns "$254". Without it, the user has to manually edit every blank
 * substitution that doesn't match their prose conventions.
 *
 * Designed as a pure module — takes a `dispatchChat`-shaped function as
 * input, returns the polished string. No runtime dependencies, no host
 * coupling. The runtime BlankFill module decides WHEN to invoke this;
 * this module decides WHAT to send to the LLM and validates the response.
 *
 * Validator: extracts numeric tokens from input + output; rejects if the
 * set differs (the LLM hallucinated a different number). Validators
 * never invent values silently — when rejected, callers keep the raw
 * substitute. The integration pass is a strict polish-or-passthrough,
 * never a transform.
 *
 * Cache: LRU keyed by (substituted, context-before-tail, context-after-
 * head, hint). Bounded at INTEGRATION_CACHE_MAX entries. Cache hits return
 * synchronously with no LLM call.
 *
 * Design context: see `identity-dehydration-plan.md § Idea 2`.
 */

const CONTEXT_WINDOW_CHARS = 300;
const CONTEXT_KEY_TAIL_CHARS = 32;
const INTEGRATION_CACHE_MAX = 256;
// Min substitute length to consider for polish. Calibrated against real
// blank outputs: stocks "$254.00" (7), crypto "$98,420" (7), weather
// "14°C, overcast" (14). Anything ≥ 4 chars goes through; below that the
// polish payoff is too small to justify the round-trip.
const SUBSTITUTE_MIN_CHARS = 4;

/**
 * Inputs to one integration call. The caller has already extracted
 * `contextBefore` / `contextAfter` from the buffer around the substitute
 * region — each capped at CONTEXT_WINDOW_CHARS by the caller.
 */
export interface IntegrationRequest {
  /** The blank's raw substitute value, verbatim. */
  substituted: string;
  /** Up to ~300 chars of buffer prose before the substitute region. */
  contextBefore: string;
  /** Up to ~300 chars of buffer prose after the substitute region. */
  contextAfter: string;
  /** Optional per-blank hint from BLANK.md (`integrate-hint:`). */
  hint?: string;
}

export interface IntegrationResult {
  /** Polished string, OR the original substitute if validation failed
   *  or the gate decided to skip. */
  polished: string;
  /** Whether the LLM ran. False when a cache hit, gate skipped, or
   *  the substitute was returned verbatim. */
  llmCalled: boolean;
  /** Whether the polish was accepted. False when the validator rejected
   *  the LLM output and we fell back to the raw substitute. */
  accepted: boolean;
  /** Why the result is what it is — for telemetry + debug logs. */
  reason:
    | 'cache-hit'
    | 'skipped-short'
    | 'skipped-no-format-hint'
    | 'polished'
    | 'verbatim-from-llm'
    | 'rejected-numeric-drift'
    | 'rejected-empty'
    | 'rejected-dispatch-error';
}

/**
 * Tells us if the substitute is worth running through polish at all.
 * Permissive by design — the polish LLM itself decides if there's
 * anything to do, returning verbatim when no change is needed. This
 * gate exists only to avoid wasting an LLM call on trivially short
 * substitutes (single words, short ack-shaped answers like "yes" /
 * "Paris" / "8" / "OK").
 *
 * Rule: fire on any substitute that's plausibly polish-able — has
 * multiple words, or contains digits (so number formatting can help),
 * or contains structural markers (`:`, `(...)`, currency/units). Pure
 * single-token prose answers ("Paris", "astonishment", "OK") skip
 * because the source LLM already produced its preferred shape and
 * there's nothing for polish to do.
 *
 * The previous version of this gate was narrowly designed around
 * currency/temp/percent symbols — too restrictive once polish moved
 * past "stocks" into general blank-substitute fitting (countries
 * blank's "67000000" bare integer was being skipped, leaving the
 * buffer with unformatted prose). Bias toward firing.
 */
export function hasFormatHint(
  contextBefore: string,
  contextAfter: string,
  substituted: string = '',
): boolean {
  const sub = substituted.trim();
  if (!sub) return false;
  // Multi-word substitute — polish has surface to work with (label
  // dropping, prose-style matching, brevity adjustment).
  if (/\s/.test(sub)) return true;
  // Contains digits — number formatting (comma insertion, magnitude
  // suffix, decimal truncation) is a polish candidate. Catches bare
  // integers like "67000000" → "67 million".
  if (/\d/.test(sub)) return true;
  // Structural punctuation in the substitute — `:` labels, `()`
  // metadata, currency/units. Polish often trims these.
  if (/[:(,$£€¥₹%°]/.test(sub)) return true;
  // Single bare token (no spaces, no digits, no structural marks) —
  // e.g. "Paris", "astonishment", "OK". Source LLM already produced
  // its preferred shape; polish has nothing to act on.
  return false;
}

/**
 * Extract numeric tokens for the integrity check. Captures:
 *   - integers + decimals: 254, 254.00, 1,234.50
 *   - magnitude suffixes:  1.2k, 5M, 3.4B
 *   - percentages:         50%, 99.5%
 *   - dates of common shape: 2026-06-15
 *   - currency-prefixed:   $254, £99, €1.50
 *
 * Returns a CANONICAL form for comparison — strips commas, trailing zeros
 * after the decimal, and currency/percent suffixes — so "254.00" and
 * "254" canonicalise to the same string. The polish is allowed to
 * reformat; what it cannot do is change the underlying value.
 */
export function extractNumericTokens(s: string): string[] {
  const tokens: string[] = [];
  // Currency-prefixed numbers: $254.00, £1,234.50, €99
  for (const m of s.matchAll(/[$£€¥₹]\s*-?\d{1,3}(?:,\d{3})*(?:\.\d+)?[kKmMbB]?/g)) {
    tokens.push(canonicaliseNumber(m[0]));
  }
  // Magnitude suffixes: 1.2k, 5M, 3.4B — captured separately from currency
  // so a $-less "1.2k followers" still validates.
  for (const m of s.matchAll(/(?<![$£€¥₹])\b-?\d+(?:\.\d+)?[kKmMbB]\b/g)) {
    tokens.push(canonicaliseNumber(m[0]));
  }
  // Percentages: 50%, 99.5%
  for (const m of s.matchAll(/-?\d+(?:\.\d+)?%/g)) {
    tokens.push(canonicaliseNumber(m[0]));
  }
  // ISO-style dates: 2026-06-15
  for (const m of s.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    tokens.push(m[0]);
  }
  // English magnitude words ("67 million", "1.2 thousand") → canonical
  // single-letter form ("67m", "1.2k"). Lets the validator compare
  // numeric values across English-prose and shorthand notations.
  for (const m of s.matchAll(/\b(-?\d+(?:\.\d+)?)\s+(thousand|million|billion|trillion)\b/gi)) {
    const word = m[2].toLowerCase();
    const letter = word === 'thousand' ? 'k' : word[0];
    tokens.push(canonicaliseNumber(`${m[1]}${letter}`));
  }
  // Bare numbers — three shapes:
  //   (a) Comma-grouped: "1,234,567" → tokenises whole grouped number
  //   (b) Bare integer of any length: "67000000" → tokenises as one
  //   (c) Decimal: "212.45" → tokenises as one
  // Look-AHEAD rejects digits/dots so we don't capture "5" out of
  // "5.5%" or "1" out of "1.2k"; look-BEHIND rejects digits + currency
  // to avoid double-counting prefixed forms.
  for (const m of s.matchAll(/(?<![$£€¥₹\d.,-])\b-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\b(?![%kKmMbB.\d-])/g)) {
    tokens.push(canonicaliseNumber(m[0]));
  }
  // De-dup but preserve order (first-occurrence wins).
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function canonicaliseNumber(raw: string): string {
  // Strip currency prefix + percent suffix; keep magnitude suffix
  // (1.2k ≠ 1200 — they LOOK equal but the polish is allowed to
  // turn "1200" into "1.2k" as a stylistic call).
  let s = raw.replace(/[$£€¥₹]/g, '').replace(/%/g, '').trim();
  s = s.replace(/,/g, '');
  // Drop trailing zeros after decimal: 254.00 → 254
  if (s.includes('.')) {
    s = s.replace(/\.?0+([kKmMbB]?)$/, '$1');
  }
  // Lowercase magnitude suffix for comparison stability.
  s = s.toLowerCase();
  return s;
}

/**
 * Build the system prompt. Kept short — the cerebras prefix-cache wants
 * a stable system block, but the per-call context (CONTEXT_BEFORE /
 * SUBSTITUTED / CONTEXT_AFTER / BLANK_HINT) belongs in the user message
 * because it's per-call binding context, not session-stable. Same
 * pattern as the fluid-blank-ambient bench's findings.
 */
export function buildIntegrationSystemPrompt(): string {
  return `Given the TEXT and a piece of new DATA, decide how the DATA should be integrated into the TEXT naturally. Produce just the polished DATA — the runtime drops it in place of the user's underscore (\`_\`) for you.

You receive four labelled inputs from the USER message:
  CONTEXT_BEFORE: the prose the user typed before the underscore
  SUBSTITUTED:    the raw DATA the blank source produced
  CONTEXT_AFTER:  the prose after the underscore
  BLANK_HINT:     optional hint about the source

Think about what a thoughtful human writer would do here. Look at the text's style, what it already says, what it expects to land. Then decide how DATA should look so it reads naturally in that context.

There's no single rule. Sometimes the answer is just a value ("Paris"). Sometimes it's a labelled value ("Capital: Paris"). Sometimes the data needs reformatting — adding commas to a long number, truncating cents to match casual prose, dropping a parenthetical metadata count, expanding a terse marker to a fuller phrase, or leaving the data exactly as the source produced it. Read the text. Read the data. Decide.

Common patterns (NOT exhaustive — use your judgment):
  - Text already supplies the entity name → drop the redundant label in the data
  - Text uses casual whole-number prose → consider truncating decimals
  - Text is technical / tabular / a ledger → keep precision; keep labels
  - Text is a tweet / chat / sign-off → favour brevity
  - Text reads like a sentence with a single fact-slot → produce a single value
  - Text expects multiple slots of information → keep more of the data

Constraints:
  1. Preserve every value's meaning. Truncating "212.45" to "212" is fine when prose justifies it; rounding "212.45" to "213" is not.
  2. Preserve named identifiers (tickers, places, URLs, brands, headlines). You may move them around or drop redundant copies, but never change them.
  3. Preserve information the surrounding text doesn't already supply. Don't drop the temperature just because the prose says "weather"; don't drop the answer just because the user typed "define X".
  4. If the DATA already reads naturally in the TEXT, OR you're uncertain a change would help, return SUBSTITUTED verbatim.
  5. Output ONE LINE: just the polished DATA. No labels, no commentary, no quotes, no markdown.`;
}

export function buildIntegrationUserMessage(req: IntegrationRequest): string {
  const parts: string[] = [];
  parts.push(`CONTEXT_BEFORE: ${req.contextBefore || '(empty)'}`);
  parts.push(`SUBSTITUTED: ${req.substituted}`);
  parts.push(`CONTEXT_AFTER: ${req.contextAfter || '(empty)'}`);
  parts.push(`BLANK_HINT: ${req.hint || '(empty)'}`);
  return parts.join('\n');
}

/**
 * The dispatch shim — caller-injected because llm-provider.dispatchChat
 * has a verbose ctx signature that varies by call site. Keep this module
 * decoupled from the provider layer.
 *
 * Returns the raw assistant text, OR throws — we treat throw as
 * rejected-dispatch-error (and the runtime keeps the raw substitute).
 */
export type IntegrationDispatch = (system: string, user: string) => Promise<string>;

/**
 * Higher-level runner type — what callers (BlankFill, FluidBlank,
 * TransformBlank) actually invoke once boot-common has built the
 * dispatch + cache pair. The runtime owns the runner instance; sources
 * receive it as an optional dependency so the integration gate is
 * structurally opt-out by leaving the runner undefined.
 *
 * Single canonical type used everywhere instead of re-declaring the
 * same callback shape in each call-site module.
 */
export type IntegrationPassRunner = (req: IntegrationRequest) => Promise<IntegrationResult>;

/**
 * Bounded LRU cache. Trivial Map-based impl: re-insertion on hit moves
 * key to end (Map iteration order is insertion order); cap-enforcement
 * deletes the oldest (first inserted) entry. Cheap, no deps.
 */
class IntegrationCache {
  private store = new Map<string, string>();
  constructor(private readonly max: number = INTEGRATION_CACHE_MAX) {}

  get(key: string): string | undefined {
    const v = this.store.get(key);
    if (v === undefined) return undefined;
    // Move to most-recently-used.
    this.store.delete(key);
    this.store.set(key, v);
    return v;
  }

  set(key: string, value: string): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void { this.store.clear(); }
  get size(): number { return this.store.size; }
}

export function makeCacheKey(req: IntegrationRequest): string {
  const beforeTail = req.contextBefore.slice(-CONTEXT_KEY_TAIL_CHARS);
  const afterHead = req.contextAfter.slice(0, CONTEXT_KEY_TAIL_CHARS);
  return `${req.substituted}␟${beforeTail}␟${afterHead}␟${req.hint ?? ''}`;
}

/**
 * Main entry point — passed the dispatch shim + the cache (callers can
 * share a single cache across many integration calls).
 *
 * Decision flow:
 *  1. SUBSTITUTED shorter than SUBSTITUTE_MIN_CHARS → skip (return raw).
 *  2. No format hint in surrounding prose → skip (return raw).
 *  3. Cache hit → return cached polished value.
 *  4. Cache miss → call dispatch.
 *  5. Validate dispatch result. On reject → return raw, record reason.
 *  6. On accept → cache + return polished.
 *
 * The caller (BlankFill) doesn't need to know any of this. It just gets
 * a string + a reason code.
 */
export async function runIntegrationPass(
  req: IntegrationRequest,
  dispatch: IntegrationDispatch,
  cache: IntegrationCache,
): Promise<IntegrationResult> {
  // Gate 1: short substitutes.
  if (req.substituted.length < SUBSTITUTE_MIN_CHARS) {
    return { polished: req.substituted, llmCalled: false, accepted: false, reason: 'skipped-short' };
  }
  // Gate 2: no format hint anywhere nearby OR in the substitute itself.
  if (!hasFormatHint(req.contextBefore, req.contextAfter, req.substituted)) {
    return { polished: req.substituted, llmCalled: false, accepted: false, reason: 'skipped-no-format-hint' };
  }
  // Gate 3: cache.
  const cacheKey = makeCacheKey(req);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return { polished: cached, llmCalled: false, accepted: true, reason: 'cache-hit' };
  }
  // Gate 4: dispatch.
  let raw: string;
  try {
    raw = await dispatch(buildIntegrationSystemPrompt(), buildIntegrationUserMessage(req));
  } catch {
    return { polished: req.substituted, llmCalled: true, accepted: false, reason: 'rejected-dispatch-error' };
  }
  const polished = raw.trim();
  if (!polished) {
    return { polished: req.substituted, llmCalled: true, accepted: false, reason: 'rejected-empty' };
  }
  // Gate 5: numeric-token validator. Reject on drift.
  const inputNums = extractNumericTokens(req.substituted);
  const outputNums = extractNumericTokens(polished);
  if (!numericTokensPreserved(inputNums, outputNums)) {
    return { polished: req.substituted, llmCalled: true, accepted: false, reason: 'rejected-numeric-drift' };
  }
  // Gate 6: short-circuit when the LLM returned the input verbatim.
  // Still a useful signal — the model decided the substitute was already
  // a good fit. Cache the verbatim result so future identical contexts
  // skip the LLM round-trip.
  cache.set(cacheKey, polished);
  if (polished === req.substituted) {
    return { polished, llmCalled: true, accepted: true, reason: 'verbatim-from-llm' };
  }
  return { polished, llmCalled: true, accepted: true, reason: 'polished' };
}

/**
 * Compare canonical forms of input and output numeric tokens for
 * VALUE EQUIVALENCE. Polish may reformat without changing meaning:
 *
 *   - DROP a number (e.g. drop "(412 points)" from a HN headline when
 *     conversational prose doesn't care about the upvote count)
 *   - TRUNCATE decimals ("212.45" → "212" when prose uses integers).
 *     The integer part of an input number is an acceptable truncation.
 *   - REFORMAT magnitude ("67000000" ↔ "67m" ↔ "67M" ↔ "67 million").
 *     All represent the same numerical magnitude; polish may choose
 *     whichever fits the prose style.
 *
 * NOT acceptable: an output number whose numeric value doesn't match
 * any input number (and isn't a legitimate truncation). That's a
 * hallucinated / rounded value.
 *
 * The check first tries direct canonical-string match (cheap), then
 * truncation, then magnitude-numeric-equivalence. Any pass on any
 * level accepts the token.
 */
export function numericTokensPreserved(input: string[], output: string[]): boolean {
  if (output.length === 0) return true; // Output may legitimately drop all numbers.

  // Build the acceptable canonical set + a numeric-value set for the
  // magnitude-equivalence check.
  const acceptableCanonical = new Set(input);
  const acceptableValues = new Set<number>();
  for (const t of input) {
    // Permit truncation: if input is a decimal without a magnitude
    // suffix, also accept the integer-part-only form.
    if (t.includes('.') && !/[kmbt]$/i.test(t)) {
      const intPart = t.split('.')[0];
      if (intPart) acceptableCanonical.add(intPart);
    }
    const v = canonicalNumericValue(t);
    if (v !== null) acceptableValues.add(v);
  }

  for (const t of output) {
    if (acceptableCanonical.has(t)) continue;
    const v = canonicalNumericValue(t);
    if (v !== null && acceptableValues.has(v)) continue;
    return false;
  }
  return true;
}

/**
 * Compute the numeric magnitude of a canonical token. Handles bare
 * numbers ("212", "212.45"), single-letter magnitude suffixes
 * ("1.2k", "67m"), and ISO dates (returns null — dates aren't
 * magnitude-comparable). Returns null when the token isn't a number.
 *
 * "67000000" → 67000000
 * "67m"      → 67000000  (same value)
 * "1.2k"     → 1200
 * "5b"       → 5_000_000_000
 * "212.45"   → 212.45
 * "2026-06-15" → null (date, not magnitude)
 */
function canonicalNumericValue(token: string): number | null {
  // ISO date — not a magnitude.
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return null;
  const m = token.match(/^(-?\d+(?:\.\d+)?)([kmbt])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] ?? '').toLowerCase();
  const mult = suffix === 't' ? 1e12 : suffix === 'b' ? 1e9 : suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return n * mult;
}

/** Public factory — callers create a single cache, share across invocations. */
export function makeIntegrationCache(max: number = INTEGRATION_CACHE_MAX): IntegrationCache {
  return new IntegrationCache(max);
}

export { IntegrationCache };

/**
 * Convenience for callers: slice context windows from the buffer
 * relative to a substitute region. Caps at CONTEXT_WINDOW_CHARS each
 * side. Pure — no buffer-state dependency.
 */
export function sliceContextWindows(
  buffer: string,
  substituteStart: number,
  substituteEnd: number,
): { contextBefore: string; contextAfter: string } {
  const beforeStart = Math.max(0, substituteStart - CONTEXT_WINDOW_CHARS);
  const afterEnd = Math.min(buffer.length, substituteEnd + CONTEXT_WINDOW_CHARS);
  return {
    contextBefore: buffer.slice(beforeStart, substituteStart),
    contextAfter: buffer.slice(substituteEnd, afterEnd),
  };
}

/** Test-only constants export for unit-test introspection. */
export const __testing = {
  CONTEXT_WINDOW_CHARS,
  CONTEXT_KEY_TAIL_CHARS,
  INTEGRATION_CACHE_MAX,
  SUBSTITUTE_MIN_CHARS,
};
