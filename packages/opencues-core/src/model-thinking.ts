/**
 * opencues-core/model-thinking.ts
 *
 * Per-model "thinking budget" resolution for the `max-thinking` OPENCUES.md
 * setting.
 *
 * ## The idea
 *
 * Every reasoning-capable model has a sensible CEILING on how hard it should
 * think before the latency cost outweighs the accuracy gain — "thinking too
 * much is too slow". Cerebras' gpt-oss models top out at `medium` (their
 * fastest reasoning path); Groq / OpenAI gpt-oss / gpt-5 top out at `low`.
 * Each model also gets a REDUCED level used when the user wants snappier,
 * cheaper output: cerebras → `low`, the gpt-oss / gpt-5 family → `none`.
 *
 * The single user knob is `max-thinking: on | off` (OPENCUES.md scalar,
 * default `on`):
 *
 *   - `on`  → each model thinks at its `max` ceiling. The ceilings are
 *             seeded to equal each provider's bench-derived
 *             `defaultReasoningEffort`, so `on` reproduces the pre-feature
 *             behaviour byte-for-byte.
 *   - `off` → each model drops to its `off` level.
 *
 * ## Why per-model (not per-provider)
 *
 * `ProviderAdapter.defaultReasoningEffort` is per-provider. This table is
 * per-(provider, model) so individual models can be tuned independently
 * later (e.g. a future cerebras model that's fine at `high`) without moving
 * every sibling. Models absent from the table fall back to the provider
 * default for `max` and one notch below it for `off`.
 *
 * ## Where this plugs in
 *
 * `resolveReasoningEffort` is the single resolution function. It runs inside
 * `buildOpenAIBody` (llm-provider.ts) — the one chokepoint every
 * reasoning-capable wire call funnels through (the source `dispatchChat`
 * calls AND AgentRewrite's direct `provider.buildRequest`). The `maxThinking`
 * flag reaches it via the `ctx` that already flows to every `buildRequest`.
 *
 * Bench provenance for the ceilings: `tests/results/thinking-budget-2026-05-18.md`
 * (the same sweep that set each provider's `defaultReasoningEffort`).
 */

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** Strength ordering so a ceiling can be enforced as a numeric min. */
const ORDER: Record<ReasoningEffort, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Lower of the two levels — clamps `effort` so it never exceeds `ceiling`. */
function clampToCeiling(effort: ReasoningEffort, ceiling: ReasoningEffort): ReasoningEffort {
  return ORDER[effort] <= ORDER[ceiling] ? effort : ceiling;
}

/** One level below `e`: high→medium, medium→low, low→none, none→none. */
function notchBelow(e: ReasoningEffort): ReasoningEffort {
  switch (e) {
    case 'high': return 'medium';
    case 'medium': return 'low';
    case 'low': return 'none';
    default: return 'none';
  }
}

export interface ModelThinking {
  /** Ceiling applied when `max-thinking` is ON. */
  readonly max: ReasoningEffort;
  /** Reduced level applied when `max-thinking` is OFF. */
  readonly off: ReasoningEffort;
}

/**
 * Explicit per-(provider, model) ceilings. Key is `${providerId}:${model}`.
 *
 * Seeded from each provider's `defaultReasoningEffort` (= `max`) with `off`
 * one notch below, but written out per model so each entry is independently
 * tunable. ONLY reasoning-capable models need a row — non-reasoning
 * providers (anthropic, gemini, claude-cli) never forward `reasoning_effort`,
 * so `resolveReasoningEffort` returns `undefined` for them regardless and the
 * value is dropped by `buildOpenAIBody`'s forward gate.
 */
const MODEL_THINKING: Readonly<Record<string, ModelThinking>> = {
  // Cerebras gpt-oss-120b — `medium` ceiling. `'none'` is rejected
  // with HTTP 400 ("Unsupported reasoning effort: none. Supported
  // values are 'low', 'medium'") — verified live 2026-06-12. `low`
  // is the floor here, NOT `none`.
  'cerebras:gpt-oss-120b': { max: 'medium', off: 'low' },
  // Cerebras zai-glm-4.7 — reasoning_effort knob is BINARY in
  // practice: `'none'` cleanly disables thinking (0 reasoning tokens,
  // ~280ms median); ANY other value (low/medium/high) burns 500-700
  // reasoning tokens regardless of the level chosen (~1000ms median).
  // OpenCues only ever wants the `none` mode — verified June 2026 via
  // /tmp/cerebras-zai-no-reasoning.mjs head-to-head.
  //
  // June 2026: the `isReasoningModelName` regex in
  // buildOpenAIBody was extended to match `zai-glm` so the field
  // actually reaches the wire. Prior to that extension `reasoning_effort`
  // was silently dropped for this model and zai defaulted to thinking
  // mode. See cerebras docs
  // https://inference-docs.cerebras.ai/capabilities/reasoning for the
  // `none` value.
  'cerebras:zai-glm-4.7': { max: 'none', off: 'none' },

  // Groq `openai/gpt-oss-*` — REQUIRES the field. Accepts ONLY
  // 'low' | 'medium' | 'high'; `'none'` returns HTTP 400
  // (`"reasoning_effort must be one of `low`, `medium`, or `high`"`).
  // Verified live 2026-06-12. `low` is the floor — `off: 'low'` is a
  // no-op for groq but it's the closest the toggle can get.
  'groq:openai/gpt-oss-120b': { max: 'low', off: 'low' },
  'groq:openai/gpt-oss-20b':  { max: 'low', off: 'low' },

  // OpenAI gpt-5.4 family — `low` ceiling. Live API on 2026-06-12 now
  // accepts `'none'` as a valid value (rejects `'minimal'` — inverse
  // of the May 2026 bench which is now stale on this point). `'none'`
  // returns 200 with usable content on a short generation; longer
  // rewrites may show a quality drop. `off: 'none'` is supported but
  // users should benchmark on their workload before relying on it.
  'openai:gpt-5.4-mini': { max: 'low', off: 'none' },
  'openai:gpt-5.4':      { max: 'low', off: 'none' },
  'openai:gpt-5.4-nano': { max: 'low', off: 'none' },
  // openai-subscription routes through the same gpt-5.4 API surface.
  'openai-subscription:gpt-5.4-mini': { max: 'low', off: 'none' },
  'openai-subscription:gpt-5.4':      { max: 'low', off: 'none' },
  'openai-subscription:gpt-5.4-nano': { max: 'low', off: 'none' },

  // OpenRouter `openai/gpt-oss-*` passthrough — OpenRouter explicitly
  // rejects `'none'` with HTTP 400 (`"Reasoning is mandatory for this
  // endpoint and cannot be disabled."`) on both the paid and `:free`
  // endpoints. Verified live 2026-06-12. `low` is the floor.
  'openrouter:openai/gpt-oss-120b':      { max: 'low', off: 'low' },
  'openrouter:openai/gpt-oss-120b:free': { max: 'low', off: 'low' },

  // OpenCode Zen free pool — same gpt-oss-120b family as groq, so
  // assume the same `'none'` hard-reject. No live probe (free pool
  // requires a separate key + has stricter rate limits); `off: 'low'`
  // is the conservative choice that won't 400. Re-probe if the floor
  // changes.
  'opencode-zen:free':       { max: 'low', off: 'low' },
  'opencode-zen:big-pickle': { max: 'low', off: 'low' },
};

/**
 * The `{ max, off }` pair for a (provider, model). Explicit table entry wins;
 * otherwise derive from `providerDefault` (`max = default`, `off` one notch
 * below). When the provider has no reasoning default (non-reasoning provider)
 * both are `none` — but the result is unused, since such providers don't
 * forward the field.
 */
export function lookupModelThinking(
  providerId: string | undefined,
  model: string,
  providerDefault?: ReasoningEffort,
): ModelThinking {
  const explicit = providerId ? MODEL_THINKING[`${providerId}:${model}`] : undefined;
  if (explicit) return explicit;
  if (providerDefault === undefined) return { max: 'none', off: 'none' };
  return { max: providerDefault, off: notchBelow(providerDefault) };
}

export interface ResolveReasoningArgs {
  readonly providerId?: string;
  readonly model: string;
  /**
   * Caller's explicit per-call reasoning (e.g. FluidBlank / ConfigIntent
   * pin `'low'` for latency). Wins over the max-thinking toggle, but is
   * still clamped DOWN to the model's ceiling — `max-thinking` is a true
   * cap, so an explicit `'high'` on cerebras still resolves to `'medium'`.
   */
  readonly explicit?: ReasoningEffort;
  /** The provider's bench default — ceiling for models absent from the table. */
  readonly providerDefault?: ReasoningEffort;
  /** OPENCUES.md `max-thinking` toggle. Treated as `true` (on) when omitted. */
  readonly maxThinking?: boolean;
}

/**
 * Resolve the `reasoning_effort` value for a (provider, model) wire call.
 *
 * Precedence:
 *   1. `explicit` (clamped to the model's ceiling).
 *   2. `maxThinking` ON  → the model's ceiling.
 *      `maxThinking` OFF → the model's reduced level.
 *
 * Returns `undefined` only when the provider has no reasoning default AND no
 * explicit value — i.e. a non-reasoning provider — exactly matching the prior
 * `req.reasoningEffort ?? defaultReasoningEffort` contract this replaced.
 *
 * NOTE: with `maxThinking` ON (the default) and ceilings seeded to equal
 * `providerDefault`, this returns the SAME value the old expression did, so
 * the default install is behaviourally unchanged.
 */
export function resolveReasoningEffort(args: ResolveReasoningArgs): ReasoningEffort | undefined {
  const { max, off } = lookupModelThinking(args.providerId, args.model, args.providerDefault);
  if (args.explicit !== undefined) return clampToCeiling(args.explicit, max);
  // No reasoning default → non-reasoning provider; preserve the undefined
  // contract regardless of the toggle (value would be dropped anyway).
  if (args.providerDefault === undefined) return undefined;
  return (args.maxThinking ?? true) ? max : off;
}
