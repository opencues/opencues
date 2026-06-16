/**
 * Token-integration — given a user's buffer (with `_`) and a runtime-
 * resolved SUBSTITUTE (a catalog token's real value), decide what part
 * of the buffer to replace and what to splice in its place. The whole
 * decision lives in one LLM call; no regex heuristics, no separate
 * polish step.
 *
 * Replaces the legacy `determineReplaceMode` regex (FILL vs WIPE) plus
 * the post-hoc polish step. The LLM owns intent recognition (sentence-
 * with-slot vs lookup question vs conversational continuation) AND
 * formatting fitness (label dropping, precision matching, etc.) in one
 * place. See `token-integration-plan.md` for the design rationale.
 *
 * Pure module: takes a `dispatchChat`-shaped function. No provider
 * coupling. The runtime decides WHEN to invoke this; this module
 * decides WHAT to send + validates the response.
 *
 * Failure handling: if the LLM's REPLACE doesn't appear verbatim in the
 * buffer OR doesn't contain `_`, the result falls back to replacing
 * just `_` with the raw SUBSTITUTE. This is the cheapest-and-safest
 * default — the substitute lands at the intended slot without risk of
 * the LLM eating prose it shouldn't.
 */

const CONTEXT_KEY_TAIL_CHARS = 32;
const TOKEN_INTEGRATION_CACHE_MAX = 256;
const BUFFER_MIN_CHARS = 2;

export interface TokenIntegrationRequest {
  /** The user's full buffer text containing `_`. */
  buffer: string;
  /** The post-processed substitute — a `[TOKEN]` already resolved to
   *  its real value (e.g. "NVDA: $212.45"). */
  substitute: string;
  /** Optional per-source nudge — passed verbatim into the prompt. */
  hint?: string;
}

export interface TokenIntegrationResult {
  /** Substring of `buffer` to replace. Always contains `_`. On
   *  validation failure / fallback, falls back to "_" verbatim. */
  replace: string;
  /** Text to put in `replace`'s place. On fallback, equals the raw
   *  `substitute`. */
  with_: string;
  /** Whether the LLM ran. False on cache hit, short-buffer skip, or
   *  short-substitute skip. */
  llmCalled: boolean;
  /** Why the result is what it is. Used for telemetry + per-host logs. */
  reason:
    | 'cache-hit'
    | 'skipped-short-buffer'
    | 'skipped-no-underscore'
    | 'integrated'
    | 'fallback-not-substring'
    | 'fallback-no-underscore'
    | 'fallback-empty'
    | 'fallback-bad-format'
    | 'fallback-dispatch-error';
}

/**
 * Dispatch shim — caller-injected to keep this module decoupled from
 * the provider layer. Returns the raw assistant text, OR throws (treated
 * as `fallback-dispatch-error`).
 */
export type TokenIntegrationDispatch = (system: string, user: string) => Promise<string>;

/**
 * Higher-level runner — what callers (FluidBlankSource today, BlankFill
 * in a follow-up PR) actually invoke. boot-common builds the dispatch
 * + cache once and injects this shape downstream.
 */
export type TokenIntegrationRunner = (req: TokenIntegrationRequest) => Promise<TokenIntegrationResult>;

/**
 * Build the system prompt. Static — every per-call detail goes into
 * the user message. Cerebras prefix-cache hits on this constant.
 */
export function buildTokenIntegrationSystemPrompt(): string {
  return `You decide how a tool-resolved value should be integrated into a user's text buffer.

You receive two inputs in the USER message:
  BUFFER:     the user's text, which contains an underscore (\`_\`) marking where data should land
  SUBSTITUTE: the data the runtime resolved from a catalog token in a prior LLM call (e.g. "NVDA: $212.45", "France capital: Paris")

Your job: produce two strings.
  REPLACE: a verbatim substring of BUFFER that includes \`_\`. The runtime will swap this substring out.
  WITH:    the text that goes in REPLACE's place.

Think about BUFFER's intent:

  A) Sentence with a slot — the user wrote a sentence and \`_\` is one position in it.
     Examples: "NVDA is at _", "the price is _", "Hi team, NVDA: _ today"
     → REPLACE = "_" only
     → WITH = the value, formatted to fit the surrounding prose (drop redundant labels, match precision)

  B) Lookup question — the user wrote a question/phrase whose only purpose is to retrieve the answer.
     Examples: "whats nvda stock price _", "capital of france _", "current weather _"
     → REPLACE = the whole question
     → WITH = just the answer (no label, no redundant prefix)

  C) Conversational continuation — the user is mid-thought and \`_\` is where a fuller phrase should go.
     Examples: "Tell me about NVDA — _", "I was thinking about _"
     → REPLACE = "_" only
     → WITH = a natural-prose phrase that fits the sentence flow

Then format SUBSTITUTE naturally into WITH:
  - If BUFFER already names the entity (label "NVDA:" when prose says "NVDA is at"), drop the redundant label
  - Match precision: if surrounding prose uses whole dollars, truncate cents; if it uses cents, keep them
  - Trim metadata that doesn't add value in the surrounding context (HN's "(412 points)" in conversational prose)
  - Preserve all information SUBSTITUTE supplies that the prose does NOT (don't drop the price just because the prose says "stock")

STRICT RULES:
  1. REPLACE MUST be a verbatim substring of BUFFER and MUST contain \`_\`. If you're uncertain about either, output REPLACE = "_" exactly.
  2. WITH must preserve the underlying VALUES from SUBSTITUTE. Truncating "$212.45" to "$212" is fine when prose justifies it; rounding to "$213" is forbidden.
  3. Don't invent values, don't drop information the prose doesn't already supply.
  4. Output EXACTLY two labelled lines, NOTHING else:
       REPLACE: <substring>
       WITH: <replacement>`;
}

export function buildTokenIntegrationUserMessage(req: TokenIntegrationRequest): string {
  const parts: string[] = [];
  parts.push(`BUFFER: ${req.buffer}`);
  parts.push(`SUBSTITUTE: ${req.substitute}`);
  if (req.hint) parts.push(`HINT: ${req.hint}`);
  return parts.join('\n');
}

/**
 * Parse the LLM's labelled-line output. Both labels MUST be present;
 * either missing → null (caller falls back to default replacement).
 *
 * Robust to trailing whitespace, blank lines, and (some) drift like the
 * model wrapping REPLACE in quotes. Conservative on parse — if the LLM
 * adds chatter before/after the labelled lines, we bail to fallback
 * rather than guess.
 */
export function parseTokenIntegrationOutput(raw: string): { replace: string; with_: string } | null {
  // Line-based parse — more robust than a multiline regex against the
  // model adding trailing whitespace, wrapping quotes, or putting WITH:
  // on its own line followed by multi-line content.
  const lines = raw.split('\n');
  let replace: string | null = null;
  const withLines: string[] = [];
  let collectingWith = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('REPLACE:')) {
      replace = trimmed.slice('REPLACE:'.length).trim();
      collectingWith = false;
    } else if (trimmed.startsWith('WITH:')) {
      withLines.push(trimmed.slice('WITH:'.length).trim());
      collectingWith = true;
    } else if (collectingWith) {
      withLines.push(line); // keep original indentation for multi-line WITH
    }
  }
  if (replace === null || withLines.length === 0) return null;
  // Strip wrapping quotes the model sometimes adds.
  replace = stripWrappingQuotes(replace);
  const with_ = stripWrappingQuotes(withLines.join('\n').trim());
  if (!replace) return null;
  return { replace, with_ };
}

function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Bounded LRU cache (same shape as integration-pass).
 */
class TokenIntegrationCache {
  private store = new Map<string, { replace: string; with_: string }>();
  constructor(private readonly max: number = TOKEN_INTEGRATION_CACHE_MAX) {}

  get(key: string): { replace: string; with_: string } | undefined {
    const v = this.store.get(key);
    if (v === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, v);
    return v;
  }

  set(key: string, value: { replace: string; with_: string }): void {
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

export { TokenIntegrationCache };

export function makeTokenIntegrationCache(max: number = TOKEN_INTEGRATION_CACHE_MAX): TokenIntegrationCache {
  return new TokenIntegrationCache(max);
}

export function makeTokenCacheKey(req: TokenIntegrationRequest): string {
  // Slice buffer to a `_`-centred window: the LAST 32 chars BEFORE `_`
  // and the FIRST 32 chars AFTER. Long-prefix changes far from `_`
  // don't bust the cache. The substitute + hint are full-keyed.
  const idx = req.buffer.lastIndexOf('_');
  let window: string;
  if (idx < 0) {
    window = req.buffer.slice(-CONTEXT_KEY_TAIL_CHARS);
  } else {
    const before = req.buffer.slice(Math.max(0, idx - CONTEXT_KEY_TAIL_CHARS), idx);
    const after = req.buffer.slice(idx + 1, idx + 1 + CONTEXT_KEY_TAIL_CHARS);
    window = before + '_' + after;
  }
  return `${window}␟${req.substitute}␟${req.hint ?? ''}`;
}

/**
 * Default fallback — replace just `_` with the raw substitute. Used
 * when validation fails, when the LLM errors out, when the input is too
 * short to bother with, etc. Always safe.
 */
function defaultFallback(req: TokenIntegrationRequest, reason: TokenIntegrationResult['reason']): TokenIntegrationResult {
  return {
    replace: '_',
    with_: req.substitute,
    llmCalled: reason === 'integrated' || reason === 'fallback-not-substring' || reason === 'fallback-no-underscore' || reason === 'fallback-empty' || reason === 'fallback-bad-format' || reason === 'fallback-dispatch-error',
    reason,
  };
}

/**
 * Main entry point.
 *
 * Flow:
 *  1. Sanity-check the buffer (too short / no `_` → skip without LLM)
 *  2. Cache lookup
 *  3. Dispatch the LLM
 *  4. Parse + validate the response
 *  5. On any validation failure, return the default fallback
 */
export async function runTokenIntegration(
  req: TokenIntegrationRequest,
  dispatch: TokenIntegrationDispatch,
  cache: TokenIntegrationCache,
): Promise<TokenIntegrationResult> {
  // Sanity: buffer too short for any LLM call to be worthwhile.
  if (req.buffer.length < BUFFER_MIN_CHARS) {
    return { replace: '_', with_: req.substitute, llmCalled: false, reason: 'skipped-short-buffer' };
  }
  if (!req.buffer.includes('_')) {
    return { replace: '_', with_: req.substitute, llmCalled: false, reason: 'skipped-no-underscore' };
  }

  // Cache lookup.
  const cacheKey = makeTokenCacheKey(req);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return { ...cached, llmCalled: false, reason: 'cache-hit' };
  }

  // Dispatch.
  let raw: string;
  try {
    raw = await dispatch(buildTokenIntegrationSystemPrompt(), buildTokenIntegrationUserMessage(req));
  } catch {
    return defaultFallback(req, 'fallback-dispatch-error');
  }
  if (!raw || !raw.trim()) {
    return defaultFallback(req, 'fallback-empty');
  }

  // Parse.
  const parsed = parseTokenIntegrationOutput(raw);
  if (!parsed) {
    return defaultFallback(req, 'fallback-bad-format');
  }

  // Validate.
  if (!req.buffer.includes(parsed.replace)) {
    return defaultFallback(req, 'fallback-not-substring');
  }
  if (!parsed.replace.includes('_')) {
    return defaultFallback(req, 'fallback-no-underscore');
  }

  cache.set(cacheKey, { replace: parsed.replace, with_: parsed.with_ });
  return {
    replace: parsed.replace,
    with_: parsed.with_,
    llmCalled: true,
    reason: 'integrated',
  };
}

// ============================================================================
// Rewrite polish — sibling pass for whole-buffer rewrites
// ============================================================================
//
// The splice-shape runTokenIntegration above always falls back when the
// SUBSTITUTE is the whole-buffer rewrite (no `_` in the substitute → no
// valid REPLACE substring containing `_`). Polish handles that case: the
// FUSED LLM has already produced the rewrite with sentinels inlined; this
// second pass refines prose so resolved data values are integrated
// naturally rather than just dropped in.
//
// Different shape from splice:
//   - Input: (instruction, rewrite) — no buffer, no substitute.
//   - Output: KEEP (unchanged) OR POLISHED: <text>.
//   - Cache: separate LRU keyed on (instruction, rewrite-head+tail).
//   - Failure mode: return the original rewrite unchanged.

const REWRITE_HEAD_CHARS = 96;
const REWRITE_TAIL_CHARS = 96;
const REWRITE_POLISH_MIN_CHARS = 40;
const REWRITE_POLISH_CACHE_MAX = 128;

export interface RewritePolishRequest {
  /** What the user asked transform-blank to do (e.g. "make the email
   *  about apple too", "draft a stock update"). Lets the polisher
   *  understand intent without re-deriving it. */
  instruction: string;
  /** The post-processor's rewrite — sentinels already substituted to
   *  their resolved values. */
  rewrite: string;
}

export interface RewritePolishResult {
  /** Either the original rewrite (unchanged / KEEP) or the polished version. */
  rewrite: string;
  llmCalled: boolean;
  reason:
    | 'cache-hit'
    | 'skipped-short-rewrite'
    | 'polished'
    | 'unchanged'
    | 'fallback-empty'
    | 'fallback-bad-format'
    | 'fallback-dispatch-error';
}

export type RewritePolishRunner = (req: RewritePolishRequest) => Promise<RewritePolishResult>;

export function buildRewritePolishSystemPrompt(): string {
  return `You refine a freshly-generated rewrite so any data values resolved from a catalog (stock prices, weather, identity fields, etc.) are integrated naturally into the prose.

You receive two inputs in the USER message:
  INSTRUCTION: what the user asked the runtime to produce
  REWRITE:     the runtime's current draft, with resolved values already spliced in

Your only job: ensure resolved values feel WOVEN into the writing rather than dropped in awkwardly. Examples:

  Awkward:  "NVDA is trading. The price is $212.45. The team should know."
  Natural:  "NVDA is trading at $212.45 — the team should know."

  Awkward:  "Subject: Stock Update\\n\\nHi team,\\nAAPL: $296.42\\nNVDA: $212.45\\n\\nRegards"
  Natural:  "Subject: Stock Update\\n\\nHi team,\\n\\nAAPL is at $296.42 and NVDA at $212.45.\\n\\nRegards"

  Already natural:  "Hi team — quick note that NVDA closed at $212.45 today."
  → No change needed.

STRICT RULES:
  1. PRESERVE every resolved data value VERBATIM. Truncating cents is OK if the surrounding prose justifies it (whole-dollar context). Rounding (changing $212.45 → $213) is FORBIDDEN.
  2. PRESERVE the rewrite's overall structure, tone, and intent. You are polishing prose, not regenerating the response.
  3. DO NOT add new facts, new sentences with new claims, or new data.
  4. DO NOT shorten aggressively. If the rewrite is already natural, output KEEP.
  5. DO NOT add disclaimers, caveats, or commentary.

Output one of EXACTLY two shapes, NOTHING else:

  Shape A — rewrite is already naturally integrated (preferred when possible):
    KEEP

  Shape B — rewrite needs polish:
    POLISHED:
    <the full polished rewrite, multi-line allowed>

Choose KEEP whenever in doubt — a needless polish is worse than no polish.`;
}

export function buildRewritePolishUserMessage(req: RewritePolishRequest): string {
  return `INSTRUCTION: ${req.instruction}\nREWRITE:\n${req.rewrite}`;
}

/**
 * Parse polish output. KEEP → null (caller uses the original rewrite).
 * POLISHED: <body> → returns the body (multi-line preserved).
 */
export function parseRewritePolishOutput(raw: string): { kept: true } | { kept: false; rewrite: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // KEEP — exact single-token response (allow trailing comments).
  if (/^KEEP\s*$/i.test(trimmed) || /^KEEP\b/i.test(trimmed.split('\n')[0]!.trim())) {
    return { kept: true };
  }
  // POLISHED: <body>
  const lines = trimmed.split('\n');
  let bodyStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^POLISHED:\s*/i.test(lines[i]!.trim())) {
      bodyStartIdx = i;
      break;
    }
  }
  if (bodyStartIdx < 0) return null;
  // Body is whatever comes after POLISHED: — either inline on same line
  // or starting on the next line.
  const firstLineRest = lines[bodyStartIdx]!.replace(/^\s*POLISHED:\s*/i, '');
  const rest = lines.slice(bodyStartIdx + 1);
  const body = (firstLineRest ? [firstLineRest, ...rest] : rest).join('\n').trim();
  if (!body) return null;
  return { kept: false, rewrite: body };
}

class RewritePolishCache {
  private store = new Map<string, { kept: boolean; rewrite: string }>();
  constructor(private readonly max: number = REWRITE_POLISH_CACHE_MAX) {}
  get(key: string): { kept: boolean; rewrite: string } | undefined {
    const v = this.store.get(key);
    if (v === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, v);
    return v;
  }
  set(key: string, value: { kept: boolean; rewrite: string }): void {
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

export { RewritePolishCache };

export function makeRewritePolishCache(max: number = REWRITE_POLISH_CACHE_MAX): RewritePolishCache {
  return new RewritePolishCache(max);
}

export function makeRewritePolishCacheKey(req: RewritePolishRequest): string {
  const r = req.rewrite;
  const head = r.slice(0, REWRITE_HEAD_CHARS);
  const tail = r.length > REWRITE_HEAD_CHARS ? r.slice(-REWRITE_TAIL_CHARS) : '';
  return `${req.instruction}␟${head}␟${tail}␟${r.length}`;
}

export async function runRewritePolish(
  req: RewritePolishRequest,
  dispatch: TokenIntegrationDispatch,
  cache: RewritePolishCache,
): Promise<RewritePolishResult> {
  if (req.rewrite.length < REWRITE_POLISH_MIN_CHARS) {
    return { rewrite: req.rewrite, llmCalled: false, reason: 'skipped-short-rewrite' };
  }

  const cacheKey = makeRewritePolishCacheKey(req);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return { rewrite: cached.rewrite, llmCalled: false, reason: 'cache-hit' };
  }

  let raw: string;
  try {
    raw = await dispatch(buildRewritePolishSystemPrompt(), buildRewritePolishUserMessage(req));
  } catch {
    return { rewrite: req.rewrite, llmCalled: true, reason: 'fallback-dispatch-error' };
  }
  if (!raw || !raw.trim()) {
    return { rewrite: req.rewrite, llmCalled: true, reason: 'fallback-empty' };
  }

  const parsed = parseRewritePolishOutput(raw);
  if (parsed === null) {
    return { rewrite: req.rewrite, llmCalled: true, reason: 'fallback-bad-format' };
  }

  if (parsed.kept) {
    cache.set(cacheKey, { kept: true, rewrite: req.rewrite });
    return { rewrite: req.rewrite, llmCalled: true, reason: 'unchanged' };
  }

  cache.set(cacheKey, { kept: false, rewrite: parsed.rewrite });
  return { rewrite: parsed.rewrite, llmCalled: true, reason: 'polished' };
}

/** Test-only constants export for unit-test introspection. */
export const __testing = {
  CONTEXT_KEY_TAIL_CHARS,
  TOKEN_INTEGRATION_CACHE_MAX,
  BUFFER_MIN_CHARS,
  REWRITE_HEAD_CHARS,
  REWRITE_TAIL_CHARS,
  REWRITE_POLISH_MIN_CHARS,
  REWRITE_POLISH_CACHE_MAX,
};
