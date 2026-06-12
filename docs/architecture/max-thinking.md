# Architecture: `max-thinking` per-model reasoning budget

Canonical reference for the `max-thinking` OPENCUES.md scalar and the
per-model reasoning-effort resolution it drives. Read this before
touching `packages/opencues-core/src/model-thinking.ts`, the reasoning
branch in `buildOpenAIBody` (`llm-provider.ts`), or the `maxThinking`
plumbing through the sources / build-sources / resolver / agent-rewrite.

User-facing summary: [docs/features/max-thinking.md](../features/max-thinking.md).

## The model

Reasoning-capable models accept a `reasoning_effort` hint
(`none | low | medium | high`). More effort = better quality, more
latency, more tokens. Each verified model has a bench-tuned **ceiling**
(`max`, the most it should ever think) and a reduced **off** level. The
single user knob is one OPENCUES.md scalar:

```
max-thinking: on | off     # default on
```

- `on`  → each model thinks at its `max` ceiling.
- `off` → each model thinks at its `off` (reduced) level.

The ceilings are **seeded to equal each provider's existing
`defaultReasoningEffort`** (the value the `tests/results/thinking-budget-2026-05-18.md`
sweep set). So `max-thinking: on` — the default — reproduces the
pre-feature behaviour byte-for-byte. `off` is the only state that
changes anything.

The per-model table (`MODEL_THINKING` in `model-thinking.ts`):

| Key                                   | max     | off  |
|---------------------------------------|---------|------|
| `cerebras:gpt-oss-120b`               | medium  | low  |
| `cerebras:zai-glm-4.7`                | medium  | low  |
| `groq:openai/gpt-oss-120b` / `-20b`   | low     | none |
| `openai:gpt-5.4-mini` / `-5.4` / nano | low     | none |
| `openai-subscription:gpt-5.4*`        | low     | none |
| `openrouter:openai/gpt-oss-120b[:free]` | low   | none |
| `opencode-zen:free` / `big-pickle`    | low     | none |

Models **absent** from the table fall back to the provider's
`defaultReasoningEffort` for `max` and one notch below it for `off`
(`notchBelow`). Providers with no reasoning default (Anthropic, Gemini)
resolve to `none/none`, but the value is never forwarded — see below.

### Why per-model (not per-provider)

`ProviderAdapter.defaultReasoningEffort` is per-provider. The
`MODEL_THINKING` table is per-`(provider, model)` so an individual model
can be tuned without disturbing its siblings (a future cerebras model
that's fine at `high`, say). It's seeded identically today, so there's
no behavioural difference yet — the granularity is for later.

## Resolution: one function, one chokepoint

`resolveReasoningEffort({ providerId, model, explicit, providerDefault, maxThinking })`
in `model-thinking.ts` is the single resolver. Precedence:

1. **explicit** per-call value (e.g. fluid-blank / config-intent pin
   `low` for latency) — wins, but is **clamped down to the model's
   ceiling** (`max-thinking` is a true cap: explicit `high` on cerebras
   → `medium`).
2. else `maxThinking` ON → ceiling; OFF → reduced level.

Returns `undefined` only when the provider has no reasoning default AND
no explicit value (a non-reasoning provider) — exactly matching the
prior `req.reasoningEffort ?? defaultReasoningEffort` contract it
replaced.

The **one chokepoint** is `buildOpenAIBody` in `llm-provider.ts`. Every
reasoning-capable wire call funnels through it:

- the 6 source `dispatchChat` calls (config-source / fluid-blank /
  transform-blank / sentence-cue; config-intent pins `low` so it's
  unaffected), AND
- AgentRewrite's *direct* `provider.buildRequest` call (it bypasses
  `dispatchChat`).

`buildOpenAIBody` already applied `defaultReasoningEffort`; it now calls
`resolveReasoningEffort` instead. The forward gate is unchanged — the
resolved value is only written to `reasoning_effort` when
`reasoningForwarded` (provider opts in OR the model name looks like a
reasoning model) AND the model doesn't reject the field
(`modelRejectsReasoningEffort`). So non-reasoning providers/models drop
it regardless.

## Plumbing: how `maxThinking` reaches the chokepoint

`maxThinking` is a boolean carried on the dispatch **`ctx`** — the same
object that already flows to every `buildRequest`. Nothing about the
`ChatRequest` changed.

```
OPENCUES.md  max-thinking: on|off
   │
   ├─ resolver.ts ──► buildSourcesFromConfig({ maxThinking })   (cue/blank sources)
   │     └─ each source stores this.maxThinking, passes it in dispatch ctx
   │           └─ dispatchChat(provider, http, req, { …, maxThinking })
   │                 └─ provider.buildRequest(req, ctx)  // ctx forwarded as-is
   │                       └─ buildOpenAIBody(req, { …, maxThinking: ctx.maxThinking })
   │                             └─ resolveReasoningEffort(...)
   │
   └─ boot-common.buildAgentLLMResolver ──► ResolvedAgentLLM.maxThinking   (agent-rewrite)
         └─ agent-rewrite passes { …, maxThinking } into provider.buildRequest / dispatchChat
```

`dispatchChat` did not need editing — it already forwards the full `ctx`
to `buildRequest`; only the `ctx` *type* widened (on `buildRequest`,
`dispatchChat`, `buildProviderRequest`, and AgentRewrite's narrower
adapter shape).

Each OpenAI-compatible provider's `buildRequest` forwards
`ctx.maxThinking` into `buildOpenAIBody`'s opts. Anthropic / Gemini
build their own bodies and ignore it (no reasoning knob).

## Config wiring

- **Feature registry** (`feature-registry.ts`): one `FEATURES` entry,
  `scalar: 'max-thinking'`, values `on` / `off`. This automatically
  extends the `_` settings menu (`getMenuDefinitions`) and the
  config-intent classifier's choice space — no edits to either.
- **OpenCuesState**: `max-thinking` is intentionally **settings-map-only**
  (read once via `settings.get('max-thinking')` in `resolver.ts` and
  `boot-common.ts`), like the other `*-mode` toggles. It's listed in
  `feature-registry-alignment.test.ts`'s `SETTINGS_MAP_ONLY` so the
  registry↔OpenCuesState alignment test stays green without a typed
  field.
- **Default**: `max-thinking: on` shipped in `defaults/OPENCUES.md`.

## NOT a spec change

`max-thinking` is a reference-implementation runtime knob (like
`voice-mode`, `debug-mode`, per-bucket LLM routing) — it controls *how
hard the reference impl's LLM dispatch thinks*, not the wire format a
second implementation must honour. It is **not** a spec-mandated scalar,
so `SPEC_VERSION` does **not** bump for it. (Contrast: `identity-context-mode`
/ `blank-context-mode`, which ARE spec-mandated.)

## Known gap (v1)

AgentRewrite's **legacy no-core-provider inline path** (the `else` branch
in `agent-rewrite.ts` that hand-builds a Groq-shaped body when no
`@opencues/core` adapter was passed via `resolveLLM`) does not consult
`max-thinking` — it pins `reasoning_effort ?? 'low'`. That path only
fires when `@opencues/core` couldn't be required at all (a packaging
failure), so in every real install AgentRewrite goes through the
core-provider path that *does* honour the toggle. Documented here rather
than fixed because adding the per-model table to a path that exists only
as a no-core-dep fallback would re-couple the runtime to core's model
map.

## Tests

- `packages/opencues-core/src/model-thinking.test.ts` — `lookupModelThinking`
  + `resolveReasoningEffort` precedence/clamp/notch/undefined cases.
- `packages/opencues-core/src/llm-provider.max-thinking.test.ts` —
  end-to-end wire body: `reasoning_effort` lands correctly through each
  real provider for on / off / explicit / non-reasoning.

Both are vitest-style; they're listed in
`packages/opencues-core/vitest.config.ts`'s `include` glob (this
package's vitest only loads explicitly-listed files).
