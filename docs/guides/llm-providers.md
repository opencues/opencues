---
last_updated: 2026-05-23
---

# LLM Providers

OpenCues ships with **eight built-in providers** (six HTTP, two
subscription-backed) plus auto-fallback between wire-compatible peers.
Configuration is per-surface — pick a different provider/model for
each LLM-driven feature.

## Built-in providers

| Provider | Auth | Default model | Notes |
|---|---|---|---|
| **cerebras** *(auto-route default)* | `CEREBRAS_API_KEY` | `gpt-oss-120b` | OpenAI-compat HTTP. Also serves `zai-glm-4.7` and `gemma-4-31b` (see Cerebras models below) |
| **groq** | `GROQ_API_KEY` | `openai/gpt-oss-120b` | OpenAI-compat HTTP |
| **gemini** | `GEMINI_API_KEY` | `gemini-3.1-flash-lite` | Google `contents`/`parts` shape |
| **anthropic** | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | Messages API |
| **openai** | `OPENAI_API_KEY` | `gpt-5.4-mini` | paid API, full model catalogue |
| **openai-subscription** *(subscription)* | `codex login` | `gpt-5.4-mini` | OpenAI's Responses API via your ChatGPT plan |
| **openrouter** | `OPENROUTER_API_KEY` | `openai/gpt-oss-120b:free` | OpenAI-compat HTTP |
| **claude-cli** *(subscription)* | `claude` login | `haiku` | Claude's subscription via local subprocess |

The two subscription providers (`openai-subscription` and `claude-cli`)
use your existing AI plan — no per-token billing. Use them on
expensive surfaces (agent-rewrite, transform-blank) when you want the
quality of frontier models without the per-call cost. The paid HTTP
providers stay available for surfaces that need a model your plan
doesn't allow, or when you want a specific (e.g. nano-tier) model.

The runtime picks the right env key automatically based on which
provider is selected. Set as many keys as you want — the others stay
inert until selected.

### Cerebras models

`gpt-oss-120b` is the default and best all-rounder (fastest reasoning
path, Predicted-Outputs + prefix-cache support). Two more are first-class:

| Model | Reasoning | Best for |
|---|---|---|
| `gpt-oss-120b` *(default)* | yes (medium) | everything; reasoning-heavy cues |
| `zai-glm-4.7` | binary (off) | non-reasoning alternative |
| `gemma-4-31b` | no | lookups + rewrites at ~2× the speed |

`gemma-4-31b` is a non-reasoning model. On the hackathon bench it tied
`gpt-oss-120b` on fluid-blank (98.5% vs 99.3%) and edged it on
transform-blank (~88% vs ~84%) while running ~2× faster (~196ms vs
~423ms/call). The runtime handles its quirks automatically: it never
sends `reasoning_effort` (would empty the response), `reasoning_format`,
or the Predicted-Outputs `prediction` field (which Gemma 400s on). Select
it per surface, e.g. `blanks-llm-provider: cerebras` +
`blanks-llm-model: gemma-4-31b`. Full data:
`tests/results/gemma-hackathon/FINDINGS.md`.

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

The shipped spelling cue lives at `defaults/cues/spelling/CUE.md` —
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

## Subscription-backed providers

Two providers let you use your existing AI subscription instead of
per-token billing:

- **`openai-subscription`** — OpenAI's Responses API via your ChatGPT
  Plus/Pro/Team plan. Calls go to `chatgpt.com/backend-api/codex/responses`
  using the OAuth token `codex login` stored in `~/.codex/auth.json`.
  No codex subprocess on the request hot path — we just borrow its
  auth file.
- **`claude-cli`** — Anthropic's Messages API via your Claude Pro/Max
  plan. Routes through a persistent `claude -p` subprocess (Anthropic
  server-enforces against direct OAuth-token reuse, so the subprocess
  is the only sanctioned path).

### Setup

```bash
# OpenAI ChatGPT plan (Pro / Plus / Team / Edu)
npm i -g @openai/codex
codex login              # one-time browser sign-in

# Claude Pro / Max plan
# Install Claude Code, then:
claude auth              # one-time browser sign-in
```

### Opt in via OPENCUES.md

```yaml
# Mix and match — pick the best billing path per surface
agent-rewrite-provider: openai-subscription      # free, ~730ms warm
agent-rewrite-model: gpt-5.4-mini

transform-blank-provider: claude-cli             # free, ~840ms warm
transform-blank-model: haiku
```

### Subscription model allow-list (`openai-subscription`)

| Model | Warm median | Notes |
|---|---|---|
| `gpt-5.4-mini` *(default)* | ~600-1000ms | fastest, general use |
| `gpt-5.4` | ~1.3s | smarter, ~2× slower |
| `gpt-5.5` | ~1.2s | newest frontier model |
| `gpt-5.3-codex` | ~1.0s | code-tuned variant |

Every other name (`gpt-5`, `gpt-5-nano`, `gpt-5-codex`, `o3`,
`o4-mini`, etc.) returns 400 *"not supported when using Codex with a
ChatGPT account"* on the subscription tier. Use the paid `openai`
provider for those.

### Measured latency (May 2026, end-to-end via opencues)

| Provider | Per-call median | Min |
|---|---|---|
| `claude-cli` (Haiku) | ~840ms | ~840ms |
| `openai-subscription` (gpt-5.4-mini) | **~730ms** | **~600ms** |

### Architecture notes

**`openai-subscription`** does not spawn the `codex` binary at request
time. It reads `~/.codex/auth.json` (codex itself refreshes that file
in place when you use it; we just consume the latest), extracts the
`access_token` + `account_id`, and POSTs to OpenAI's Responses
endpoint directly. The `codex` binary is required for the one-time
`codex login` (the OAuth + PKCE flow that writes auth.json) but is
NOT on the hot path.

Reference pattern: Zed's ChatGPT subscription provider
([zed-industries/zed#56811](https://github.com/zed-industries/zed/pull/56811)),
opencode's codex-auth plugin, LiteLLM. Same OAuth + same endpoint;
OpenAI's documented "personal local-use" pattern. Don't run this as
a hosted/shared service.

### When to use which surface

- **Word cues / fluid blank** — HTTP provider (groq / cerebras).
  Subscription providers are ~600-900ms even warm; well over the
  ≤500ms budget short surfaces need.
- **Transform blank** — viable on either subscription. `openai-subscription`
  at ~730ms median fits inside the 1-3s sweet spot.
- **Agent rewrite** — best fit for subscription. Latency budget is
  already in seconds, and the per-call cost is free (covered by your
  existing AI plan).

### Auto-route exemption

Both subscription providers are never auto-picked. The auto-route only
walks HTTP providers in `PROVIDER_AUTO_ORDER` (cerebras → groq →
gemini → anthropic → openai). You must explicitly set
`<feature>-provider: openai-subscription` or `<feature>-provider: claude-cli`
in OPENCUES.md. This prevents silently routing time-sensitive surfaces
(word-cues, fluid-blank) through slower subscription endpoints just
because you happen to have logged in.

### No HTTP fallback peer

If a subscription provider fails (auth expired, rate-limited, binary
missing, network blip), the call fails — there's no silent retry
against an HTTP provider. Run `opencues doctor` to see which
subscription providers are detected on PATH.

## Adding a new provider

If a new OpenAI-compatible provider appears, add it to
`PROVIDERS` in `packages/opencues-core/src/llm-provider.ts`:

```ts
const TOGETHER: ProviderAdapter = {
  id: 'together',
  defaultEndpoint: 'https://api.together.xyz/v1/chat/completions',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  // 2-5 bench-validated entries covering cheap-fast / balanced /
  // deep-reasoning tiers. The fluid-config classifier renders this
  // list verbatim and only routes natural-language model picks within
  // it. Power users can still pin any model string by hand-editing
  // OPENCUES.md — knownModels bounds NL-reachable picks only.
  knownModels: [
    'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'meta-llama/Llama-3.3-405B-Instruct-Turbo',
    'Qwen/Qwen2.5-72B-Instruct',
  ],
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

### `knownModels` — what the fluid-config classifier may emit

`knownModels` is optional but recommended. It bounds the model
catalogue the fluid-config classifier (`fluid-config-mode: on`) may
route to via natural language ("use cerebras gpt-oss-120b for cues
_"). Three rules:

1. **Curated, not exhaustive.** 2-5 canonical ids per provider —
   typically one cheap-fast, one balanced, one deep-reasoning.
   Listing every model the provider hosts bloats the classifier
   prompt and gives the LLM more rope to hallucinate look-alikes.
2. **First entry should match `defaultModel`.** Reads better in
   error messages ("allowed: gpt-5.4-mini, gpt-5.4, gpt-5.4-nano")
   and means picking the provider via NL without a model name lands
   on the same default the resolver would pick.
3. **Bench-validated.** Each entry should at minimum survive the
   fluid-blank and transform-blank benches at this provider, or be
   documented as a known cost/quality trade-off in the adapter
   comments.

Adding a model to `knownModels` automatically extends what
`use <provider> <model> for <bucket> _` can reach — no prompt edit
needed. Removing one prevents the classifier from emitting it, but
file-edit pins still work (`<bucket>-llm-model: <whatever>` accepts
any string).

When `knownModels` is omitted entirely, the validator falls back to
`[defaultModel]` — the classifier may still pick the provider but
can only land on its default model.

For non-OpenAI-compat providers (different request/response shape),
follow the **Gemini** or **Anthropic** patterns — both write their
own `buildRequest` / `parseResponse` from scratch.

---

## See also

- [`docs/benchmarks/2026-05-08-provider-bench.md`](../benchmarks/2026-05-08-provider-bench.md) — full bench results that drove the recommended routing.
- [`packages/opencues-core/src/llm-provider.ts`](../../packages/opencues-core/src/llm-provider.ts) — provider adapters + `resolveLLM` + `withFallback`.
- [`defaults/OPENCUES.md`](../../defaults/OPENCUES.md) — annotated example config with every key documented inline.
