---
last_updated: 2026-05-08
---

# LLM Providers

OpenCues ships with **six built-in providers** plus auto-fallback
between wire-compatible peers. Configuration is per-surface — pick
a different provider/model for each LLM-driven feature.

## Built-in providers

| Provider | Env key | Default endpoint | Default model | Wire shape |
|---|---|---|---|---|
| **cerebras** *(auto-route default)* | `CEREBRAS_API_KEY` | `api.cerebras.ai/v1/chat/completions` | `gpt-oss-120b` | OpenAI-compat |
| **groq** | `GROQ_API_KEY` | `api.groq.com/openai/v1/chat/completions` | `openai/gpt-oss-120b` | OpenAI-compat |
| **gemini** | `GEMINI_API_KEY` | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `gemini-3.1-flash-lite` | Google `contents`/`parts` |
| **anthropic** | `ANTHROPIC_API_KEY` | `api.anthropic.com/v1/messages` | `claude-haiku-4-5-20251001` | Messages API (different shape) |
| **openai** | `OPENAI_API_KEY` | `api.openai.com/v1/chat/completions` | `gpt-5.4-mini` | OpenAI |
| **openrouter** | `OPENROUTER_API_KEY` | `openrouter.ai/api/v1/chat/completions` | `openai/gpt-oss-120b:free` | OpenAI-compat |

The runtime picks the right env key automatically based on which
provider is selected. Set as many keys as you want — the others stay
inert until selected.

Source: `packages/opencues-core/src/llm-provider.ts`.

## How to configure

Edit `~/.cues/OPENCUES.md` (frontmatter holds settings; body is documentation):

### Global default — applies to every surface

```yaml
llm-provider: groq
llm-model: openai/gpt-oss-120b
# llm-endpoint: …    # rare — only for self-hosted gateways
```

### Per-feature override — finer granularity

Four surfaces accept their own provider+model+endpoint:

```yaml
# 1. Word cues — synonyms / antonyms / linked alternatives
#    Spelling, legal, medical, etc. all flow through this tier
#    because they're config-driven word-scope cues (see
#    `defaults/cues/`). Override an individual cue's provider via
#    its frontmatter.
word-cues-provider: groq
word-cues-model: openai/gpt-oss-120b

# 2. Fluid blank — free-form `_` lookups (P1 SEGMENT + P3 ANSWER)
fluid-blank-provider: cerebras
fluid-blank-model: gpt-oss-120b

# 3. Transform blank — imperative-instruction edits
transform-blank-provider: groq
transform-blank-model: openai/gpt-oss-120b

# 4. Agent rewrite — full-buffer rewrite agent
agent-provider: cerebras
agent-model: gpt-oss-120b
```

Each per-feature key falls back to the global setting when unset.

### Per-cue / per-blank override — finest granularity

In any individual `CUE.md` / `BLANK.md` / `defaults/cues/<cue>.md` frontmatter:

```yaml
---
name: legal
match: contract|shall|liability
provider: anthropic
model: claude-haiku-4-5-20251001
priority: 70
---
```

This cue alone will use Anthropic; everything else inherits the
global / per-feature settings. Useful when one specialist domain
benefits from a different model character.

The shipped spelling cue lives at `defaults/cues/spelling.md` —
add `provider:` / `model:` to its frontmatter (or to a project-level
copy at `<cwd>/.cues/cues/spelling.md`) to route spelling specifically
without affecting the rest of `word-cues-*`.

## Granularity summary

| Tier | Where | Keys |
|---|---|---|
| **Per-cue / per-blank** | `CUE.md` / `BLANK.md` frontmatter | `provider:`, `model:`, `endpoint:` |
| **Per-feature** | `~/.cues/OPENCUES.md` frontmatter | `<feature>-provider:`, `<feature>-model:`, `<feature>-endpoint:` |
| **Global** | `~/.cues/OPENCUES.md` frontmatter | `llm-provider:`, `llm-model:`, `llm-endpoint:` |
| **Built-in default** | n/a | groq + `openai/gpt-oss-120b` |

The most-specific tier wins. Provider and model are *paired* — if a
tier specifies a provider but not a model, the model falls back to
that provider's default (not to a less-specific tier's model with
a different provider).

## Auto-fallback

When you have keys configured for both **groq AND cerebras**, OpenCues
automatically routes around transient failures (HTTP 429 rate-limit,
5xx, network blip, empty body). The wrapper:

1. Tries the resolved provider.
2. On transient failure: rewrites the request URL, swaps the bearer
   auth header to the fallback's key, translates the model name
   (e.g. `openai/gpt-oss-120b` ↔ `gpt-oss-120b`), and re-issues.
3. Returns the fallback's response — transparent to the caller.

Fallback only fires for wire-compatible peers (groq ↔ cerebras at
present). Cross-shape peers (e.g. groq → gemini) require a different
request body, so they're not auto-paired. Set `llm-provider: gemini`
explicitly if you want to use Gemini.

400-class client errors are **never** retried — those mean the
request itself is malformed and would fail on the fallback too.

Source: `withFallback()` in `packages/opencues-core/src/llm-provider.ts`.

## Recommended routing (May 2026)

Based on the 2026-05-08 bench (`docs/benchmarks/2026-05-08-provider-bench.md`):

```yaml
# Short-prompt surfaces stay on Groq — fastest TTFT.
llm-provider: groq
llm-model: openai/gpt-oss-120b

# Long-prompt surfaces favour Cerebras — better quality (12/12 vs
# 10/12 on fluid-blank P1 SEGMENT) and faster on long input.
fluid-blank-provider: cerebras
fluid-blank-model: gpt-oss-120b
agent-provider: cerebras
agent-model: gpt-oss-120b
```

Set both `GROQ_API_KEY` and `CEREBRAS_API_KEY` — they automatically
become each other's failover.

## Reasoning effort

OpenCues passes `reasoning_effort: 'low'` to providers that honour it
(Groq's `gpt-oss-*` line, Cerebras's `gpt-oss-*`, OpenAI's reasoning
models when the heuristic detects them). The flag is silently dropped
for providers/models that don't accept it.

**Don't bump above `low`.** The 2026-05-08 bench showed:
- `medium` regresses fluid-blank by 50%+ (model outputs prose instead
  of the structured `SPAN: / CONTEXT:` format).
- `high` regresses transform-blank on Groq specifically (overthinks
  composed instructions).
- Quality saturates at `low` for every OpenCues task surface.

The reasoning_effort field isn't user-exposed in CUES.md right now —
it's hardcoded to `'low'` by each source. Adding per-feature override
is a small change if a future surface needs it.

## Pricing (May 2026)

| Provider | Input ($/M) | Output ($/M) | Notes |
|---|---|---|---|
| **groq** | $0.15 | $0.60 | prompt caching halves input; Batch API halves all rates |
| cerebras | $0.35 | $0.75 | ~3000 tok/sec on wafer silicon |
| openai (gpt-5.4-mini, default) | $0.75 | $4.50 | mid-tier; nano was too small for multi-paragraph |
| openai (gpt-5.4-nano, opt-in) | $0.20 | $1.25 | cheapest; works for short-output tasks only |
| anthropic (haiku 4.5) | $1.00 | $5.00 | |
| openrouter | varies by model | | `:free` tier available for many models |
| gemini (3.1-flash-lite) | $0.25 | $1.50 | May 2026 GA; replaces 2.5-flash |

Cerebras is roughly 2× Groq's cost for the same `gpt-oss-120b`
weights. The trade-off: Cerebras wins on long-prompt latency and
fluid-blank quality (per the bench); Groq wins on short-prompt TTFT.

## Host integration notes

### Claude Code (`integrations/claude-code/`)
The patch (`opencuesRuntime.ts`) reads all five env keys at startup
and forwards them as `host.llmApiKeys`. No code change to switch
providers — just edit `~/.cues/CUES.md`.

### OpenCode (`integrations/opencode/`)
Same — `opencuesBootstrap.ts` reads all keys from `process.env` and
forwards.

### Gemini CLI (`integrations/gemini-cli/`)
Same — `opencuesBootstrap.ts` reads all keys from `process.env` and
forwards via `host.llmApiKeys`.

### Chrome extension (`integrations/chrome/`)
Browser-side fetches require **host_permissions** in
`manifest.json`. The current manifest permits all six provider
domains; if you add a new provider with a different host, update
the manifest and re-load the extension.

Anthropic specifically requires the
`anthropic-dangerous-direct-browser-access: true` header for
direct browser calls — the adapter sets this automatically; no
user config needed.

The Chrome extension currently has no settings UI for entering API
keys directly — they must be supplied via `chrome.storage.local`
(future popup work). Native hosts (CC, OC) read `process.env`
directly.

## Adding a new provider

If a new OpenAI-compatible provider appears, add it to
`PROVIDERS` in `packages/opencues-core/src/llm-provider.ts`:

```ts
const TOGETHER: ProviderAdapter = {
  id: 'together',
  defaultEndpoint: 'https://api.together.xyz/v1/chat/completions',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  envKeyName: 'TOGETHER_API_KEY',
  buildRequest(req, ctx) {
    return {
      url: ctx.endpoint ?? this.defaultEndpoint,
      body: buildOpenAIBody(req),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
    };
  },
  parseResponse: parseOpenAIResponse,
};
```

Add to the `PROVIDERS` map and the `ProviderId` union, write a
unit test in `llm-provider.test.ts`, update the manifest if Chrome
support is desired. Existing call sites need no changes.

For non-OpenAI-compat providers (different request/response shape),
follow the **Gemini** or **Anthropic** patterns — both write their
own `buildRequest` / `parseResponse` from scratch.

---

## See also

- [`docs/benchmarks/2026-05-08-provider-bench.md`](../benchmarks/2026-05-08-provider-bench.md) — full bench results that drove the recommended routing.
- [`packages/opencues-core/src/llm-provider.ts`](../../packages/opencues-core/src/llm-provider.ts) — provider adapters + `resolveLLM` + `withFallback`.
- [`defaults/OPENCUES.md`](../../defaults/OPENCUES.md) — annotated example config with every key documented inline.
