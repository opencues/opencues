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

export type ProviderId = 'groq' | 'openrouter' | 'gemini' | 'openai' | 'anthropic' | 'cerebras' | 'claude-cli';

export const PROVIDER_IDS: readonly ProviderId[] = ['groq', 'openrouter', 'gemini', 'openai', 'anthropic', 'cerebras', 'claude-cli'];

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
  /** The env-var name the boot layer reads to find this provider's API key. */
  readonly envKeyName: string;
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
   * Translate the neutral ChatRequest into wire format for this provider.
   * Required for `transport: 'http'` (the default). CLI-transport
   * providers may stub this — it's never called.
   */
  buildRequest(req: ChatRequest, ctx: { apiKey: string; endpoint?: string }): BuiltRequest;
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
  invokeCli?(req: ChatRequest, ctx: { apiKey: string; endpoint?: string }): Promise<string>;
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
function buildOpenAIBody(req: ChatRequest, opts?: { includeReasoningEffort?: boolean; useCompletionTokensName?: boolean; defaultReasoningEffort?: 'none' | 'low' | 'medium' | 'high' }): string {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  // Resolve the reasoning level FIRST so the max_tokens pairing below
  // can see it. Caller's explicit value wins over the adapter default.
  const isReasoningModelName = /^(o\d|gpt-5|gpt-oss|qwen-3-thinking)/i.test(req.model);
  const reasoningForwarded = opts?.includeReasoningEffort || isReasoningModelName;
  const reasoning = reasoningForwarded
    ? (req.reasoningEffort ?? opts?.defaultReasoningEffort)
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
  // gpt-5 / o-series lock temperature to 1 — passing any other value
  // (including 0) returns HTTP 400 "Only the default (1) value is
  // supported." `useCompletionTokensName` correlates 1:1 with this
  // restriction, so re-use the flag rather than threading a second.
  if (req.temperature !== undefined && !opts?.useCompletionTokensName) body.temperature = req.temperature;
  if (req.seed !== undefined) body.seed = req.seed;
  // Pass reasoning_effort only when the provider opts in OR the model
  // name suggests it's an OpenAI reasoning model (o1/o3/o4/gpt-5).
  // Leaves gpt-4o-mini-class models alone, where the field 400s.
  if (reasoning !== undefined) {
    body.reasoning_effort = reasoning;
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
// Built-in providers
// ---------------------------------------------------------------------

const GROQ: ProviderAdapter = {
  id: 'groq',
  displayName: 'Groq',
  defaultEndpoint: 'https://api.groq.com/openai/v1/chat/completions',
  defaultModel: 'openai/gpt-oss-120b',
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
      body: buildOpenAIBody(req, { includeReasoningEffort: true, defaultReasoningEffort: this.defaultReasoningEffort }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
    };
  },
  parseResponse: parseOpenAIResponse,
};

const OPENROUTER: ProviderAdapter = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  defaultEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
  // Free-tier non-llama default. `openai/gpt-oss-120b:free` is the same
  // gpt-oss-120b model Groq ships, just hosted on OpenRouter's free
  // tier — gives users a free fallback when their primary provider is
  // rate-limited or down. Users override per-feature for paid models.
  defaultModel: 'openai/gpt-oss-120b:free',
  envKeyName: 'OPENROUTER_API_KEY',
  // OpenRouter is a multi-model router — `low` is the cross-model safe
  // default that mirrors what every call site used to hardcode. Picks
  // a sensible level for whichever underlying gpt-oss / gpt-5 / o-series
  // model the user routes to without overshooting latency budgets.
  defaultReasoningEffort: 'low',
  buildRequest(req, ctx) {
    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: buildOpenAIBody(req, { defaultReasoningEffort: this.defaultReasoningEffort }),
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
  displayName: 'OpenAI',
  defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
  // gpt-5.4-mini (released March 2026) — mid-tier in the OpenAI lineup
  // at $0.75/$4.50 per 1M in/out. Picked as the default over gpt-5.4-nano
  // ($0.20/$1.25) after the May 2026 benchmark sweep showed nano
  // collapsing on multi-paragraph (0% on transform-blank 3-pass/fused/
  // fused-verify) and long-form rewrites — the reasoning model spends
  // its `max_completion_tokens` budget on internal reasoning and runs out
  // before producing the rest of the output. Mini has enough budget to
  // actually complete the task on long inputs. Users who want the cheaper
  // tier can override per-feature with `openai-model: gpt-5.4-nano`.
  defaultModel: 'gpt-5.4-mini',
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
      body: buildOpenAIBody(reqForBody, { useCompletionTokensName, defaultReasoningEffort: this.defaultReasoningEffort }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
    };
  },
  parseResponse: parseOpenAIResponse,
};

/**
 * Gemini's API takes a fundamentally different shape:
 *   POST /v1beta/models/{model}:generateContent?key={apiKey}
 *   { contents: [{ role, parts: [{ text }] }],
 *     generationConfig: { maxOutputTokens, temperature } }
 *
 * Notable differences from OpenAI-shape:
 *   - Auth via `?key=` query param (NOT bearer header).
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
      // Gemini auth is query param, not header. The api key never goes
      // in a body field, so logging the body is safe.
      url: `${url}?key=${encodeURIComponent(ctx.apiKey)}`,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
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
      body.system = systemMessages.map((m) => m.content).join('\n\n');
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
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
  displayName: 'Cerebras',
  defaultEndpoint: 'https://api.cerebras.ai/v1/chat/completions',
  defaultModel: 'gpt-oss-120b',
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
      body: buildOpenAIBody(req, { defaultReasoningEffort: this.defaultReasoningEffort }),
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
  id: 'claude-cli',
  displayName: 'Claude (CLI, subscription)',
  transport: 'cli',
  defaultEndpoint: '', // unused for CLI transport
  defaultModel: 'haiku', // fastest / cheapest of the supported aliases
  envKeyName: '', // no env var — auth via `claude` install
  buildRequest() {
    // Never called for transport: 'cli'. Throw if it somehow IS called
    // so the bug surfaces immediately instead of silently producing
    // a malformed HTTP request.
    throw new Error('claude-cli: buildRequest is not used (transport is cli)');
  },
  parseResponse() {
    throw new Error('claude-cli: parseResponse is not used (transport is cli)');
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
    const modelAlias = (req.model || 'haiku') as 'haiku' | 'sonnet' | 'opus';
    if (modelAlias !== 'haiku' && modelAlias !== 'sonnet' && modelAlias !== 'opus') {
      throw new Error(`claude-cli: unsupported model "${req.model}" — use haiku | sonnet | opus`);
    }
    // Lazy import to avoid pulling child_process into bundles that
    // don't use claude-cli (e.g. the chrome extension). When the
    // adapter is never invoked, this module is never loaded.
    const { getGlobalClaudeCliPool } = await import('./providers/claude-cli-daemon');
    const daemon = getGlobalClaudeCliPool().get(modelAlias, systemPrompt);
    return daemon.invoke(userPrompt);
  },
};

const PROVIDERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  groq: GROQ,
  openrouter: OPENROUTER,
  gemini: GEMINI,
  openai: OPENAI,
  anthropic: ANTHROPIC,
  cerebras: CEREBRAS,
  'claude-cli': CLAUDE_CLI,
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
 * Look up a provider adapter by id. Unknown id → null (caller must
 * decide whether to fall back to default or raise). The runtime's
 * config-loader validates the setting at parse time so this rarely
 * returns null in practice.
 */
export function getProvider(id: string | undefined | null): ProviderAdapter | null {
  if (!id) return null;
  const found = PROVIDERS[id as ProviderId];
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
  const provider = PROVIDERS[providerId as ProviderId];
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
  ctx: { apiKey: string; endpoint?: string },
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
export async function dispatchChat(
  provider: ProviderAdapter,
  httpAdapter: HttpAdapterShape,
  req: ChatRequest,
  ctx: { apiKey: string; endpoint?: string },
): Promise<string> {
  // CLI-transport providers (e.g. claude-cli daemon) handle their own
  // lifecycle and return the assistant text directly. The httpAdapter
  // argument is intentionally ignored — caller still passes it because
  // resolveLLM doesn't know which transport will be picked until after
  // the dispatch, and the call sites are transport-agnostic.
  if (provider.transport === 'cli') {
    if (!provider.invokeCli) {
      throw new Error(`provider ${provider.id} declared transport='cli' but has no invokeCli`);
    }
    return provider.invokeCli(req, ctx);
  }
  // Default HTTP transport — byte-for-byte identical to pre-May-2026
  // inline dispatch at the five source call sites.
  const built = provider.buildRequest(req, ctx);
  const raw = await httpAdapter.post(built.url, built.body, built.headers);
  return provider.parseResponse(raw);
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
  anthropic: undefined,
  gemini: undefined,
  // claude-cli is a different transport entirely — no HTTP peer to fall
  // back to. If the subscription daemon dies, the user picks a different
  // provider in OPENCUES.md.
  'claude-cli': undefined,
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

// Dedup set for the one-time runtime warning. Keyed by `${id}|${url}`.
const _warnedEndpoints = new Set<string>();
function warnCustomEndpointOnce(providerId: string, endpoint: string): void {
  const key = `${providerId}|${endpoint}`;
  if (_warnedEndpoints.has(key)) return;
  _warnedEndpoints.add(key);
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[opencues] custom LLM endpoint in use: provider=${providerId} ` +
      `endpoint=${endpoint} — draft is sent as prompt context. ` +
      `Run "opencues validate" or check the source cue/blank to confirm trust.`,
    );
  } catch { /* host may have no console */ }
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
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[opencues] provider "${providerId}" is configured but ${envKeyName} ` +
      `is not set. Every LLM-driven cue/blank routed to this provider will ` +
      `silently do nothing until the key is provided. Fix: set ${envKeyName} ` +
      `in your env (CC/OC/gemini-cli read from process.env + ~/.cues/.env), ` +
      `or in the OpenCues popup → Settings (chrome). To verify configured ` +
      `keys: \`opencues check-keys\`.`,
    );
  } catch { /* host may have no console */ }
}

const _warnedUnknownProviders = new Set<string>();
function warnUnknownProviderOnce(providerId: string): void {
  if (_warnedUnknownProviders.has(providerId)) return;
  _warnedUnknownProviders.add(providerId);
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[opencues] unknown provider "${providerId}" referenced in config. ` +
      `Known providers: ${PROVIDER_IDS.join(', ')}. ` +
      `Check your OPENCUES.md for typos in \`llm-provider:\` / \`<feature>-provider:\`.`,
    );
  } catch { /* host may have no console */ }
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
  const providerId = (providerTierIdx >= 0
    ? tiers[providerTierIdx].p!.trim()
    : (autoPicked ?? 'cerebras')) as ProviderId;
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
  const resolvedModel = (model ?? provider.defaultModel).trim();
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
  post(url: string, body: string, headers: Record<string, string>): Promise<string>;
}

export function withFallback(base: HttpAdapterShape, fallback: ResolvedLLM | null | undefined): HttpAdapterShape {
  if (!fallback) return base;
  return {
    post: async (url, body, headers) => {
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
        return base.post(fallback.endpoint, fallbackBody, fbHeaders);
      };

      let primary: string;
      try {
        primary = await base.post(url, body, headers);
      } catch (err) {
        // Network / timeout / agent error — try fallback.
        try {
          return await tryFallback();
        } catch {
          throw err;                                       // both failed → bubble the original
        }
      }
      if (looksTransient(primary)) {
        try {
          return await tryFallback();
        } catch {
          return primary;                                  // fallback also failed → return primary's error body
        }
      }
      return primary;
    },
  };
}
