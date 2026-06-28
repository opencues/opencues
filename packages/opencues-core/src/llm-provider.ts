/**
 * LLM provider abstraction.
 *
 * Every LLM call site in OpenCues — the four cue/blank sources
 * (config, fluid-blank, transform-blank, spelling) AND the runtime's
 * AgentRewrite — used to hand-construct OpenAI-style chat-completions
 * JSON and parse OpenAI-style responses. That worked when "the LLM"
 * meant Groq, but Gemini's API shape is different (`contents` instead
 * of `messages`, `parts[].text` instead of `choices[].message.content`),
 * and adding a fifth "OpenAI-but-with-quirks" provider would have
 * meant copy-pasting the request/response munging into every site.
 *
 * This module owns the per-provider request/response translation. Call
 * sites build a single `ChatRequest`, hand it to `buildProviderRequest`
 * along with the active provider, and get back `{ url, body, headers }`
 * to POST. The response goes through `parseProviderResponse` and comes
 * back as a plain string regardless of provider.
 *
 * To add a provider: add an entry to `PROVIDERS` with its endpoint /
 * model defaults + request/response translators. Nothing else changes.
 */

import { resolveReasoningEffort } from './model-thinking';

export type ProviderId = 'groq' | 'openrouter' | 'gemini' | 'openai' | 'openai-subscription' | 'anthropic' | 'cerebras' | 'claude-code-cli' | 'opencode-zen';

export const PROVIDER_IDS: readonly ProviderId[] = ['groq', 'openrouter', 'gemini', 'openai', 'openai-subscription', 'anthropic', 'cerebras', 'claude-code-cli', 'opencode-zen'];

/**
 * Legacy provider-id aliases. User configs created before the rename
 * (`claude-cli` → `claude-code-cli`, 2026-06-02) silently resolve via
 * `getProvider`. The old id is retained ONLY for read; new writes
 * always emit the canonical form. Drop after 2027-01-01.
 */
const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  'claude-cli': 'claude-code-cli',
};

/**
 * Canonicalises a provider id at every user-input boundary. Legacy
 * aliases ({@link LEGACY_PROVIDER_ALIASES}) resolve to their current
 * canonical id; unknown ids pass through unchanged for the caller to
 * surface as `unknown-provider`. Internal call sites (buildRequest,
 * fallback walkers) already receive canonical ids and don't need this.
 */
export function canonicalizeProviderId(id: string): string {
  return LEGACY_PROVIDER_ALIASES[id] ?? id;
}

/**
 * Internal chat-request shape — provider-neutral. Each provider's
 * `buildRequest` translates this into the provider's wire format.
 */
export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Hard cap on response tokens. Provider may not honor exactly. */
  readonly maxTokens?: number;
  /** 0 = greedy. Most providers accept 0–2. Gemini accepts 0–2. */
  readonly temperature?: number;
  /**
   * Deterministic-sample seed. Honored by Groq + OpenAI; ignored by
   * Gemini and (currently) OpenRouter — we still pass it because some
   * providers may add support and ignoring unknown fields is the
   * established convention.
   */
  readonly seed?: number;
  /**
   * Reasoning-model effort hint. Groq's `openai/gpt-oss-*` models read
   * this; OpenAI's gpt-5 family (nano/mini/regular) and o-series read
   * it too — `'none'` effectively disables reasoning on gpt-5
   * nano/mini (and is the only mode where they don't starve a 2-pass
   * pipeline's small max_completion_tokens budget). Other providers
   * silently ignore. Pass-through.
   */
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /**
   * Optional structured-output spec. When set, the request includes a
   * `response_format: { type: 'json_schema', json_schema: ... }` field —
   * Groq's `openai/gpt-oss-*` models in strict mode guarantee the
   * output is valid JSON conforming to the schema (constrained
   * decoding). Other providers either accept best-effort or ignore.
   * Callers must JSON.parse the response themselves; the provider's
   * `parseResponse` still returns the raw `message.content` string.
   */
  readonly responseFormat?: ResponseFormat;
  /**
   * Speculative-decoding hint — see Cerebras's
   * [Predicted Outputs](https://inference-docs.cerebras.ai/capabilities/prompt-caching).
   *
   * When set, providers that support predicted outputs (cerebras's
   * `gpt-oss-120b` and `zai-glm-4.7` today) include this text as a
   * `prediction: { type: 'content', content: prediction }` field. The
   * server validates the predicted text token-by-token against the
   * actual generation; matching tokens come from cache (billed at the
   * input rate), mismatches regenerate (billed at the output rate).
   *
   * Use for **transformations of existing text** where most output
   * bytes overlap the input (fix typos on a paragraph, make formal,
   * shorten, edit a draft). Don't use for **generations from a short
   * seed** ("draft an email _") — nothing to predict against, and
   * rejected tokens cost the same as regenerating from scratch.
   *
   * Empirically (June 2026) on cerebras gpt-oss-120b:
   *   - 66% acceptance rate on long-rewrite tasks (≥240 output tokens)
   *   - ~150ms median speedup, ~750ms p95 tail reduction
   *   - 0% acceptance on short outputs (<170 tokens) — net +12ms overhead
   * See docs/architecture/cerebras.md § Predicted Outputs.
   */
  readonly prediction?: string;
}

/** Structured-outputs spec for a single ChatRequest. */
export interface ResponseFormat {
  readonly name: string;
  readonly strict?: boolean;
  readonly schema: Record<string, unknown>;
}

/**
 * True when the (provider, model) pair supports strict structured
 * outputs (constrained decoding). Today: groq + openai/gpt-oss-{20b,120b}.
 *
 * Single source of truth — every LLM-calling surface in the runtime
 * (TransformBlank, FluidBlank, WordCues, AgentRewrite) checks against
 * this helper so the support matrix is one place to update.
 */
export function useStrictJson(providerId: string | undefined, model: string): boolean {
  if (providerId !== 'groq') return false;
  return /^openai\/gpt-oss-(20b|120b)/i.test(model);
}

/**
 * Build a `responseFormat` object for a ChatRequest. Pure constructor —
 * trims the per-call-site noise of writing `{ name, strict: true, schema }`
 * inline. Always sets `strict: true` because that's the only mode worth
 * using on the supported models; pass `{ strict: false }` via the
 * second arg if best-effort is desired.
 */
export function buildJsonResponseFormat(
  name: string,
  schema: Record<string, unknown>,
  opts: { strict?: boolean } = {},
): ResponseFormat {
  return { name, strict: opts.strict ?? true, schema };
}

export interface BuiltRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/**
 * Per-provider opt-ins for non-universal OpenAI-shape request fields.
 * `buildOpenAIBody` emits each field ONLY when declared here (default-off).
 * Add a new opt-in field here + read it in `buildOpenAIBody` whenever a
 * provider-specific param is introduced — never with a `provider === 'x'`
 * check at the call site (that's the scattered-allowlist pattern this
 * replaces). Model-dependent capabilities take a predicate.
 */
export interface ProviderCapabilities {
  /** OpenAI `seed` — deterministic sampling. Rejected by pass-through
   *  gateways (openrouter → anthropic 400s). */
  readonly seed?: boolean;
  /** Predicted-outputs `prediction` speculative-decoding hint
   *  (cerebras gpt-oss-120b / zai-glm-4.7, openai chat-completions).
   *  Model-dependent on cerebras — gemma-4-31b 400s on the field
   *  (`"prediction" is not currently supported`) — so a predicate. */
  readonly prediction?: boolean | ((model: string) => boolean);
  /** `reasoning_format: "hidden"` — cerebras, gpt-oss-class models only,
   *  so model-dependent (a predicate). */
  readonly reasoningFormatHidden?: boolean | ((model: string) => boolean);
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Human-readable name for CLI banners + doctor / help output. e.g. 'Cerebras', 'OpenAI'. */
  readonly displayName: string;
  /**
   * Transport — how `dispatchChat` reaches this provider.
   *
   *   - `'http'` (default): builds a request via `buildRequest`, POSTs
   *     via the `HttpAdapter`, parses with `parseResponse`. Every
   *     OpenAI-compatible provider plus Anthropic + Gemini.
   *   - `'cli'`: bypasses HTTP entirely. The provider declares an
   *     `invokeCli(req, ctx)` method instead; `dispatchChat` routes
   *     to it directly. Used by the subprocess-backed `claude-cli`
   *     daemon (subscription-auth, no API key). Sources are unaffected
   *     by the choice — they call `dispatchChat` and get the assistant
   *     text back either way.
   *
   * Default is `'http'` when omitted. Every existing provider in
   * `PROVIDERS` leaves this undefined; the dispatch path is unchanged.
   */
  readonly transport?: 'http' | 'cli';
  /** Default endpoint URL when the user hasn't overridden. Some providers (Gemini) substitute the model into the URL. */
  readonly defaultEndpoint: string;
  /** Default model when the user hasn't picked one. */
  readonly defaultModel: string;
  /**
   * Curated list of model ids the fluid-config classifier may route to
   * for this provider via natural-language `_` ("use cerebras
   * gpt-oss-120b for cues _"). First entry conventionally matches
   * `defaultModel`. Power users can still set ANY model string in
   * OPENCUES.md by hand — this list bounds only what the classifier is
   * allowed to emit. Each entry should be bench-validated against the
   * OpenCues pipelines (fluid-blank, transform-blank, agent-rewrite,
   * cues) for that provider.
   *
   * Optional — when omitted, the classifier defaults to picking the
   * provider's `defaultModel` only (no model selection via NL). Adding
   * a few entries opens up natural-language model picking without
   * exposing the full provider catalogue to LLM hallucination.
   */
  readonly knownModels?: readonly string[];
  /** The env-var name the boot layer reads to find this provider's API key. */
  readonly envKeyName: string;
  /**
   * When true, `resolveLLM` will return a usable tuple even if the API
   * key is unset — `apiKey` resolves to `''`. The provider's
   * `buildRequest` is responsible for handling the empty case (e.g.
   * omitting the Authorization header). Today only `opencode-zen` opts
   * in: its free model pool authenticates anonymously, paid models
   * still need a key. Without this flag, the provider is unusable
   * until a key is set — which would break `blanks-llm-provider: opencode-zen + blanks-llm-model: free`
   * for the no-account case the feature was designed for.
   */
  readonly optionalAuth?: boolean;
  /**
   * When true, this provider's ToS allows the operator to train on
   * submitted inputs. The resolver refuses to wire prose-bearing
   * sources (word-cues, sentence-cues, auditors, agent-rewrite)
   * through such a provider — those carry the user's actual buffer
   * text and would be leaked at every emit. Blanks (the user-opt-in
   * `_` surface) are still allowed: typing `_` is a deliberate
   * keystroke, the user can pick where it routes.
   *
   * Today only `opencode-zen` opts in. The flag generalises so any
   * future free-pool / training-pool provider can be added safely:
   * mark it `trainsOnInput`, and the prose-source guard kicks in
   * automatically.
   */
  readonly trainsOnInput?: boolean;
  /**
   * Per-provider reasoning-effort default. Applied when a call site
   * leaves `req.reasoningEffort` undefined. Derived from the May 18
   * 2026 thinking-budget bench (`tests/results/thinking-budget-2026-05-18.md`):
   * each value is the highest reasoning level whose p50 still fits
   * fluid-blank's 1500ms budget AND keeps accuracy ≥ 90% AND doesn't
   * regress other production pipelines (transform-blank).
   *
   * `undefined` means "don't pass reasoning_effort at all" — for
   * providers that ignore the field (anthropic) or that would
   * 400 on it.
   */
  readonly defaultReasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /**
   * Wire-feature opt-ins for the OpenAI-shape body builder. Each request
   * field that is NOT universally accepted is emitted by `buildOpenAIBody`
   * ONLY when the provider declares it here — **default-off**. This makes
   * the "forgot to gate a provider-specific param" class structurally
   * impossible: a NEW field added to `ChatRequest` is never sent until a
   * provider opts in, so forgetting is *safe* (the param is dropped) rather
   * than a 400 on a provider that doesn't support it (the failure mode that
   * `seed` and `prediction` both hit). Providers that build their own body
   * (anthropic / gemini) or use a CLI transport leave this unset — it's
   * unread there. The dispatch-level `prediction`-unsupported retry stays as
   * the receive-side belt: capabilities are a best-effort declaration, the
   * fallback handles a provider that rejects a field anyway.
   */
  readonly capabilities?: ProviderCapabilities;
  /**
   * Translate the neutral ChatRequest into wire format for this provider.
   * Required for `transport: 'http'` (the default). CLI-transport
   * providers may stub this — it's never called.
   */
  buildRequest(req: ChatRequest, ctx: { apiKey: string; endpoint?: string; maxThinking?: boolean }): BuiltRequest;
  /**
   * Extract the assistant's text from this provider's response shape.
   * Required for `transport: 'http'`. CLI-transport providers may stub
   * this — it's never called.
   */
  parseResponse(rawJson: string): string;
  /**
   * CLI-transport entry point. Returns the assistant text directly.
   * Only called when `transport === 'cli'`. The provider owns its own
   * lifecycle (subprocess spawning, request queueing, idle reap, etc.).
   * Receives the neutral request + the same auth/endpoint context as
   * buildRequest, but the `apiKey` field is typically ignored (CLI
   * providers use external auth like a logged-in `claude` session).
   */
  invokeCli?(req: ChatRequest, ctx: { apiKey: string; endpoint?: string; maxThinking?: boolean }): Promise<string>;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Build the OpenAI-style chat-completions body. Used by every
 * OpenAI-compatible provider (Groq, OpenRouter, OpenAI proper, Cerebras,
 * Together, Fireworks, etc.). Lifted out so adding a new compatible
 * provider is a 6-line entry in PROVIDERS, not 30 lines of duplication.
 *
 * `reasoning_effort` is the awkward field: Groq's `openai/gpt-oss-*`
 * models REQUIRE it (without it, max_tokens is consumed by reasoning
 * and content comes back empty). OpenAI proper REJECTS it on
 * non-reasoning models like `gpt-4o-mini` (HTTP 400, "Unrecognized
 * request argument"). So providers that only host reasoning models
 * pass `includeReasoningEffort: true`; others omit the field unless
 * the model name suggests it's a reasoning model.
 */
function buildOpenAIBody(req: ChatRequest, opts?: { includeReasoningEffort?: boolean; useCompletionTokensName?: boolean; defaultReasoningEffort?: 'none' | 'low' | 'medium' | 'high'; provider?: ProviderId; capabilities?: ProviderCapabilities; maxThinking?: boolean }): string {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  // Resolve the reasoning level FIRST so the max_tokens pairing below
  // can see it. Resolution honours the `max-thinking` toggle + the
  // per-model ceiling table (model-thinking.ts): an explicit per-call
  // value wins but is clamped to the ceiling; otherwise the toggle
  // picks the model's `max` (on) or `off` (reduced) level. With the
  // toggle ON (the default) and ceilings seeded to equal
  // `defaultReasoningEffort`, this is identical to the prior
  // `req.reasoningEffort ?? defaultReasoningEffort` expression.
  // zai-glm-4.7 (cerebras) needs reasoning_effort forwarded SPECIFICALLY
  // to disable thinking via `'none'` — by default the model burns
  // 500-700 reasoning tokens. Without forwarding `reasoning_effort:
  // none` the model treats it as full-thinking mode (verified via
  // ad-hoc bench, June 2026). See cerebras docs
  // https://inference-docs.cerebras.ai/capabilities/reasoning and
  // model-thinking.ts MODEL_THINKING['cerebras:zai-glm-4.7'].
  const isReasoningModelName = /^(o\d|gpt-5|gpt-oss|qwen-3-thinking|zai-glm)/i.test(req.model);
  const reasoningForwarded = opts?.includeReasoningEffort || isReasoningModelName;
  const reasoning = reasoningForwarded
    ? resolveReasoningEffort({
        providerId: opts?.provider,
        model: req.model,
        explicit: req.reasoningEffort,
        providerDefault: opts?.defaultReasoningEffort,
        maxThinking: opts?.maxThinking,
      })
    : undefined;
  if (req.maxTokens !== undefined) {
    // Pair max_tokens with reasoning on gpt-oss models: the model
    // spends reasoning tokens against the same budget as output, and a
    // tight ceiling can starve content entirely. The May 18 2026
    // thinking-budget bench showed a 98%→20% accuracy collapse on
    // gpt-oss-120b · high at 512 tokens (see
    // tests/results/thinking-budget-2026-05-18.md). Same class of bug
    // hit sentence-cues on the SAME day's agentic-harness run with
    // reasoning='medium' at 768 — the LLM returned empty content in
    // ~150ms, parsing produced zero blocks (emitted=0, ceded=0). So
    // the floor applies to ANY reasoning level on gpt-oss, not just
    // high. 2048 covers reasoning + content for every shipped level.
    // Other reasoning model families (o-series, gpt-5) aren't included
    // until the same bench is rerun against them. Caller's higher max
    // wins.
    const needsReasoningFloor = reasoning !== undefined && reasoning !== 'none' && /gpt-oss/i.test(req.model);
    const effectiveMax = needsReasoningFloor ? Math.max(req.maxTokens, 2048) : req.maxTokens;
    // OpenAI renamed `max_tokens` → `max_completion_tokens` for the
    // gpt-5 / o-series chat-completions API. The old field 400s on
    // those models. Other OpenAI-compatible hosts (Groq, OpenRouter,
    // Cerebras) keep `max_tokens` even for the same models, so we
    // can't blindly rewrite — let each adapter signal which field it
    // wants based on its own routing.
    body[opts?.useCompletionTokensName ? 'max_completion_tokens' : 'max_tokens'] = effectiveMax;
  }
  // Two gates on `temperature`:
  //   1. OpenAI gpt-5 / o-series lock temperature to 1 — passing any
  //      other value (including 0) returns HTTP 400. `useCompletionTokensName`
  //      correlates 1:1 with this restriction, so we re-use the flag.
  //   2. Provider/model-level rejection — Anthropic Claude 4.x (direct or
  //      via OpenRouter pass-through) and any future model added to the
  //      `TEMPERATURE_REJECTING_MODELS` matrix.
  const providerRejectsTemp = opts?.provider !== undefined
    && modelRejectsTemperature(opts.provider, req.model);
  if (req.temperature !== undefined && !opts?.useCompletionTokensName && !providerRejectsTemp) {
    body.temperature = req.temperature;
  }
  // Deterministic seed — emitted only when the provider declares it
  // (capabilities.seed). NEVER sent to a pass-through gateway: openrouter
  // (proxying anthropic) 400s on unsupported params. Declared by
  // cerebras / groq / openai; the variant-cache determinism that relies on
  // seed only ever pins groq/cerebras, so the gate loses nothing.
  if (opts?.capabilities?.seed && req.seed !== undefined) body.seed = req.seed;
  // Pass reasoning_effort only when the provider opts in OR the model
  // name suggests it's an OpenAI reasoning model (o1/o3/o4/gpt-5).
  // Leaves gpt-4o-mini-class models alone, where the field 400s.
  // Provider/model-level explicit rejection wins regardless of opt-in
  // (e.g. Groq llama-* rejects the field even though the adapter
  //  opts in for its gpt-oss companions — see
  //  `modelRejectsReasoningEffort`).
  const providerRejectsReasoning = opts?.provider !== undefined
    && modelRejectsReasoningEffort(opts.provider, req.model);
  if (reasoning !== undefined && !providerRejectsReasoning) {
    body.reasoning_effort = reasoning;
  }
  // Cerebras gpt-oss-120b only — request `reasoning_format: "hidden"`
  // so the model's reasoning trace is suppressed from the response.
  // Reasoning tokens are still generated and counted (no cost change,
  // no accuracy change), but the JSON response carries only the final
  // answer in `message.content` with NO separate `reasoning` field.
  //
  // Why hidden on gpt-oss-120b: bench-measured at N=20 trials it
  // tightens p95 by ~150-230ms on short-output calls (fluid-blank,
  // config-intent) — the small content + heavy reasoning trace ratio
  // amplifies the relative cost of transmitting the trace. Long-
  // output calls (transform-blank fused) are neutral. Median latency
  // is unchanged either way.
  //
  // Why gated to gpt-oss-120b: cerebras docs scope `reasoning_format`
  // to gpt-oss-120b and zai-glm-4.7. zai-glm-4.7 already runs at
  // reasoning_effort: 'none' for us (model-thinking.ts) so it
  // produces no reasoning text; hidden is a no-op there. Other
  // providers may reject the unknown field; safest to scope tight.
  //
  // See docs/architecture/cerebras.md § "Hidden reasoning format". Emitted
  // only when the provider declares `reasoningFormatHidden` for this model
  // (cerebras → a `/^gpt-oss/` predicate; everyone else off).
  const rfh = opts?.capabilities?.reasoningFormatHidden;
  if (typeof rfh === 'function' ? rfh(req.model) : rfh) {
    body.reasoning_format = 'hidden';
  }
  // Structured outputs. Groq's gpt-oss-{20b,120b} support `strict: true`
  // with constrained decoding (guarantee). Other OpenAI-compatible
  // providers accept best-effort (strict: false). The schema must
  // include `additionalProperties: false` and mark every property as
  // `required` for strict mode — caller's responsibility.
  if (req.responseFormat) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: req.responseFormat.name,
        strict: req.responseFormat.strict ?? false,
        schema: req.responseFormat.schema,
      },
    };
  }
  // Predicted outputs — speculative-decoding hint, emitted only when the
  // provider declares `capabilities.prediction` (cerebras gpt-oss-120b /
  // zai-glm-4.7, openai chat-completions). The "other providers silently
  // ignore unknown fields" assumption is FALSE for strict gateways:
  // openrouter (proxying anthropic) returns `400 property 'prediction' is
  // unsupported`, which hard-fails the call — so default-off via the
  // capability table keeps the hint from ever leaking to a rejecter. (The
  // dispatch-level retry-without-prediction in `dispatchChat` is the
  // receive-side belt for a provider that rejects it anyway.) See
  // docs/architecture/cerebras.md § Predicted Outputs.
  const predCap = opts?.capabilities?.prediction;
  const predictionOn = typeof predCap === 'function' ? predCap(req.model) : predCap;
  if (predictionOn && req.prediction !== undefined && req.prediction.length > 0) {
    body.prediction = { type: 'content', content: req.prediction };
  }
  return JSON.stringify(body);
}

function parseOpenAIResponse(rawJson: string): string {
  const data = JSON.parse(rawJson) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
    // Cerebras + a few other gateways put the error fields at the
    // ROOT instead of nesting them under `error:` the way OpenAI does.
    // Cerebras 402 example:
    //   {"message":"Payment required to access this resource. Visit
    //   your billing tab.","type":"payment_required_error","param":
    //   "quota","code":"payment_required"}
    // Without this branch, parseOpenAIResponse silently returned ''
    // (no choices) on 402/429/etc — the runtime kept calling and
    // every source emitted empty output. Caught 2026-05-18 via the
    // agentic harness against a Cerebras account out of credits.
    message?: string;
    code?: string;
    type?: string;
  };
  if (data.error) throw new Error(`provider error: ${data.error.message ?? JSON.stringify(data.error)}`);
  if (!data.choices && typeof data.message === 'string' && typeof data.code === 'string') {
    throw new Error(`provider error: ${data.message} (code=${data.code}${data.type ? `, type=${data.type}` : ''})`);
  }
  return data.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------
// Model capability matrix
// ---------------------------------------------------------------------

/**
 * (provider, model) pairs that 400 on the `temperature` parameter.
 *
 * - OpenAI's gpt-5 / o-series: temperature is locked to `1`; the adapter
 *   already filters these via `useCompletionTokensName` (see buildOpenAIBody)
 *   so they're NOT enumerated here.
 * - Anthropic Claude 4.x: Anthropic's June 2026 API change deprecated
 *   `temperature` on every Claude 4.x model — claude-opus-4-7 raises
 *   "`temperature` is deprecated for this model" on every call that includes
 *   the field, regardless of `reasoning_effort` state. Verified live against
 *   the user's anthropic key on 2026-06-02. The same applies to
 *   sonnet-4-6 and haiku-4-5 per Anthropic's docs / change notes.
 * - OpenRouter pass-through: requests to `anthropic/claude-*` via OpenRouter
 *   hit Anthropic's gate too, so the same rule applies when the model name
 *   carries the `anthropic/` prefix.
 *
 * Match is a regex against the model name; the caller passes the resolved
 * (provider, model) pair. When a future provider adds more reasoning-class
 * models, append a row here — no buildRequest edits needed.
 */
const TEMPERATURE_REJECTING_MODELS: ReadonlyArray<{
  provider: ProviderId;
  pattern: RegExp;
  reason: string;
}> = [
  { provider: 'anthropic',  pattern: /^claude-(opus|sonnet|haiku)-4/,             reason: 'Anthropic Claude 4.x deprecated `temperature` (June 2026 API change).' },
  { provider: 'openrouter', pattern: /^anthropic\/claude-(opus|sonnet|haiku)-4/, reason: 'OpenRouter passthrough to Anthropic Claude 4.x — same deprecation.' },
];

/**
 * Returns true when the (provider, model) pair is known to reject the
 * `temperature` parameter at the API boundary. Callers should omit the
 * field from the request body when this returns true.
 */
export function modelRejectsTemperature(provider: ProviderId, model: string): boolean {
  return TEMPERATURE_REJECTING_MODELS.some(
    (entry) => entry.provider === provider && entry.pattern.test(model),
  );
}

/**
 * (provider, model) pairs that 400 on the `reasoning_effort` parameter.
 *
 * - Groq's llama-3.3-70b-versatile (and other non-gpt-oss llama models) reject
 *   `reasoning_effort` with HTTP 400 "`reasoning_effort` is not supported with
 *   this model". Groq's adapter previously set `includeReasoningEffort: true`
 *   adapter-wide on the assumption that non-reasoning models would silently
 *   ignore it — they don't. Verified live 2026-06-02.
 *
 * The match shape mirrors `TEMPERATURE_REJECTING_MODELS` so adding a new
 * entry is one line and never requires editing an adapter.
 */
const REASONING_EFFORT_REJECTING_MODELS: ReadonlyArray<{
  provider: ProviderId;
  pattern: RegExp;
  reason: string;
}> = [
  { provider: 'groq', pattern: /^llama-/, reason: 'Groq llama-* family rejects `reasoning_effort` (HTTP 400).' },
];

/**
 * Returns true when the (provider, model) pair is known to reject the
 * `reasoning_effort` parameter. Callers should omit the field from the
 * request body when this returns true.
 */
export function modelRejectsReasoningEffort(provider: ProviderId, model: string): boolean {
  return REASONING_EFFORT_REJECTING_MODELS.some(
    (entry) => entry.provider === provider && entry.pattern.test(model),
  );
}

// ---------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------

const GROQ: ProviderAdapter = {
  id: 'groq',
  capabilities: { seed: true },
  displayName: 'Groq',
  defaultEndpoint: 'https://api.groq.com/openai/v1/chat/completions',
  defaultModel: 'openai/gpt-oss-120b',
  // Groq's open-weight gpt-oss tier (verified May 2026). The 20b is
  // the cheap-fast option; the 120b is the default; llama-3.3-70b is
  // a non-reasoning alternative for users who want a different model
  // family. Other Groq models (mixtral, llama-3.1, kimi) work via
  // direct file edit but aren't surfaced to the fluid-config classifier.
  knownModels: [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
  ],
  // llama-3.3-70b-versatile removed 2026-06: not a reasoning model, so it
  // 400s on the `reasoning_effort` field our adapter ships by default for
  // its gpt-oss companions. Reachable via direct OPENCUES.md edit; the
  // classifier just doesn't surface it.
  envKeyName: 'GROQ_API_KEY',
  // gpt-oss-120b at `medium`+`high` overshoots OpenCues' fluid-blank
  // (1500ms) and word-cue (500ms) budgets at Groq's throughput; `low`
  // is the only level that fits every pipeline. `high` also collapses
  // accuracy with the default 512-token cap (see buildOpenAIBody).
  defaultReasoningEffort: 'low',
  buildRequest(req, ctx) {
    // Groq's gpt-oss-* models REQUIRE reasoning_effort; their
    // non-reasoning models silently ignore it. Always-on is safe.
    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: buildOpenAIBody(req, { includeReasoningEffort: true, defaultReasoningEffort: this.defaultReasoningEffort, provider: this.id, capabilities: this.capabilities, maxThinking: ctx.maxThinking }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
    };
  },
  parseResponse: parseOpenAIResponse,
};

const OPENROUTER: ProviderAdapter = {
  id: 'openrouter',
  // Pass-through gateway: it proxies arbitrary upstream models (anthropic,
  // etc.) that 400 on OpenAI-only params, so it opts into NONE of them.
  capabilities: {},
  displayName: 'OpenRouter',
  defaultEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
  // Free-tier non-llama default. `openai/gpt-oss-120b:free` is the same
  // gpt-oss-120b model Groq ships, just hosted on OpenRouter's free
  // tier — gives users a free fallback when their primary provider is
  // rate-limited or down. Users override per-feature for paid models.
  defaultModel: 'openai/gpt-oss-120b:free',
  // OpenRouter is a multi-model router; the curated set here is the
  // popular cross-provider picks OpenCues bench-validates against.
  // Users routing to esoteric models (`x-ai/grok-2`, `mistralai/...`)
  // can still set them via direct file edit; the classifier just
  // can't reach them.
  knownModels: [
    'openai/gpt-oss-120b:free',
    'openai/gpt-oss-120b',
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-opus-4-7',
    'google/gemini-3.1-flash-lite',
  ],
  envKeyName: 'OPENROUTER_API_KEY',
  // OpenRouter is a multi-model router — `low` is the cross-model safe
  // default that mirrors what every call site used to hardcode. Picks
  // a sensible level for whichever underlying gpt-oss / gpt-5 / o-series
  // model the user routes to without overshooting latency budgets.
  defaultReasoningEffort: 'low',
  buildRequest(req, ctx) {
    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: buildOpenAIBody(req, { defaultReasoningEffort: this.defaultReasoningEffort, provider: this.id, capabilities: this.capabilities, maxThinking: ctx.maxThinking }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
        // OpenRouter recommends these for routing/analytics; safe no-ops elsewhere.
        'HTTP-Referer': 'https://opencues.dev',
        'X-Title': 'OpenCues',
      },
    };
  },
  parseResponse: parseOpenAIResponse,
};

const OPENAI: ProviderAdapter = {
  id: 'openai',
  capabilities: { seed: true, prediction: true },
  displayName: 'OpenAI',
  defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
  // gpt-5.4-mini (released March 2026) — mid-tier in the OpenAI lineup
  // at $0.75/$4.50 per 1M in/out. Picked as the default over gpt-5.4-nano
  // ($0.20/$1.25) after the May 2026 benchmark sweep showed nano
  // collapsing on multi-paragraph (0% on transform-blank fused) and
  // long-form rewrites — the reasoning model spends
  // its `max_completion_tokens` budget on internal reasoning and runs out
  // before producing the rest of the output. Mini has enough budget to
  // actually complete the task on long inputs. Users who want the cheaper
  // tier can override per-feature with `openai-model: gpt-5.4-nano`.
  defaultModel: 'gpt-5.4-mini',
  // gpt-5.4 tier (released March 2026). nano is the cheapest but
  // collapses on multi-paragraph rewrites (reasoning-token starvation);
  // mini is the default; 5.4 proper is the deeper-reasoning option for
  // agent/auditors. Legacy gpt-4o-* family kept reachable via file edit
  // for users who explicitly need it.
  knownModels: [
    'gpt-5.4-mini',
    'gpt-5.4',
    'gpt-5.4-nano',
  ],
  envKeyName: 'OPENAI_API_KEY',
  // `low` (not `none`) — bench showed `none` is fastest on fluid-blank,
  // but it drops transform-blank-fused 85.3%→28.1% on gpt-5.4-mini
  // (see floor-bump comment below). `low` is the safe default that
  // covers every OpenCues pipeline.
  defaultReasoningEffort: 'low',
  buildRequest(req, ctx) {
    // OpenAI renamed `max_tokens` to `max_completion_tokens` for the
    // gpt-5 / o-series. Detect by model name so users on legacy
    // gpt-4o-* keep working.
    const useCompletionTokensName = /^(gpt-5|o\d)/i.test(req.model);

    // gpt-5 nano / mini tiers get a max_completion_tokens floor of 2048.
    // With the typical caller budget (~768) AND `reasoning_effort: 'low'`
    // (the level that actually produces good output on rewrite tasks),
    // the model runs out of budget before emitting a complete answer.
    // 2048 gives reasoning + output enough room on every case observed
    // in the May 2026 benchmark. Caller's higher max wins.
    //
    // Earlier hypothesis: "reasoning should be off on nano/mini".
    // Empirical refutation: reasoning_effort='none' drops
    // transform-blank-fused 85.3% → 28.1% on mini (−57pp), and similar
    // double-digit drops on nano. nano/mini aren't the o-series but
    // they're still meaningfully reasoning-assisted — keep caller
    // intent ('low' for OpenCues call sites).
    const isLowReasoningTier = /gpt-5(\.\d+)?-(nano|mini)\b/i.test(req.model);
    const reqForBody = isLowReasoningTier
      && (req.maxTokens === undefined || req.maxTokens < 2048)
        ? { ...req, maxTokens: 2048 }
        : req;

    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: buildOpenAIBody(reqForBody, { useCompletionTokensName, defaultReasoningEffort: this.defaultReasoningEffort, provider: this.id, capabilities: this.capabilities, maxThinking: ctx.maxThinking }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
    };
  },
  parseResponse: parseOpenAIResponse,
};

/**
 * openai-subscription — OpenAI's Responses API via your ChatGPT plan.
 *
 * Same OpenAI models, different auth: instead of `OPENAI_API_KEY` (paid
 * per-token API access via the `openai` provider above), this provider
 * reads the OAuth token codex stored in `~/.codex/auth.json` after a
 * one-time `codex login` and POSTs directly to OpenAI's Responses
 * endpoint. Calls are billed against your ChatGPT subscription —
 * effectively free if you already have a Plus/Pro/Team plan.
 *
 * No codex subprocess is spawned at request time — we just read its
 * auth file. The `codex` binary is required for `codex login` (which
 * runs the OAuth + PKCE flow that writes auth.json) but is not on the
 * hot path.
 *
 * Subscription model allow-list (May 2026, verified by probing the
 * Responses endpoint directly):
 *
 *   - `gpt-5.4-mini` (default — warm median ~600-1000ms, FASTEST)
 *   - `gpt-5.4`      (warm median ~1.3s, smarter)
 *   - `gpt-5.5`      (warm median ~1.2s, newest frontier model)
 *   - `gpt-5.3-codex` (warm median ~1.0s, code-tuned)
 *
 * Every other name (`gpt-5`, `gpt-5-nano`, `gpt-5-codex`, `o3`,
 * `o4-mini`, `codex-mini-latest`, `gpt-4o`, `gpt-5.4-pro`,
 * `gpt-5.3-instant`, `gpt-5.3-chat-latest`, etc.) returns 400 *"not
 * supported when using Codex with a ChatGPT account"*. The paid
 * `openai` provider supports the full catalogue.
 *
 * Why a separate provider id from `openai`: lets users mix billing
 * paths per-feature — e.g. `agent-rewrite-provider: openai-subscription`
 * (free, slow) while `transform-blank-provider: openai` (paid, full
 * catalogue). Auto-detection would have collapsed that choice.
 *
 * Reference pattern: Zed's ChatGPT subscription provider
 * ([zed-industries/zed#56811]), opencode-openai-codex-auth, LiteLLM.
 * OpenAI's documented "personal local-use" pattern — don't run as a
 * shared/hosted service.
 *
 * apiKey is unused (auth is via the user's `codex login` session), but
 * the field stays in the adapter for shape compatibility.
 */
const OPENAI_SUBSCRIPTION: ProviderAdapter = {
  id: 'openai-subscription',
  displayName: 'OpenAI (ChatGPT subscription)',
  transport: 'cli',
  defaultEndpoint: '', // unused for CLI transport
  defaultModel: 'gpt-5.4-mini',
  // Subscription model allow-list (May 2026, verified by probing the
  // Responses endpoint directly). Every other name returns 400 "not
  // supported when using Codex with a ChatGPT account."
  knownModels: [
    'gpt-5.4-mini',
    'gpt-5.4',
    'gpt-5.5',
    'gpt-5.3-codex',
  ],
  envKeyName: '', // no env var — auth via `codex login`
  buildRequest() {
    throw new Error('openai-subscription: buildRequest is not used (transport is cli)');
  },
  parseResponse() {
    throw new Error('openai-subscription: parseResponse is not used (transport is cli)');
  },
  async invokeCli(req) {
    const model = (req.model || 'gpt-5.4-mini').trim();
    // Lazy import — keeps node:fs / global fetch out of bundles that
    // never need the subscription path (chrome).
    const { invokeCodexResponses, splitMessagesForResponses } = await import('./providers/codex-responses-client');
    const { systemPrompt, userPrompt } = splitMessagesForResponses(req.messages);
    return invokeCodexResponses({ model, systemPrompt, userPrompt });
  },
};

/**
 * Gemini's API takes a fundamentally different shape:
 *   POST /v1beta/models/{model}:generateContent
 *   Header: x-goog-api-key: {apiKey}
 *   { contents: [{ role, parts: [{ text }] }],
 *     generationConfig: { maxOutputTokens, temperature } }
 *
 * Notable differences from OpenAI-shape:
 *   - Auth via `x-goog-api-key` header (per Google's API surface — also
 *     accepts `?key=` query param, but URL-embedded keys have a wider
 *     logging/caching surface: server access logs, proxy logs, browser
 *     history, referrer. Header form keeps it out of URLs. INFOSEC F8.
 *   - Model embedded in URL path (NOT request body).
 *   - System role unsupported in `contents` — must go in
 *     `systemInstruction` separately.
 *   - Response under `candidates[0].content.parts[0].text`.
 *   - Gemini collapses successive same-role messages, so
 *     adjacent user messages get joined with newlines.
 */
const GEMINI: ProviderAdapter = {
  id: 'gemini',
  displayName: 'Gemini',
  // Templated — model is substituted at buildRequest time.
  defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
  // gemini-3.1-flash-lite is Google's cheapest 3.x-class flash tier
  // (released March 2026, GA May 7 2026 at $0.25/M input / $1.50/M
  // output — see https://ai.google.dev/gemini-api/docs/pricing).
  // Picked over the older 2.5-flash because (a) lower price, (b) the
  // model that the May 2026 benchmark sweep actually measured
  // (89-100% across our pipelines, see tests/benchmarks/BENCHMARKS.md).
  // Override per-feature with `<feature>-model:` if you want the
  // 3.1-pro tier for accuracy-critical surfaces.
  defaultModel: 'gemini-3.1-flash-lite',
  // Gemini 3.1 tier (verified May 2026). flash-lite is the default
  // (fastest + cheapest); flash adds vision/audio + better reasoning;
  // pro is the frontier model for deeper writing tasks. Older 2.0
  // family stays reachable via direct file edit.
  knownModels: [
    'gemini-3.1-flash-lite',
    'gemini-flash-latest',
    'gemini-pro-latest',
  ],
  // 2026-06: Google retired the `gemini-3.1-flash` / `gemini-3.1-pro` model
  // names. The new public aliases are `gemini-flash-latest` / `gemini-pro-latest`
  // (always point at the current Gemini 3.x family). flash-lite kept its
  // own name. Smoke runner verifies against live API on each release.
  envKeyName: 'GEMINI_API_KEY',
  buildRequest(req, ctx) {
    const endpointTemplate = ctx.endpoint ?? this.defaultEndpoint;
    const url = endpointTemplate.replace('{model}', encodeURIComponent(req.model));
    // System messages get pulled out into systemInstruction.
    const systemMessages = req.messages.filter((m) => m.role === 'system');
    const nonSystem = req.messages.filter((m) => m.role !== 'system');
    const contents = nonSystem.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const body: Record<string, unknown> = { contents };
    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join('\n\n') }],
      };
    }
    const generationConfig: Record<string, unknown> = {};
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    return {
      // INFOSEC F8: key in header, not URL — keeps it out of access logs,
      // browser history, referrer. URL form (`?key=…`) still works on
      // Google's side but is the higher-exposure shape.
      url,
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': ctx.apiKey,
      },
    };
  },
  parseResponse(rawJson) {
    const data = JSON.parse(rawJson) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
      promptFeedback?: { blockReason?: string };
    };
    if (data.error) throw new Error(`gemini error: ${data.error.message ?? JSON.stringify(data.error)}`);
    if (data.promptFeedback?.blockReason) {
      throw new Error(`gemini blocked: ${data.promptFeedback.blockReason}`);
    }
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? '').join('');
  },
};

/**
 * Anthropic's Messages API — different shape from OpenAI:
 *   POST /v1/messages
 *   Headers:
 *     x-api-key: <key>            (NOT Authorization: Bearer)
 *     anthropic-version: 2023-06-01
 *     content-type: application/json
 *   Body:
 *     { model, max_tokens, system?, messages: [{role, content}] }
 *   Response:
 *     { content: [{type: 'text', text: '...'}], stop_reason, ... }
 *
 * Notable differences:
 *   - System message is a top-level `system` field, NOT in `messages`.
 *     If multiple system messages are passed, they're joined with \n\n.
 *   - `max_tokens` is REQUIRED (Anthropic rejects requests without it),
 *     so we pass a sane default (1024) when the caller didn't set one.
 *   - `temperature` accepts 0–1 (not 0–2 like OpenAI/Gemini); we pass
 *     through and trust the caller — Anthropic clamps internally.
 *   - Response is `content[]` of typed blocks; we concatenate `text`
 *     blocks and ignore tool-use / thinking blocks.
 *   - No `seed`, no `reasoning_effort` (those are OpenAI-only knobs).
 */
const ANTHROPIC: ProviderAdapter = {
  id: 'anthropic',
  displayName: 'Claude',
  defaultEndpoint: 'https://api.anthropic.com/v1/messages',
  // Haiku 4.5 — fastest + cheapest Claude, well-suited to the
  // sub-second cue / blank-fill round-trips OpenCues makes. Users
  // override per-feature for Sonnet 4.6 (better writing) or Opus 4.7
  // (deeper reasoning) on prose-heavy surfaces like agent-rewrite.
  defaultModel: 'claude-haiku-4-5-20251001',
  // Claude 4 tier (May 2026). Haiku 4.5 is the cheap-fast default;
  // Sonnet 4.6 is the balanced default for prose-heavy auditors;
  // Opus 4.7 is the deepest-reasoning frontier model. Older 3.x
  // family stays reachable via direct file edit.
  knownModels: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    // Fable 5 — Mythos-class frontier model (2026-06-09 launch).
    // $10/$50 per M tokens (2× Opus), so the menu lists it but
    // doesn't make it the default for any bucket. Reached by setting
    // an explicit per-feature scalar in OPENCUES.md.
    'claude-fable-5',
  ],
  envKeyName: 'ANTHROPIC_API_KEY',
  buildRequest(req, ctx) {
    const systemMessages = req.messages.filter((m) => m.role === 'system');
    const nonSystem = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: req.model,
      // Anthropic REQUIRES max_tokens. Default matches our other
      // providers' floor when the caller didn't ask for a specific cap.
      max_tokens: req.maxTokens ?? 1024,
      messages: nonSystem,
    };
    if (systemMessages.length > 0) {
      const systemText = systemMessages.map((m) => m.content).join('\n\n');
      // Send `system` as a content-block array with a cache_control
      // breakpoint so Anthropic caches the (static) system prefix. On
      // subsequent calls within the 5-minute ephemeral TTL the cached
      // prefix bills at ~10% of input price (measured: ~90% cheaper input
      // on sonnet for our ~3k-token prompts). The per-call user message
      // sits AFTER the breakpoint and stays uncached — correct, it's the
      // only part that varies. Harmless below a model's cache floor
      // (sonnet/opus cache from ~1k tokens; haiku-4-5's effective floor is
      // ~4-5k, so our 3-3.8k prompts mostly don't cache there): an
      // unmet cache_control is silently ignored — no error, normal price,
      // no write premium (writes only bill extra when caching actually
      // happens). This is a COST optimisation, not latency — at our prompt
      // sizes the cached read doesn't change wall-clock, only the bill.
      body.system = [
        { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
      ];
    }
    // Claude 4.x models reject `temperature` outright (Anthropic API change,
    // June 2026). See `modelRejectsTemperature` for the full matrix.
    if (req.temperature !== undefined && !modelRejectsTemperature('anthropic', req.model)) {
      body.temperature = req.temperature;
    }
    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
        // Required for direct browser calls (Chrome extension content
        // script). Without it Anthropic blocks cross-origin requests
        // even when CORS host permissions are set in the manifest.
        // Server-side calls (CC, OC) accept it as a no-op.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    };
  },
  parseResponse(rawJson) {
    const data = JSON.parse(rawJson) as {
      content?: Array<{ type?: string; text?: string }>;
      error?: { message?: string; type?: string };
      type?: string;
    };
    if (data.error) {
      throw new Error(`anthropic error: ${data.error.message ?? data.error.type ?? JSON.stringify(data.error)}`);
    }
    // Anthropic returns `{type: 'error', error: {...}}` on some failures.
    if (data.type === 'error') {
      throw new Error(`anthropic error: ${JSON.stringify(data)}`);
    }
    const blocks = data.content ?? [];
    return blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  },
};

/**
 * Cerebras Inference — OpenAI-compatible. Notable for very low latency
 * (their wafer-scale silicon) and Llama-family models. Same wire format
 * as Groq / OpenAI / OpenRouter, just a different host.
 *
 * Catalogue (May 2026): `gpt-oss-120b`, `qwen-3-235b-a22b-instruct-2507`,
 * `zai-glm-4.7`. `gpt-oss-120b` is the default — same model Groq
 * ships, runs at ~3000 tokens/sec on Cerebras's wafer-scale silicon
 * (their headline product). Honours `reasoning_effort: low|medium|high`
 * per the OpenAI Responses API shape; 131K context window.
 *
 * Tier note: `gpt-oss-120b` and `zai-glm-4.7` are gated to paid plans.
 * Free / credit-only accounts get HTTP 404 "model does not exist or
 * you do not have access to it" — credits ≠ tier upgrade. Free-tier
 * users override per feature with `cerebras-model:
 * qwen-3-235b-a22b-instruct-2507` (universally available, 235B MoE).
 */
const CEREBRAS: ProviderAdapter = {
  id: 'cerebras',
  // gpt-oss-class models accept seed + prediction + hidden reasoning_format;
  // the predicate keeps reasoning_format off for non-gpt-oss cerebras models.
  // Predicted Outputs: cerebras supports it on gpt-oss + zai-glm only.
  // gemma-4-31b 400s on the `prediction` field (`"prediction" is not
  // currently supported`) — every input ≥200 chars hard-failed → silent
  // verdict-NONE bail. Allowlist the known-supporting families; new
  // cerebras models default OFF (safe). Verified live 2026-06-28.
  capabilities: { seed: true, prediction: (m) => /^gpt-oss/i.test(m) || /^zai-glm/i.test(m), reasoningFormatHidden: (m) => /^gpt-oss/i.test(m) },
  displayName: 'Cerebras',
  defaultEndpoint: 'https://api.cerebras.ai/v1/chat/completions',
  defaultModel: 'gpt-oss-120b',
  // Cerebras catalogue (Jun 2026): `gpt-oss-120b`, `zai-glm-4.7`,
  // `gemma-4-31b`. `gpt-oss-120b` stays the default (fastest reasoning
  // path + Predicted-Outputs + prefix-cache support). `gemma-4-31b` is a
  // NON-reasoning model — handled by the model-name gates (no
  // reasoning_effort, no prediction field, no reasoning_format); benches
  // at parity with gpt-oss-120b on lookups + rewrites at ~2× the speed
  // (tests/results/gemma-hackathon/FINDINGS.md). Other Cerebras names
  // reachable via file edit.
  knownModels: [
    'gpt-oss-120b',
    'zai-glm-4.7',
    'gemma-4-31b',
  ],
  // qwen-3-235b-a22b-instruct-2507 was removed 2026-06: Cerebras's public
  // catalogue (/v1/models) returned only gpt-oss-120b + zai-glm-4.7 against
  // a live key. The smoke runner catches this regression structurally.
  envKeyName: 'CEREBRAS_API_KEY',
  // Cerebras's wafer-scale silicon serves gpt-oss-120b fast enough that
  // `medium` fits every OpenCues pipeline (358ms p50 fluid-blank,
  // well under the 500ms word-cue budget). The only provider in the
  // May 18 2026 bench that sustains useful reasoning on word-cue.
  defaultReasoningEffort: 'medium',
  buildRequest(req, ctx) {
    // Unlike Groq (non-reasoning models silently ignore the field),
    // Cerebras's non-reasoning models hard-error on `reasoning_effort`.
    // Rely on the model-name heuristic so it's only forwarded for
    // gpt-oss-* / qwen-3-thinking-* and similar.
    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: buildOpenAIBody(req, { defaultReasoningEffort: this.defaultReasoningEffort, provider: this.id, capabilities: this.capabilities, maxThinking: ctx.maxThinking }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
    };
  },
  parseResponse: parseOpenAIResponse,
};

/**
 * claude-cli — subscription-backed Anthropic transport via the user's
 * locally-installed `claude` CLI. Bypasses HTTP entirely; routes through
 * a persistent `claude -p` subprocess (one per model+system-prompt pair)
 * that authenticates with the user's Claude Pro/Max subscription.
 *
 * Why not just talk to the API directly? OAuth-token extraction from
 * `~/.claude/.credentials.json` was attempted and explicitly forbidden
 * by Anthropic's Feb 2026 ToS (server-side enforcement; many tokens
 * return 401). The `claude` CLI is the only sanctioned subscription
 * transport.
 *
 * Latency floor: ~700ms direct API + ~140ms CC overhead. Per-model:
 * Haiku p50 840ms, Sonnet p50 1338ms, Opus p50 1982ms (full bench in
 * tests/benchmarks/thinking-budget/CLAUDE-CLI-FINDINGS.md). Not
 * viable for the word-cue ≤500ms surface; comfortable for transform-
 * blank, fluid-blank, agent-rewrite, prompt-improver.
 *
 * The actual subprocess + queue + idle-reap lifecycle lives in
 * providers/claude-cli-daemon.ts. This adapter just dispatches to the
 * global pool — sources call dispatchChat → invokeCli → daemon.invoke.
 *
 * apiKey is unused (the daemon authenticates via the user's `claude`
 * install), but the field stays in the adapter for shape compatibility.
 */
const CLAUDE_CLI: ProviderAdapter = {
  id: 'claude-code-cli',
  displayName: 'Claude Code (CLI, subscription)',
  transport: 'cli',
  defaultEndpoint: '', // unused for CLI transport
  defaultModel: 'haiku', // fastest / cheapest of the supported aliases
  // Aliases the daemon resolves to families. Full Claude model ids
  // (`claude-haiku-4-5-20251001`, etc.) also work via direct file
  // edit; the daemon's resolveModelFamily maps both shapes.
  knownModels: [
    'haiku',
    'sonnet',
    'opus',
    // Subscription users with Pro/Max/Team/Enterprise have free Fable
    // access during the 2026-06-09 → 06-22 intro window, and paid
    // thereafter. The CLI accepts the full id; the daemon's
    // resolveModelFamily routes it to the 'fable' flag table.
    'fable',
    'claude-fable-5',
  ],
  envKeyName: '', // no env var — auth via `claude` install
  buildRequest() {
    // Never called for transport: 'cli'. Throw if it somehow IS called
    // so the bug surfaces immediately instead of silently producing
    // a malformed HTTP request.
    throw new Error('claude-code-cli: buildRequest is not used (transport is cli)');
  },
  parseResponse() {
    throw new Error('claude-code-cli: parseResponse is not used (transport is cli)');
  },
  async invokeCli(req) {
    // Extract system + user prompt from the neutral ChatRequest. The
    // daemon model is "one launched daemon per system prompt" (because
    // --append-system-prompt is a launch-time flag) — the pool keys
    // daemons accordingly.
    const sysParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const userParts = req.messages.filter((m) => m.role !== 'system').map((m) => m.content);
    const systemPrompt = sysParts.join('\n\n');
    const userPrompt = userParts.join('\n\n');
    // Pass `model` through verbatim — accepts both aliases
    // ('haiku'|'sonnet'|'opus') AND full names like
    // 'claude-haiku-4-5-20251001'. The daemon's resolveModelFamily()
    // maps both to the right flag tuning. Unknown names throw there
    // (not here) so a typo surfaces with a clear error including the
    // valid shapes.
    const model = (req.model || 'haiku').trim();
    // Lazy import to avoid pulling child_process into bundles that
    // don't use claude-cli (e.g. the chrome extension). When the
    // adapter is never invoked, this module is never loaded.
    const { getGlobalClaudeCliPool } = await import('./providers/claude-cli-daemon');
    const daemon = getGlobalClaudeCliPool().get(model, systemPrompt);
    return daemon.invoke(userPrompt);
  },
};

/**
 * OpenCode Zen — the curated hosted gateway at opencode.ai. OpenAI-shape
 * chat-completions at `https://opencode.ai/zen/v1/chat/completions`. The
 * gateway hosts both paid and free models; free models do not require an
 * API key (verified May 2026 — anonymous POSTs returned 200 + a
 * `"cost":"0"` field).
 *
 * Model IDs are BARE (e.g. `big-pickle`), not `opencode/<id>` despite
 * what the docs at opencode.ai/docs/zen suggest — the prefixed form
 * 401s with "Model … is not supported". The `/v1/models` GET endpoint
 * is the authoritative live list.
 *
 * Used by the `blanks-llm-provider: opencode-zen + blanks-llm-model: free` mode. The pool of free
 * model IDs is in OPENCODE_ZEN_FREE_POOL (priority order) and
 * `dispatchWithFreePool` walks it on transient failure with 30s
 * health-caching of dead entries.
 *
 * IMPORTANT: free-tier ToS says collected data may be used to improve
 * the models. Never route cues / auditors / agent-rewrite through this
 * adapter — only blanks (the user typed `_`, an opt-in surface).
 */
const OPENCODE_ZEN: ProviderAdapter = {
  id: 'opencode-zen',
  // A gateway over many upstream models — opt into no OpenAI-only params
  // (conservative default; none were sent before this either).
  capabilities: {},
  displayName: 'OpenCode Zen',
  defaultEndpoint: 'https://opencode.ai/zen/v1/chat/completions',
  // First entry of the free pool. Used when no model is explicitly set
  // (most common case for `blanks-llm-provider: opencode-zen`).
  defaultModel: 'big-pickle',
  // OpenCode Zen exposes both paid + free models. `free` is the
  // sentinel routing to the dispatchWithFreePool path (walks
  // OPENCODE_ZEN_FREE_POOL). `big-pickle` is the first free-pool
  // model directly. Paid model ids reachable via direct file edit.
  knownModels: [
    'free',
    'big-pickle',
  ],
  // Optional. Free models work without it; paid models need it.
  envKeyName: 'OPENCODE_ZEN_API_KEY',
  optionalAuth: true,
  // Free-tier ToS says collected inputs may be used to improve the
  // models. Prose-bearing sources (cues / sentence-cues / auditors /
  // agent-rewrite) are refused on this provider by the resolver guard.
  // The user-opt-in `_` blank surface is still allowed.
  trainsOnInput: true,
  // Most free models are reasoning models; low keeps latency reasonable.
  defaultReasoningEffort: 'low',
  buildRequest(req, ctx) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // API key is optional — free models authenticate as anonymous.
    // Don't send a bearer header when the key is empty; some gateways
    // reject `Authorization: Bearer ` (empty bearer) with 401.
    if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: buildOpenAIBody(req, { defaultReasoningEffort: this.defaultReasoningEffort, provider: this.id, capabilities: this.capabilities, maxThinking: ctx.maxThinking }),
      headers,
    };
  },
  parseResponse: parseOpenAIResponse,
};

/**
 * Free-tier model pool in priority order — first entry is preferred.
 * `dispatchWithFreePool` walks this list on transient failure.
 *
 * Ranking from the May 2026 fluid-blank bench (`tests/results/opencode-zen-free/`,
 * 30-case sample, fused mode). Order = accuracy-desc; the latency
 * trade is the user's to accept by editing `free-model-preference:`
 * in OPENCUES.md if they want speed over accuracy.
 *
 *   nemotron-3-super-free   86.7% acc · ~14000ms p50  (winner — slow but solid)
 *   deepseek-v4-flash-free  46.7% acc · ~5000ms p50   (fast, mediocre)
 *   big-pickle              40.0% acc · ~5000ms p50   (a deepseek-v4-flash variant — same speed, worse)
 *
 * Pool entries removed in the May 2026 sweep:
 *   - qwen3.6-plus-free     → moved to paid OpenCode Go (HTTP 402)
 *   - minimax-m2.5-free     → moved to paid OpenCode Go (HTTP 402)
 *
 * The `/v1/models` endpoint is the authoritative live list — entries
 * here that 4xx are health-cached out of rotation for 30s in
 * dispatchWithFreePool, so a quietly-rotated-out model doesn't break
 * the pool. Re-bench when the user reports an unexpected miss rate.
 */
export const OPENCODE_ZEN_FREE_POOL: readonly string[] = [
  'nemotron-3-super-free',
  'deepseek-v4-flash-free',
  'big-pickle',
];

/**
 * In-process health cache for the free pool. Maps model id → epoch ms
 * when the model is allowed to be retried. Modules that need to
 * inspect or reset this (tests, doctor) use the exported reset helper.
 */
const _opencodeZenHealth = new Map<string, number>();

/** Default cool-down before retrying a model that returned a transient failure. */
const FREE_POOL_COOLDOWN_MS = 30_000;

/** Test hook — reset health cache between cases. */
export function _resetOpencodeZenHealthForTesting(): void {
  _opencodeZenHealth.clear();
}

/**
 * Inspect the health cache. Useful for doctor's "which free models are
 * currently down?" diagnostic and for tests asserting cache state.
 */
export function getOpencodeZenHealth(now?: () => number): ReadonlyArray<{ model: string; nextRetryAt: number }> {
  const n = (now ?? (() => Date.now()))();
  return Array.from(_opencodeZenHealth.entries())
    .filter(([_, at]) => at > n)
    .map(([model, nextRetryAt]) => ({ model, nextRetryAt }));
}

/**
 * Dispatch a chat against the OpenCode Zen free pool. Walks
 * `OPENCODE_ZEN_FREE_POOL` in order; on transient failure (rate-limit,
 * outage, model-missing) marks the model unhealthy for 30s and tries
 * the next. Sticky failures (auth, quota) bubble up immediately —
 * they're config issues, not "try a different model" issues.
 *
 * The `req.model` field is overwritten with the pool entry per attempt.
 *
 * Returns the assistant text on first success. Throws an Error with
 * a synthesized message when every pool entry is exhausted.
 *
 * `opts.now` lets tests fake the clock; `opts.pool` lets tests pass a
 * shorter pool. In production both should be omitted.
 */
export async function dispatchWithFreePool(
  httpAdapter: HttpAdapterShape,
  req: ChatRequest,
  ctx: { apiKey: string; endpoint?: string },
  opts: {
    readonly pool?: readonly string[];
    readonly now?: () => number;
    readonly cooldownMs?: number;
    /** Called with classification input on each failed attempt — used by ProviderHealth wiring. */
    readonly onFailure?: (info: { model: string; status?: number; body?: string; cause?: unknown }) => void;
  } = {},
): Promise<string> {
  const pool = opts.pool ?? OPENCODE_ZEN_FREE_POOL;
  const now = opts.now ?? (() => Date.now());
  const cooldown = opts.cooldownMs ?? FREE_POOL_COOLDOWN_MS;
  const errors: string[] = [];
  for (const model of pool) {
    const downUntil = _opencodeZenHealth.get(model) ?? 0;
    if (downUntil > now()) continue; // skip — still in cool-down
    try {
      const result = await dispatchChat(OPENCODE_ZEN, httpAdapter, { ...req, model }, ctx);
      // parseResponse already throws on error envelopes — if we got
      // here with an empty string we treat that as a transient failure
      // too (some free models return empty body on overload).
      if (result === '') {
        _opencodeZenHealth.set(model, now() + cooldown);
        opts.onFailure?.({ model, body: '' });
        errors.push(`${model}: empty response`);
        continue;
      }
      _opencodeZenHealth.delete(model); // mark healthy
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${model}: ${msg}`);
      // Heuristic: if the message smells like auth or quota, bubble
      // immediately — no other model in the pool will work either.
      if (/unauthorized|invalid[_ -]?api[_ -]?key|forbidden|payment[_ -]?required|insufficient[_ -]?(?:quota|credit)/i.test(msg)) {
        opts.onFailure?.({ model, cause: err });
        throw err;
      }
      // Otherwise treat as transient — cool down this model and try next.
      _opencodeZenHealth.set(model, now() + cooldown);
      opts.onFailure?.({ model, cause: err });
    }
  }
  throw new Error(`opencode-zen free pool exhausted: ${errors.join('; ')}`);
}

/**
 * HTTP-adapter wrapper that walks `OPENCODE_ZEN_FREE_POOL` on transient
 * failure. Symmetric in shape with `withFallback` — wraps a base
 * `HttpAdapterShape` and exposes the same `post(url, body, headers)`
 * surface; pool walking is invisible to the caller.
 *
 * Each post:
 *   1. Parses the JSON body to read `body.model`. If the model isn't in
 *      the pool, passes through to the base (no walking — the request
 *      isn't a free-pool request).
 *   2. Walks the pool from the current model. Skips entries still in
 *      health cool-down (the same `_opencodeZenHealth` cache that
 *      `dispatchWithFreePool` uses).
 *   3. On transient failure (looksTransient + auth/quota-bubble rule)
 *      marks the model down and retries with the next pool entry's
 *      model substituted into the body. Auth/quota bubble through
 *      immediately so ProviderHealth can show the right error class.
 *
 * Use this in build-sources.ts when the resolved provider is
 * `opencode-zen` so existing sources (FluidBlankSource etc.) get
 * pool-walking for free.
 */
export function withFreePool(
  base: HttpAdapterShape,
  opts: {
    readonly pool?: readonly string[];
    readonly now?: () => number;
    readonly cooldownMs?: number;
    readonly onFailure?: (info: { model: string; status?: number; body?: string; cause?: unknown }) => void;
  } = {},
): HttpAdapterShape {
  const pool = opts.pool ?? OPENCODE_ZEN_FREE_POOL;
  const now = opts.now ?? (() => Date.now());
  const cooldown = opts.cooldownMs ?? FREE_POOL_COOLDOWN_MS;
  return {
    post: async (url, body, headers) => {
      let parsedBody: { model?: string } | null = null;
      try { parsedBody = JSON.parse(body) as { model?: string }; }
      catch { return base.post(url, body, headers); }            // non-JSON body — passthrough
      const startModel = parsedBody?.model;
      // Pass through requests for models not in the pool — the wrapper
      // is opt-in by virtue of the resolved model. This lets the same
      // adapter be reused safely if a caller mixes routes.
      if (!startModel || !pool.includes(startModel)) return base.post(url, body, headers);
      const errors: string[] = [];
      // Reorder the pool: tried model first, then the rest in pool order.
      const startIdx = pool.indexOf(startModel);
      const ordered = [...pool.slice(startIdx), ...pool.slice(0, startIdx)];
      for (const model of ordered) {
        const downUntil = _opencodeZenHealth.get(model) ?? 0;
        if (downUntil > now()) continue;
        const attemptBody = model === startModel
          ? body
          : JSON.stringify({ ...parsedBody, model });
        try {
          const raw = await base.post(url, attemptBody, headers);
          // Inspect for OpenAI-error envelope without throwing — the
          // wrapper sits BELOW parseResponse, so error envelopes still
          // come back as raw JSON. looksTransient handles both raw
          // bodies and parsed-out envelopes.
          if (looksTransient(raw)) {
            _opencodeZenHealth.set(model, now() + cooldown);
            opts.onFailure?.({ model, body: raw });
            errors.push(`${model}: transient`);
            continue;
          }
          _opencodeZenHealth.delete(model);
          return raw;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Auth / quota are sticky — bubble immediately. No other
          // pool entry can rescue.
          if (/unauthorized|invalid[_ -]?api[_ -]?key|forbidden|payment[_ -]?required|insufficient[_ -]?(?:quota|credit)/i.test(msg)) {
            opts.onFailure?.({ model, cause: err });
            throw err;
          }
          _opencodeZenHealth.set(model, now() + cooldown);
          opts.onFailure?.({ model, cause: err });
          errors.push(`${model}: ${msg}`);
        }
      }
      throw new Error(`opencode-zen free pool exhausted: ${errors.join('; ')}`);
    },
  };
}

const PROVIDERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  groq: GROQ,
  openrouter: OPENROUTER,
  gemini: GEMINI,
  openai: OPENAI,
  'openai-subscription': OPENAI_SUBSCRIPTION,
  anthropic: ANTHROPIC,
  cerebras: CEREBRAS,
  'claude-code-cli': CLAUDE_CLI,
  'opencode-zen': OPENCODE_ZEN,
};

/**
 * Provider auto-route preference order — best → worst — consulted when
 * NO tier (per-cue, per-feature, global) has set a provider. The first
 * entry whose env-var key the user has set is picked.
 *
 * Ranking from the May 2026 5-provider benchmark sweep:
 * - Cerebras first: 1.8-3× faster per call on the same gpt-oss-120b
 *   model that Groq serves, tied accuracy on short-output pipelines,
 *   ~3.5pp behind on long-form rewrites (accepted as the speed trade).
 * - Groq second: accuracy ceiling on long-form, slower but still
 *   competitive everywhere.
 * - Gemini third: 89-100% across the matrix, stable, but pricier and
 *   slower than the gpt-oss tier.
 * - Claude fourth: functional but 3-10× more expensive at parity acc.
 * - OpenAI last: gpt-5.4-mini works on most tasks; gpt-5.4-nano
 *   (the cheaper sibling) was broken on multi-paragraph + long-form
 *   rewrites (reasoning-token starvation), so we default to mini and
 *   leave nano as a per-feature override for cost-sensitive setups.
 * - OpenRouter intentionally excluded — it's a routing layer over
 *   other providers, not a "best for the job" pick on its own merits.
 *
 * Override the auto-route with `llm-provider:` or a per-feature
 * `<feature>-provider:` in OPENCUES.md.
 */
export const PROVIDER_AUTO_ORDER: readonly ProviderId[] = [
  'cerebras',
  'groq',
  'gemini',
  'anthropic',
  'openai',
];

/**
 * Walk the auto-route preference and pick the first provider whose API
 * key the user has supplied. Returns null when the user has no keys at
 * all — in which case the caller can fall back to a hardcoded literal
 * and silent-no-op (no LLM functionality without keys is the documented
 * "OpenCues is fine without an LLM" mode).
 */
export function pickAutoProvider(apiKeys: Readonly<Record<string, string | undefined>>): ProviderId | null {
  for (const id of PROVIDER_AUTO_ORDER) {
    const adapter = PROVIDERS[id];
    if (adapter && apiKeys[adapter.envKeyName]) return id;
  }
  return null;
}

/**
 * Decide whether a provider-bucket scalar value (e.g. for
 * `blanks-llm-provider`) should be ELIGIBLE for the cycling menu given
 * the current set of API keys. Mirrors the chrome popup's "don't show
 * providers whose key isn't entered" behaviour: cycling on a CLI host
 * MUST NOT land on a value the runtime can't actually dispatch with.
 *
 * Eligibility rules:
 *   - `inherit` — always eligible (delegates to global `llm-provider:`
 *     which has its own auto-route fallback).
 *   - `transport: 'cli'` providers (claude-code-cli, openai-subscription)
 *     — eligible iff their CLI binary is on PATH. Caller supplies the
 *     check via `isCliAvailable(providerId)` because `@opencues/core`
 *     doesn't shell out. When the callback is omitted, CLI providers
 *     are conservatively NOT cyclable (matches the chrome popup, which
 *     also can't probe arbitrary binaries).
 *   - `optionalAuth: true` providers (opencode-zen) — eligible (they
 *     authenticate anonymously for the free pool).
 *   - All others — eligible iff `apiKeys[provider.envKeyName]` is set.
 *
 * Unknown ids — NOT eligible. The cycling menu only advertises values
 * the runtime can actually dispatch with; an unrecognised id is treated
 * the same as a broken provider config.
 */
export function isProviderValueCyclable(
  providerId: string,
  apiKeys: Readonly<Record<string, string | undefined>>,
  options: {
    /** Probes whether a `transport: 'cli'` provider's binary is on
     *  PATH. Called only for the CLI subset; omit when callers don't
     *  shell out (e.g. unit tests, chrome). */
    readonly isCliAvailable?: (providerId: string) => boolean;
  } = {},
): boolean {
  if (providerId === 'inherit') return true;
  const canonical = (LEGACY_PROVIDER_ALIASES[providerId] ?? providerId) as ProviderId;
  const adapter = PROVIDERS[canonical];
  if (!adapter) return false;
  if (adapter.transport === 'cli') {
    return options.isCliAvailable?.(canonical) ?? false;
  }
  if (adapter.optionalAuth) return true;
  return Boolean(apiKeys[adapter.envKeyName]);
}

/**
 * Look up a provider adapter by id. Unknown id → null (caller must
 * decide whether to fall back to default or raise). The runtime's
 * config-loader validates the setting at parse time so this rarely
 * returns null in practice.
 */
export function getProvider(id: string | undefined | null): ProviderAdapter | null {
  if (!id) return null;
  const canonical = (LEGACY_PROVIDER_ALIASES[id] ?? id) as ProviderId;
  const found = PROVIDERS[canonical];
  if (!found) {
    warnUnknownProviderOnce(id);
    return null;
  }
  return found;
}

/** All built-in providers. Used by docs + the validate command. */
export function listProviders(): ReadonlyArray<ProviderAdapter> {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]);
}

// ─── Endpoint validation ───────────────────────────────────────────────
//
// A cue / blank / auditor's frontmatter can include `provider:` and
// `endpoint:`. The endpoint is whatever URL the request gets POSTed
// to — meaning a malicious config could route the user's draft to an
// attacker-controlled server. The threat model is the same as cue-
// pack trust: anything the user puts in `~/.cues/` is trusted, but
// users routinely install packs without auditing every URL.
//
// validateEndpoint returns one of three results:
//   - { ok: true, kind: 'default' }       — endpoint omitted; provider default applies
//   - { ok: true, kind: 'stock' }         — endpoint matches the provider's default
//   - { ok: true, kind: 'custom', warning } — custom URL, flagged for the user
//
// The runtime uses the `warning` to log a one-time message per
// (provider, endpoint) pair when a custom endpoint first fires.
// `opencues validate` surfaces it at config-load time too.

export interface EndpointValidation {
  readonly ok: boolean;
  readonly kind: 'default' | 'stock' | 'custom' | 'unknown-provider' | 'invalid-url';
  readonly warning?: string;
}

export function validateEndpoint(
  providerId: string | undefined | null,
  endpoint: string | undefined | null,
): EndpointValidation {
  if (!providerId) return { ok: true, kind: 'default' };
  const provider = PROVIDERS[canonicalizeProviderId(providerId) as ProviderId];
  if (!provider) {
    return {
      ok: false,
      kind: 'unknown-provider',
      warning: `unknown provider "${providerId}" — known: ${PROVIDER_IDS.join(', ')}`,
    };
  }
  if (!endpoint || endpoint.length === 0) return { ok: true, kind: 'default' };

  // Quick URL sanity check — the network adapter will throw on malformed
  // input anyway, but flagging it early lets `opencues validate` surface
  // typos before the first request.
  try { new URL(endpoint); }
  catch {
    return {
      ok: false,
      kind: 'invalid-url',
      warning: `endpoint "${endpoint}" is not a valid URL`,
    };
  }

  if (endpoint === provider.defaultEndpoint) return { ok: true, kind: 'stock' };

  // Custom URL: technically allowed (self-hosted proxies, on-prem
  // gateways, alternate regions), but worth flagging. The runtime is
  // responsible for surfacing the warning to the user before the
  // first request — they implicitly trust the host they're sending
  // their draft to.
  return {
    ok: true,
    kind: 'custom',
    warning:
      `endpoint "${endpoint}" overrides the stock ${providerId} endpoint ` +
      `(${provider.defaultEndpoint}). All LLM requests for this entry — ` +
      `including the user's draft as prompt context — will go to the custom URL. ` +
      `Verify this is a server you trust.`,
  };
}

/**
 * Compact debug-log token for "which LLM was called with what
 * reasoning level". Used by sources (transform-blank, fluid-blank,
 * config-source) so debug consumers can verify a per-provider default
 * actually flowed through to the wire call without inspecting
 * network traces.
 *
 * Pass `req.reasoningEffort` (the caller's explicit value, if any);
 * the helper falls back to the adapter's default and surfaces
 * `(reasoning=off)` when neither set it.
 */
export function describeLLMCall(
  provider: ProviderAdapter,
  model: string,
  reqReasoning?: 'none' | 'low' | 'medium' | 'high',
  overrides?: { maxTokens?: number; temperature?: number },
): string {
  const resolved = reqReasoning ?? provider.defaultReasoningEffort ?? 'off';
  // Surface per-source / per-feature overrides in the log line so
  // operators can SEE that a custom budget or temperature is in
  // effect — otherwise the override fires silently and a misconfig
  // produces "weird LLM behaviour with no obvious cause".
  const extras: string[] = [];
  if (overrides?.maxTokens !== undefined) extras.push(`maxTokens=${overrides.maxTokens}`);
  if (overrides?.temperature !== undefined) extras.push(`temp=${overrides.temperature}`);
  const extrasStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';
  return `${provider.id}/${model} (reasoning=${resolved}${extrasStr})`;
}

/**
 * Convenience: build the wire request for `req` using `providerId`.
 * Wraps `getProvider` + `buildRequest` so callers don't have to care
 * about the lookup. Throws on unknown provider.
 */
export function buildProviderRequest(
  providerId: ProviderId,
  req: ChatRequest,
  ctx: { apiKey: string; endpoint?: string; maxThinking?: boolean },
): BuiltRequest {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  return p.buildRequest(req, ctx);
}

/** Convenience companion to `buildProviderRequest`. */
export function parseProviderResponse(providerId: ProviderId, rawJson: string): string {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  return p.parseResponse(rawJson);
}

/**
 * The full request → response dispatch for an HTTP-backed provider.
 * Wraps the three steps every source repeated identically:
 *   1. provider.buildRequest(req, ctx)            → url + body + headers
 *   2. httpAdapter.post(url, body, headers)       → raw response text
 *   3. provider.parseResponse(raw)                → assistant text
 *
 * Extracted so a future transport variant (e.g. the `claude-cli` daemon,
 * which is subprocess-backed and bypasses HTTP entirely) can be dispatched
 * from a single location instead of editing five call sites in lockstep.
 * Today every provider is HTTP-transport — this helper preserves that
 * exact path. See providers/cli-transport.ts (Phase 2+) for the CLI fork.
 */
/**
 * Optional usage observer — invoked once per dispatch with the
 * provider's reported token accounting. Used for cerebras prefix-cache
 * observability (cached_tokens vs prompt_tokens) so we can confirm
 * the cache is hitting in production logs. Silent when the provider
 * doesn't surface usage details (e.g. on parse error).
 */
export interface UsageReport {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Cerebras-style prefix-cache hit count (0 when the provider doesn't
   *  surface it or the call missed). */
  readonly cachedTokens: number;
  /** cachedTokens / promptTokens. 0..1. */
  readonly cacheHitRate: number;
  /** Predicted-outputs accepted token count (0 when the provider
   *  doesn't surface it, or when no prediction was supplied, or when
   *  none of the prediction tokens matched the actual generation). */
  readonly acceptedPredictionTokens: number;
  /** Predicted-outputs rejected token count. Billed at the output
   *  rate even though the model didn't generate them. */
  readonly rejectedPredictionTokens: number;
  /** acceptedPredictionTokens / (accepted + rejected). 0..1. */
  readonly predictionAcceptRate: number;
}

export async function dispatchChat(
  provider: ProviderAdapter,
  httpAdapter: HttpAdapterShape,
  req: ChatRequest,
  ctx: { apiKey: string; endpoint?: string; signal?: AbortSignal; maxThinking?: boolean; onUsage?: (u: UsageReport) => void },
): Promise<string> {
  // CLI-transport providers (e.g. claude-cli daemon, openai-subscription)
  // handle their own lifecycle and return the assistant text directly.
  // The httpAdapter argument is intentionally ignored — caller still
  // passes it because resolveLLM doesn't know which transport will be
  // picked until after the dispatch, and the call sites are
  // transport-agnostic.
  //
  // TODO: thread `ctx.signal` into `invokeCli` so subprocess providers
  // can also honour the resolver's cancellation. v1 only covers HTTP
  // because that's where the wasted-token cost dominates.
  if (provider.transport === 'cli') {
    if (!provider.invokeCli) {
      throw new Error(`provider ${provider.id} declared transport='cli' but has no invokeCli`);
    }
    return provider.invokeCli(req, ctx);
  }
  // Default HTTP transport — byte-for-byte identical to pre-May-2026
  // inline dispatch at the five source call sites; `signal` flows through
  // to httpAdapter.post so the in-flight request is cancelled when the
  // resolver's generation rolls.
  // One wire attempt — build + post + usage-parse + response-parse for a
  // given request. Pulled into a closure so the prediction-fallback below
  // can re-issue it with the optimisation param stripped.
  const attempt = async (request: ChatRequest): Promise<string> => {
    const built = provider.buildRequest(request, ctx);
    const raw = await httpAdapter.post(built.url, built.body, built.headers, { signal: ctx.signal });
    // Cerebras prefix-cache observability (PR June 2026). Parse the
    // usage block from the raw OpenAI-compatible response and log
    // cached_tokens when the caller supplied a logger. Cerebras returns
    // `usage.prompt_tokens_details.cached_tokens` on gpt-oss-120b /
    // zai-glm-4.7 — see https://inference-docs.cerebras.ai/capabilities/prompt-caching
    // OpenAI also surfaces this field on some models. Non-cerebras /
    // non-openai providers may not include it; the log line is silent
    // in that case so we don't pollute /tmp/opencues.log on providers
    // that don't cache. See CLAUDE.md § "Cerebras prefix caching" for
    // the optimisation rationale.
    if (ctx.onUsage) {
      try {
        const parsed = JSON.parse(raw) as {
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            completion_tokens_details?: {
              accepted_prediction_tokens?: number;
              rejected_prediction_tokens?: number;
            };
          };
        };
        const u = parsed.usage;
        if (u && typeof u.prompt_tokens === 'number') {
          const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
          const accepted = u.completion_tokens_details?.accepted_prediction_tokens ?? 0;
          const rejected = u.completion_tokens_details?.rejected_prediction_tokens ?? 0;
          const predTotal = accepted + rejected;
          ctx.onUsage({
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens ?? 0,
            cachedTokens: cached,
            cacheHitRate: u.prompt_tokens > 0 ? cached / u.prompt_tokens : 0,
            acceptedPredictionTokens: accepted,
            rejectedPredictionTokens: rejected,
            predictionAcceptRate: predTotal > 0 ? accepted / predTotal : 0,
          });
        }
      } catch { /* malformed usage block — silent */ }
    }
    return provider.parseResponse(raw);
  };

  // Rate-limit retry with exponential backoff. Free / hackathon-tier keys
  // enforce tight RPM/TPM quotas; the provider throws
  // `request_quota_exceeded` / `too_many_requests` / `queue_exceeded`.
  // Without a retry the call hard-fails and the whole transform/lookup
  // bails (silent verdict-NONE) — observed live 2026-06-28 against a
  // hackathon cerebras key where 245/251 transform-blank cases bailed
  // purely from RPM throttling. A bounded backoff degrades a throttled
  // key to "slower", not "broken". Only fires on genuine rate-limit
  // errors, so un-throttled calls keep their single-attempt latency.
  // Default 4 retries (~0.5/1/2/4s); override via OPENCUES_RATE_LIMIT_RETRIES.
  for (let rlAttempt = 0; ; rlAttempt++) {
    try {
      return await attempt(req);
    } catch (err) {
      // Prediction-fallback. The predicted-outputs `prediction` hint is a
      // perf optimisation, not a correctness feature. Some providers
      // (cerebras gpt-oss-120b, INTERMITTENTLY) reject it mid-session with
      // "property 'prediction' is unsupported", which would otherwise hard-
      // fail the whole transform. When prediction was actually sent (only
      // TransformBlank's predicted-outputs path sets it) and the error is
      // that specific rejection, retry ONCE WITHOUT it — a strict subset of
      // the original request, guaranteed valid, can't recur. Every other
      // call keeps the original single-attempt behaviour and real errors
      // still surface unchanged.
      if (req.prediction !== undefined && isPredictionUnsupportedError(err)) {
        return attempt({ ...req, prediction: undefined });
      }
      if (isRateLimitError(err) && rlAttempt < RATE_LIMIT_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_BASE_MS * Math.pow(2, rlAttempt)));
        continue;
      }
      throw err;
    }
  }
}

const RATE_LIMIT_MAX_RETRIES = Number(process.env.OPENCUES_RATE_LIMIT_RETRIES ?? 4);
const RATE_LIMIT_BASE_MS = 500;

/** True when an LLM error is a provider rejecting the request for quota /
 *  rate-limit reasons (RPM or TPM). Mirrors the token set `looksTransient`
 *  matches on the raw body, but operates on a thrown Error's message. */
export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /too[_ -]?many[_ -]?requests|rate[_ -]?limit|quota[_ -]?exceeded|request_quota_exceeded|queue[_ -]?exceeded|"?429"?/.test(msg);
}

/** True when an LLM error is a provider rejecting the predicted-outputs
 *  `prediction` field (e.g. cerebras "property 'prediction' is
 *  unsupported"). Matched on both tokens so unrelated errors that merely
 *  mention one word don't trigger the strip-and-retry fallback. */
export function isPredictionUnsupportedError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Match every "prediction (un)supported" phrasing seen in the wild:
  // openrouter's "property 'prediction' is unsupported" AND cerebras
  // gemma-4-31b's "\"prediction\" is not currently supported". Keyed on
  // `prediction` + a support-rejection token so unrelated errors that
  // merely mention one word don't trigger the strip-and-retry.
  return msg.includes('prediction') && (msg.includes('unsupported') || msg.includes('not supported') || msg.includes('not currently supported'));
}

/**
 * Resolve a (provider, model, endpoint, apiKey) tuple from a
 * settings hierarchy. Used by every LLM call site so the same precedence
 * rules apply everywhere.
 *
 * Precedence (most specific wins):
 *   1. Per-source override (`opts.providerOverride`, `opts.modelOverride`)
 *      — read from per-cue or per-blank frontmatter by the caller.
 *   2. Per-feature default (`opts.featureProvider`, `opts.featureModel`)
 *      — read from the per-feature frontmatter key by the caller
 *      (e.g. `agent-provider`, `fluid-blank-model`).
 *   3. Global default (`opts.globalProvider`, `opts.globalModel`).
 *   4. Built-in defaults (cerebras + gpt-oss-120b). See note in
 *      `resolveLLM` for the May 2026 benchmark justifying this choice.
 *
 * The endpoint follows the resolved provider — passing a custom
 * endpoint with a non-matching provider is a misconfiguration that
 * usually means the user typoed the provider name; we don't mix.
 *
 * API keys are pulled from `apiKeys` keyed by env-var name. The boot
 * layer populates this map from `process.env`; tests can pass in a
 * literal map.
 */
export interface ResolveLLMOptions {
  readonly providerOverride?: string | null;
  readonly modelOverride?: string | null;
  readonly featureProvider?: string | null;
  readonly featureModel?: string | null;
  readonly globalProvider?: string | null;
  readonly globalModel?: string | null;
  readonly endpointOverride?: string | null;
  readonly apiKeys: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedLLM {
  readonly provider: ProviderAdapter;
  readonly model: string;
  readonly endpoint: string;
  readonly apiKey: string;
  /**
   * Optional automatic fallback target. When the primary's HTTP layer
   * returns a transient error (429 rate-limit, 5xx, network failure),
   * `withFallback()` re-issues against this target. Currently only
   * populated for OpenAI-shape ↔ OpenAI-shape pairs (groq ↔ cerebras),
   * where the request body is wire-compatible with only URL + auth +
   * model-name swaps needed.
   *
   * Skipped for cross-shape pairs (e.g. groq → gemini) because the
   * body would have to be rebuilt from scratch — that's a different
   * code path.
   */
  readonly fallback?: ResolvedLLM | null;
}

/**
 * Default fallback pairs — providers with wire-compatible (OpenAI-shape)
 * APIs that can stand in for each other without rebuilding the request
 * body. Currently just groq ↔ cerebras (both run gpt-oss-120b at the
 * exact same OpenAI-compat shape; only URL + auth + model-name differ).
 *
 * Intentionally NOT included:
 *   - openai ↔ groq: openai's gpt-5/o-series uses `max_completion_tokens`
 *     while groq still uses `max_tokens` — body would have to be
 *     rewritten on fallback. Doable later; not critical.
 *   - anthropic, gemini: completely different wire shape, no shared
 *     body possible.
 */
const FALLBACK_PAIRS: Readonly<Record<ProviderId, ProviderId | undefined>> = {
  groq: 'cerebras',
  cerebras: 'groq',
  openrouter: undefined,
  openai: undefined,
  // openai-subscription is a different transport entirely (CLI/OAuth);
  // no HTTP peer to fall back to.
  'openai-subscription': undefined,
  anthropic: undefined,
  gemini: undefined,
  // claude-code-cli is a different transport entirely — no HTTP peer to
  // fall back to. If the subscription daemon dies, the user picks a
  // different provider in OPENCUES.md.
  'claude-code-cli': undefined,
  // opencode-zen has its own pool-walking dispatcher
  // (dispatchWithFreePool); no cross-provider fallback needed.
  'opencode-zen': undefined,
};

/**
 * Per-provider model-name translation for fallback. Same weights, but
 * the namespace differs: Groq prefixes vendor-original names with
 * `openai/`, Cerebras serves them bare. This map lets the fallback
 * wrapper rewrite the model field on retry.
 */
const FALLBACK_MODEL_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  groq: {
    'openai/gpt-oss-120b': 'gpt-oss-120b',
    'openai/gpt-oss-20b': 'gpt-oss-20b',
  },
  cerebras: {
    'gpt-oss-120b': 'openai/gpt-oss-120b',
    'gpt-oss-20b': 'openai/gpt-oss-20b',
  },
};

function translateModelToFallback(fromProvider: ProviderId, toProvider: ProviderId, model: string): string {
  return FALLBACK_MODEL_MAP[fromProvider]?.[model] ?? model;
}

/**
 * Per-provider model-name CANONICALIZATION — normalise a known
 * cross-namespace alias INTO the resolved provider's own namespace, on
 * the PRIMARY dispatch path (not just fallback). Same weights, different
 * namespace prefix: Groq / OpenRouter serve gpt-oss as `openai/gpt-oss-*`,
 * Cerebras serves it bare as `gpt-oss-*`.
 *
 * This is the "always land on a VALID (provider, model) pair" guarantee:
 * a stale or mistyped `llm-model: openai/gpt-oss-120b` paired with an
 * auto-routed-or-explicit Cerebras provider is healed to `gpt-oss-120b`
 * BEFORE the call, instead of being shipped invalid and bouncing as a
 * `model_not_found`. The map is the inverse-direction sibling of
 * `FALLBACK_MODEL_MAP` (which translates AWAY from a provider toward its
 * fallback peer); this one translates TOWARD the provider.
 *
 * Deliberately narrow: only the gpt-oss family, whose namespace rules we
 * actually know. An unknown / genuinely-wrong model is left UNTOUCHED so
 * the provider can reject it and the runtime can surface that rejection
 * inline (model-not-found) — we never silently rewrite a model we don't
 * recognise, and we never hide a real misconfiguration.
 */
const PROVIDER_MODEL_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cerebras: {
    'openai/gpt-oss-120b': 'gpt-oss-120b',
    'openai/gpt-oss-20b': 'gpt-oss-20b',
  },
  groq: {
    'gpt-oss-120b': 'openai/gpt-oss-120b',
    'gpt-oss-20b': 'openai/gpt-oss-20b',
  },
  openrouter: {
    'gpt-oss-120b': 'openai/gpt-oss-120b',
    'gpt-oss-20b': 'openai/gpt-oss-20b',
  },
};

/** Normalise `model` into `providerId`'s namespace when it's a known
 *  cross-namespace alias; otherwise return it unchanged. */
export function canonicalizeModelForProvider(providerId: string, model: string): string {
  return PROVIDER_MODEL_ALIASES[providerId]?.[model] ?? model;
}

// Host-injectable warning sink. Native hosts (CC/OC/gemini-cli) leave
// this at the console.warn default — they have a real terminal and
// the warns are user-actionable diagnostics. Chrome overrides it at
// boot to route through its debug-gated logger so these one-time
// warnings respect the `debug-mode: off` setting in OPENCUES.md.
// Without the override, every page-load with a misconfigured provider
// floods the devtools console (visible without any opt-in), which is
// confusing for users who never asked for debug spam.
type CoreWarnFn = (msg: string) => void;
const _defaultCoreWarn: CoreWarnFn = (msg) => {
  try { /* eslint-disable-next-line no-console */ console.warn(msg); } catch { /* host may have no console */ }
};
let _coreWarn: CoreWarnFn = _defaultCoreWarn;
export function setCoreWarn(fn: CoreWarnFn | null): void {
  _coreWarn = fn ?? _defaultCoreWarn;
}

// Dedup set for the one-time runtime warning. Keyed by `${id}|${url}`.
const _warnedEndpoints = new Set<string>();
function warnCustomEndpointOnce(providerId: string, endpoint: string): void {
  const key = `${providerId}|${endpoint}`;
  if (_warnedEndpoints.has(key)) return;
  _warnedEndpoints.add(key);
  _coreWarn(
    `[opencues] custom LLM endpoint in use: provider=${providerId} ` +
    `endpoint=${endpoint} — draft is sent as prompt context. ` +
    `Run "opencues validate" or check the source cue/blank to confirm trust.`,
  );
}

// One-time warnings for misconfiguration that previously silent-no-op'd.
// These exist because `resolveLLM` returning null is BY DESIGN — callers
// (FluidBlank, TransformBlank, WordCues, …) treat null as "no LLM
// configured, skip silently." That's right when nothing is set; it's
// catastrophic when a provider IS chosen but its key is absent, because
// the user typed an LLM-driven trigger and got nothing back with no
// signal at all. Caused the May 2026 chrome regression where
// `llm-provider: gemini` worked in opencode but silently no-op'd on
// chrome (chrome storage adapter dropped every non-groq key).
const _warnedMissingKeys = new Set<string>();
function warnMissingKeyOnce(providerId: string, envKeyName: string): void {
  const key = `missing|${providerId}|${envKeyName}`;
  if (_warnedMissingKeys.has(key)) return;
  _warnedMissingKeys.add(key);
  _coreWarn(
    `[opencues] provider "${providerId}" is configured but ${envKeyName} ` +
    `is not set. Every LLM-driven cue/blank routed to this provider will ` +
    `silently do nothing until the key is provided. Fix: set ${envKeyName} ` +
    `in your env (CC/OC/gemini-cli read from process.env + ~/.cues/.env), ` +
    `or in the OpenCues popup → Settings (chrome). To verify configured ` +
    `keys: \`opencues check-keys\`.`,
  );
}

const _warnedUnknownProviders = new Set<string>();
function warnUnknownProviderOnce(providerId: string): void {
  if (_warnedUnknownProviders.has(providerId)) return;
  _warnedUnknownProviders.add(providerId);
  _coreWarn(
    `[opencues] unknown provider "${providerId}" referenced in config. ` +
    `Known providers: ${PROVIDER_IDS.join(', ')}. ` +
    `Check your OPENCUES.md for typos in \`llm-provider:\` / \`<feature>-provider:\`.`,
  );
}

/** Test-only — reset the warn dedup sets so each test sees a fresh
 *  warning state. Not exported to public API; used by *.test.ts files
 *  that exercise the warning paths back-to-back. */
export function _resetWarnDedupForTesting(): void {
  _warnedEndpoints.clear();
  _warnedMissingKeys.clear();
  _warnedUnknownProviders.clear();
}

export function resolveLLM(opts: ResolveLLMOptions): ResolvedLLM | null {
  // Three tiers, most → least specific. The Map index doubles as a
  // specificity score (lower = more specific). Provider and model are
  // resolved INDEPENDENTLY but with one constraint: a model is only
  // honored if its tier is at least as specific as the tier that set
  // the provider. This stops a less-specific (provider, model) pair
  // from leaking its model into a more-specific provider override —
  // e.g. `llm-model: gpt-oss` (groq) shouldn't apply to a per-feature
  // `agent-provider: gemini` override.
  const tiers: Array<{ p?: string | null; m?: string | null }> = [
    { p: opts.providerOverride, m: opts.modelOverride },
    { p: opts.featureProvider, m: opts.featureModel },
    { p: opts.globalProvider, m: opts.globalModel },
  ];
  let providerTierIdx = -1;
  for (let i = 0; i < tiers.length; i += 1) {
    if (tiers[i].p) { providerTierIdx = i; break; }
  }
  // No-tier-set path: AUTO-ROUTE over the user's available API keys.
  // Picks the first provider from PROVIDER_AUTO_ORDER whose env-var key
  // is set in `opts.apiKeys`. Ranking comes from the May 2026 5-provider
  // benchmark sweep (tests/benchmarks/BENCHMARKS.md): Cerebras first
  // because it's 1.8-3× faster per call at parity-or-better accuracy
  // on short-output pipelines (fluid-blank, word-cues) AND because its
  // 3.5pp accuracy drop on transform-blank long-form rewrites was
  // judged an acceptable trade for the speed win on interactive UX.
  // OpenAI is last (broken on most of our tasks, but better than a
  // silent no-op for users who only have an OpenAI key).
  //
  // Hardcoded `'cerebras'` as the ultimate fallback if the user has
  // zero keys — that path silent-no-ops downstream (warnMissingKeyOnce
  // is suppressed when no tier picked it), so the literal here only
  // matters for "no keys, but we still need to emit a ProviderId".
  const autoPicked = providerTierIdx >= 0 ? null : pickAutoProvider(opts.apiKeys);
  const providerId = canonicalizeProviderId(
    providerTierIdx >= 0
      ? tiers[providerTierIdx].p!.trim()
      : (autoPicked ?? 'cerebras')
  ) as ProviderId;
  const provider = PROVIDERS[providerId];
  if (!provider) {
    warnUnknownProviderOnce(providerId);
    return null;
  }

  let model: string | null = null;
  for (let i = 0; i < tiers.length; i += 1) {
    const m = tiers[i].m;
    if (!m) continue;
    // Only carry the model if it's at least as specific as the provider tier
    // (or no provider tier was set, in which case we fell back to groq and
    // any tier's model is fair game).
    if (providerTierIdx === -1 || i <= providerTierIdx) {
      model = m;
      break;
    }
  }
  // Canonicalize the model INTO the resolved provider's namespace so we
  // always land on a valid pair. No-op for the provider's own defaultModel
  // and for any model we don't recognise; heals known cross-namespace
  // aliases (e.g. a stale `openai/gpt-oss-120b` paired with Cerebras).
  const resolvedModel = canonicalizeModelForProvider(providerId, (model ?? provider.defaultModel).trim());
  const endpoint = opts.endpointOverride ?? provider.defaultEndpoint;
  // CLI-transport providers have external auth (e.g. claude-cli uses
  // the user's locally-installed `claude` session) — no API key in
  // opts.apiKeys. Skip the key check and the fallback-peer machinery
  // (no HTTP peer exists for a CLI transport).
  if (provider.transport === 'cli') {
    return {
      provider,
      model: resolvedModel,
      endpoint, // unused but kept for ResolvedLLM shape compat
      apiKey: '',
      fallback: null,
    };
  }
  const apiKey = opts.apiKeys[provider.envKeyName];
  if (!apiKey) {
    // Providers that opt into anonymous auth (today: opencode-zen for
    // the free model pool) resolve with apiKey: '' instead of bailing.
    // The provider's buildRequest is responsible for omitting the
    // Authorization header when the key is empty.
    if (provider.optionalAuth) {
      return { provider, model: resolvedModel, endpoint, apiKey: '', fallback: null };
    }
    // Only warn when a provider was EXPLICITLY chosen (any tier set it).
    // If no provider was set and we defaulted to cerebras, the user simply
    // hasn't configured any LLM yet — that's "OpenCues without LLM is
    // fine" mode, not a misconfiguration. The boot-level "no key
    // configured" notice handles that case once.
    if (providerTierIdx >= 0) {
      warnMissingKeyOnce(providerId, provider.envKeyName);
    }
    return null;
  }

  // One-time security warning when a non-stock endpoint is resolved.
  // The user's draft is sent as prompt context, so a custom URL is
  // worth flagging at runtime in case the user installed a cue pack
  // without running `opencues validate`. Once per (provider, endpoint)
  // pair, dedup'd in-process.
  if (endpoint !== provider.defaultEndpoint) {
    warnCustomEndpointOnce(providerId, endpoint);
  }

  // Auto-attach a fallback target when:
  //   1. The resolved provider has a wire-compatible peer in FALLBACK_PAIRS.
  //   2. That peer's API key is also present in apiKeys.
  // No-op when the user is on a single provider.
  let fallback: ResolvedLLM | null = null;
  const peerId = FALLBACK_PAIRS[providerId];
  if (peerId) {
    const peer = PROVIDERS[peerId];
    const peerKey = opts.apiKeys[peer.envKeyName];
    if (peerKey) {
      fallback = {
        provider: peer,
        // Map model name across providers (groq's `openai/gpt-oss-120b`
        // ↔ cerebras's `gpt-oss-120b`). Falls through unchanged when no
        // mapping exists — caller's model name is assumed compatible.
        model: translateModelToFallback(providerId, peerId, resolvedModel),
        endpoint: peer.defaultEndpoint,
        apiKey: peerKey,
      };
    }
  }

  return { provider, model: resolvedModel, endpoint, apiKey, fallback };
}

/**
 * Heuristic: does this response body indicate a TRANSIENT failure
 * (rate-limit, server overload, network blip) where retrying on the
 * fallback provider would help?
 *
 * Conservative — false positives mean wasted bandwidth, false negatives
 * mean the user sees the failure when fallback could have rescued it.
 * We err on the false-positive side because the fallback retry is
 * cheap.
 */
function looksTransient(raw: string): boolean {
  if (!raw || raw.trim().length === 0) return true;       // empty body = upstream timeout
  // OpenAI-shape error envelopes (Groq, Cerebras, OpenAI, OpenRouter all use this).
  if (/"code"\s*:\s*"?(429|5\d{2})"?/.test(raw)) return true;
  if (/too[_ -]?many[_ -]?requests|rate[_ -]?limit/i.test(raw)) return true;
  if (/server[_ -]?error|service[_ -]?unavailable|overloaded|timeout/i.test(raw)) return true;
  if (/queue[_ -]?exceeded|queue[_ -]?full/i.test(raw)) return true;
  // Billing failures — strictly not "transient" in the time sense, but
  // the user-visible behaviour we want IS to fall back to a working
  // provider so the runtime stays useful while the billing issue is
  // resolved. Caught 2026-05-18 via the agentic harness against a
  // Cerebras account out of credits — 402 / payment_required was
  // returning empty content silently across every source.
  if (/"code"\s*:\s*"?(402|payment_required|insufficient_quota)"?/i.test(raw)) return true;
  if (/payment[_ -]?required|insufficient[_ -]?(?:quota|credit|balance)|out[_ -]?of[_ -]?credit/i.test(raw)) return true;
  return false;
}

/**
 * Wrap an HTTP adapter so transient failures auto-retry against the
 * fallback target. Pass `resolved.fallback` (returned by `resolveLLM`)
 * — when null, the wrapper is a no-op and just delegates.
 *
 * The wrapper assumes wire-compatible providers (OpenAI-shape ↔
 * OpenAI-shape). Cross-shape fallback (e.g. groq → gemini) requires
 * rebuilding the request body, which lives elsewhere — `resolveLLM`
 * intentionally won't pair across shapes.
 *
 * On retry the wrapper:
 *   1. Swaps the URL to the fallback's endpoint.
 *   2. Replaces the bearer auth header with the fallback's key.
 *   3. Rewrites `body.model` to the fallback's model name (since groq
 *      prefixes vendor-original names with `openai/` and cerebras
 *      doesn't).
 */
export interface HttpAdapterShape {
  /** `options.signal` cancels the in-flight request. Optional —
   *  callers that don't pass options get legacy behaviour. */
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

export function withFallback(base: HttpAdapterShape, fallback: ResolvedLLM | null | undefined): HttpAdapterShape {
  if (!fallback) return base;
  return {
    post: async (url, body, headers, options) => {
      const tryFallback = async (): Promise<string> => {
        let fallbackBody = body;
        try {
          const parsed = JSON.parse(body) as { model?: string };
          if (parsed.model && parsed.model !== fallback.model) {
            parsed.model = fallback.model;
            fallbackBody = JSON.stringify(parsed);
          }
        } catch { /* non-JSON body (Anthropic-shape) — pass through unchanged */ }
        const fbHeaders = { ...headers };
        // OpenAI-shape providers all use bearer auth; swap it.
        fbHeaders.Authorization = `Bearer ${fallback.apiKey}`;
        return base.post(fallback.endpoint, fallbackBody, fbHeaders, options);
      };

      let primary: string;
      try {
        primary = await base.post(url, body, headers, options);
      } catch (err) {
        // Abort propagates without trying the fallback — the whole
        // resolve was cancelled; retrying defeats the cancel.
        if (isAbortError(err)) throw err;
        // Network / timeout / agent error — try fallback.
        try {
          return await tryFallback();
        } catch (fbErr) {
          if (isAbortError(fbErr)) throw fbErr;
          throw err;                                       // both failed → bubble the original
        }
      }
      if (looksTransient(primary)) {
        try {
          return await tryFallback();
        } catch (fbErr) {
          if (isAbortError(fbErr)) throw fbErr;
          return primary;                                  // fallback also failed → return primary's error body
        }
      }
      return primary;
    },
  };
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}
