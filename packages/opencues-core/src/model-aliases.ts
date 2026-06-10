/**
 * opencues-core/model-aliases.ts
 *
 * Per-call LLM target override via a "with <model>" token in the buffer.
 *
 * Lets the user pin a specific provider/model for one fluid-blank or
 * transform-blank call without editing OPENCUES.md or going through
 * fluid-config's selector-satellite shape. The token is stripped from
 * the buffer that goes to the LLM, the dispatch uses the overridden
 * (provider, model), and the original bucket scalars stay untouched
 * — when the same user types another `_` without "with X", the call
 * goes through the normal bucket again. No "switch back" step is
 * needed because nothing was switched on disk.
 *
 * Trigger shape:
 *   `summarize this paragraph with opus _`
 *   `make this funnier with haiku _`
 *   `atomic number of oxygen with cerebras _`
 *
 * The token matcher accepts a small set of common aliases (opus / haiku
 * / sonnet / nano / flash / etc.) plus any registered provider id or
 * substring of a known model name. Unknown tokens cede — the call goes
 * through the bucket default and the buffer is passed through unchanged.
 *
 * Trust boundary: model-alias resolution is bounded by the FEATURES
 * provider registry (`listProviders()` + `knownModels`). The matcher
 * NEVER reads file paths, NEVER fetches URLs, NEVER consults user
 * blanks. A misbehaving buffer can only route to a provider/model the
 * registry already exposes. Same surface area as fluid-config classifier
 * intent without the side-effect of writing scalars.
 */

import { listProviders, getProvider } from './llm-provider';
import { isClaudeCliAvailable } from './providers/claude-cli-daemon';

export interface ModelOverride {
  /** The provider id to dispatch through (e.g. `'anthropic'`). */
  readonly provider: string;
  /** The model string to send (e.g. `'claude-opus-4-7'`). */
  readonly model: string;
  /** The token that matched, exactly as it appeared in the buffer. */
  readonly matchedToken: string;
  /** Char offset (inclusive) of the start of `with <token>` in source text. */
  readonly matchStart: number;
  /** Char offset (exclusive) of the end of `with <token>` in source text. */
  readonly matchEnd: number;
}

/**
 * Common shorthand aliases — bench-validated subset of the registry.
 * Provider-only aliases fall through to the provider's defaultModel
 * (so `with cerebras _` uses cerebras's gpt-oss-120b without the user
 * having to spell the model out).
 *
 * Lowercase keys. Values are (provider, optional model). When `model`
 * is undefined the provider's defaultModel is used.
 */
const COMMON_ALIASES: Record<string, { provider: string; model?: string }> = {
  opus: { provider: 'anthropic', model: 'claude-opus-4-7' },
  haiku: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  // Claude Fable 5 — Mythos-class model launched June 9, 2026. Routes
  // to the same `anthropic` adapter (the API exposes it under the
  // canonical `claude-fable-5` model id). Subscription users on the
  // `claude-code-cli` provider also get fable-5 through Anthropic's
  // free intro window (Pro/Max/Team/Enterprise, 2026-06-09 → 06-22);
  // the daemon's resolveModelFamily picks the right flag table.
  fable: { provider: 'anthropic', model: 'claude-fable-5' },
  claude: { provider: 'anthropic' },
  anthropic: { provider: 'anthropic' },
  cerebras: { provider: 'cerebras' },
  groq: { provider: 'groq' },
  openai: { provider: 'openai' },
  nano: { provider: 'openai', model: 'gpt-5.4-nano' },
  mini: { provider: 'openai', model: 'gpt-5.4-mini' },
  gemini: { provider: 'gemini' },
  flash: { provider: 'gemini' },
  openrouter: { provider: 'openrouter' },
  // gpt-oss appears on both cerebras and groq; cerebras is faster.
  'gpt-oss': { provider: 'cerebras', model: 'gpt-oss-120b' },
  // llama family lives on groq today (lower latency than openrouter).
  llama: { provider: 'groq' },
};

/**
 * Detect a `with <token>` model-override in the buffer text and resolve
 * it to a (provider, model) pair. Returns the LAST match in the buffer
 * — so `summarize with opus _ then with haiku` overrides to haiku (the
 * `with X` that's closest to the `_` is what the user is currently
 * editing). Returns null when no `with <token>` matches a known
 * alias / provider / model substring.
 *
 * The matcher is intentionally narrow: `with` must be a standalone
 * word and the token a single alphanumeric segment. `with the` /
 * `play with fire` won't match anything because `the` / `fire` don't
 * resolve to a provider.
 */
/**
 * Optional post-processor — if the override resolved to ANY Anthropic
 * model AND the local `claude` CLI is available, swap the provider to
 * `claude-code-cli` so the call goes through the user's Pro / Max /
 * Team / Enterprise subscription instead of paying for API tokens.
 *
 * Scope is "every anthropic-class override":
 *   - `with anthropic` / `with claude` (generic aliases → defaults to haiku)
 *   - `with opus` / `with sonnet` / `with haiku` / `with fable` (named models)
 *   - `with claude-fable-5` / `with claude-opus-4-7` etc. (full model ids)
 *
 * The model string carries through verbatim — the CLI's `--model` flag
 * accepts both Anthropic's full ids (`claude-opus-4-7`,
 * `claude-fable-5`) AND its built-in short aliases (`opus`, `sonnet`,
 * `haiku`). The daemon's `resolveModelFamily()` maps either form to
 * the right flag table.
 *
 * Falls back to the API path when:
 *   - `claude` isn't on PATH (binary missing) — checked once per
 *     process via `isClaudeCliAvailable()`. The override stays
 *     unchanged (anthropic/HTTP).
 *   - The `claude-code-cli` provider isn't in the registry (shouldn't
 *     happen on supported hosts).
 *
 * What this does NOT cover: runtime CLI failure. If the binary is
 * present but auth has expired, the model isn't on the user's
 * subscription tier, or the call rate-limits mid-session, the failure
 * surfaces to the source's existing override-skip path rather than
 * silently retrying against the API. Runtime fallback would need
 * explicit error classification (auth-expired vs tier-unavailable vs
 * transient-network vs real-LLM-error) and a session-level "CLI is
 * broken" cache. Tracked as a follow-up.
 *
 * Caller convention: invoke immediately after `detectModelOverride` and
 * before passing the override to `resolveOverride`. Both FluidBlank
 * and TransformBlank do this in their override-consumer paths.
 *
 * Why a separate function (vs. inlining in detectModelOverride): keeps
 * detectModelOverride pure (no I/O); makes the subscription-preference
 * policy a SEPARATE concern tests can exercise in isolation; lets
 * future call sites opt out cheaply if they want raw resolution.
 *
 * See: docs/architecture/model-override.md § Subscription preference.
 */
export type AnthropicSubscriptionMode = 'prefer' | 'only' | 'off';

export function applySubscriptionPreference(
  override: ModelOverride | null,
  mode: AnthropicSubscriptionMode = 'prefer',
): ModelOverride | null {
  if (!override) return null;
  // Global opt-out — the `anthropic-subscription: off` scalar in
  // OPENCUES.md flips this to 'off' and every anthropic-class
  // override skips the CLI rewrite, even on hosts where `claude` is
  // installed. Useful when comparing API behaviour deliberately or
  // when subscription TTFT hurts the workflow.
  if (mode === 'off') return override;
  // Only rewrite anthropic-class overrides. `with cerebras`,
  // `with gemini`, `with gpt-oss`, etc. keep their original provider
  // — the subscription only routes Anthropic models.
  if (override.provider !== 'anthropic') return override;
  const cliAdapter = getProvider('claude-code-cli');
  if (!cliAdapter) return override; // registry missing the CLI provider
  // Strict subscription-only mode: rewrite unconditionally. If the
  // CLI binary isn't actually on PATH the dispatch will fail at spawn
  // time with a clear "claude not found" error — that's the desired
  // behaviour for users who set `anthropic-subscription: only` as a
  // billing safety mode ("never silently spend API tokens"). The
  // alternative (falling back to API) would defeat the explicit
  // opt-in to strict subscription routing.
  if (mode === 'only') {
    return { ...override, provider: 'claude-code-cli' };
  }
  // Default `prefer`: rewrite when CLI is available, otherwise leave
  // the override on the HTTP API path. Model string passes through
  // verbatim — the CLI accepts both full Anthropic ids
  // (claude-opus-4-7, claude-fable-5) and short aliases
  // (opus, sonnet, haiku).
  if (!isClaudeCliAvailable()) return override;
  return { ...override, provider: 'claude-code-cli' };
}

export function detectModelOverride(text: string): ModelOverride | null {
  // `\bwith\s+([a-zA-Z][\w.-]*)\b` — `with` + token. Case-insensitive
  // on `with`. Token starts with a letter (so `with 5` isn't a match)
  // and may contain alphanumerics, dots, dashes, underscores (covers
  // `gpt-5`, `claude-haiku-4-5-20251001`, `gpt_oss`).
  const re = /\bwith\s+([a-zA-Z][\w.-]*)\b/gi;
  let match: RegExpExecArray | null;
  let last: ModelOverride | null = null;
  while ((match = re.exec(text)) !== null) {
    const tokenLower = match[1].toLowerCase();
    const resolved = resolveAlias(tokenLower);
    if (resolved !== null) {
      last = {
        provider: resolved.provider,
        model: resolved.model,
        matchedToken: match[1],
        matchStart: match.index,
        matchEnd: match.index + match[0].length,
      };
    }
  }
  return last;
}

/**
 * Resolve a lowercase token to a (provider, model) pair.
 *
 * Lookup order, with "closer to user intent" as the consistent tie-break:
 *   1. COMMON_ALIASES table (opus / haiku / nano / etc.). Curated.
 *   2. Exact provider id match (anthropic / cerebras / groq / etc.) →
 *      provider's defaultModel.
 *   3. Exact model name in any provider's knownModels →  that pair.
 *      Anthropic's `claude-opus-4-7` beats OpenRouter's
 *      `anthropic/claude-opus-4-7` here because we walk providers in
 *      registration order and return on first exact hit.
 *   4. Prefix match in a knownModel — `gpt-5` matches `gpt-5.4-mini`.
 *      Shortest matching model wins (closest to what the user typed —
 *      `gpt-5` hits `gpt-5.4` over `gpt-5.4-mini` over `gpt-5.3-codex`).
 *   5. Substring match anywhere in a knownModel. Same shortest-wins
 *      tie-break. Last-resort; lets `4-7` find `claude-opus-4-7`.
 *
 * Returns null when no rule fires.
 */
function resolveAlias(tokenLower: string): { provider: string; model: string } | null {
  const alias = COMMON_ALIASES[tokenLower];
  if (alias !== undefined) {
    const adapter = getProvider(alias.provider);
    if (adapter === null) return null;
    return { provider: alias.provider, model: alias.model ?? adapter.defaultModel };
  }
  const providers = listProviders();
  for (const p of providers) {
    if (p.id === tokenLower) {
      return { provider: p.id, model: p.defaultModel };
    }
  }
  for (const p of providers) {
    const models = p.knownModels ?? [p.defaultModel];
    for (const m of models) {
      if (m.toLowerCase() === tokenLower) {
        return { provider: p.id, model: m };
      }
    }
  }
  let bestPrefix: { provider: string; model: string } | null = null;
  for (const p of providers) {
    const models = p.knownModels ?? [p.defaultModel];
    for (const m of models) {
      if (m.toLowerCase().startsWith(tokenLower)) {
        if (bestPrefix === null || m.length < bestPrefix.model.length) {
          bestPrefix = { provider: p.id, model: m };
        }
      }
    }
  }
  if (bestPrefix !== null) return bestPrefix;
  let bestSubstring: { provider: string; model: string } | null = null;
  for (const p of providers) {
    const models = p.knownModels ?? [p.defaultModel];
    for (const m of models) {
      if (m.toLowerCase().includes(tokenLower)) {
        if (bestSubstring === null || m.length < bestSubstring.model.length) {
          bestSubstring = { provider: p.id, model: m };
        }
      }
    }
  }
  return bestSubstring;
}

/**
 * Strip the `with <token>` match from the source text. Collapses the
 * resulting double-space and trims leading/trailing whitespace so the
 * LLM-bound prompt body doesn't carry the parsing artefact.
 */
export function stripModelOverride(text: string, override: ModelOverride): string {
  const before = text.slice(0, override.matchStart);
  const after = text.slice(override.matchEnd);
  return (before + after).replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
}
