# Cerebras-specific features and optimisations

OpenCues runs against multiple LLM providers, but Cerebras is the **default** and the provider we optimise hardest for. Three reasons: it's the fastest inference path we ship with (~400-500ms warm), it has the most generous free tier for OpenCues' typing-rate dispatch pattern, and its API exposes per-request behaviour (cache hit accounting, optional cache routing keys) that other providers don't.

This page collects the Cerebras-specific behaviour OpenCues relies on so future Cerebras-related features have a single landing page to reference.

---

## Automatic prompt prefix caching

Cerebras's inference API ships [automatic prompt prefix caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching) on the models we route to today:

- `gpt-oss-120b` (primary — used by every shipped source on the cerebras adapter)
- `zai-glm-4.7`

**No opt-in required.** Every dispatch through `dispatchChat` benefits.

### Mechanics

- **Prefix matching unit:** 128 tokens. If the first N × 128-token blocks of the prefix match a request your org made within TTL, those blocks are served from cache.
- **TTL:** 5 min guaranteed; up to 1 hour under low system load.
- **Cache scope:** organisation-wide. Multiple OpenCues users behind the same key share cache.
- **Cache hit indicator:** `usage.prompt_tokens_details.cached_tokens` in the response body.

### Verified hit rate

Bench-measured at **99.5% cache hit rate** on the ~20k-token static `FUSED_SYSTEM` / `FUSED_SYSTEM_PROMPT` constants in `transform-blank-source.ts` and `fluid-blank-source.ts`. Warm calls land in ~445ms vs cold ~800-1200ms — the cache saves ~300-500ms of TTFT per dispatch.

### The author's lever — what to put where

The cached prefix only extends as far as the **stable bytes** of the request. The moment a per-call byte changes (different user buffer, different per-call instruction, different ambient context), the cache cuts off there.

Three rules:

1. **Stable session-level context goes in the SYSTEM message.**
   - Identity catalog (token list + descriptions, safe-mode) — stable for the user session.
   - Blank-context catalog (token list + covers hints) — stable for the snapshot TTL (default 60s).
   - These are appended to `FUSED_SYSTEM` / `FUSED_SYSTEM_PROMPT` in source so cerebras caches them as part of the prefix. **Shipped in `@opencues/core` 0.3.16 (June 2026)** — bench-validated at 175/176 on `tests/benchmarks/fluid-blank-ambient/fused-bench.ts`.

2. **Per-call binding context stays in the USER message.**
   - **Ambient** (chrome's per-field label / placeholder / page title) MUST stay user-side. Moving ambient to system regressed the fluid-blank-ambient bench from 175/176 → 166/176 during the restructure — the LLM treats system-side ambient as global background and stops tightly binding it to the input. The bench failure mode: `paris _` in a Postcode field returned "London" instead of "SW1A 1AA" because the LLM stopped pairing the Postcode label with the user's INPUT.
   - The user's INPUT itself obviously stays user-side.
   - Anything that must pair with INPUT semantically (per-field hints, per-call instruction sentences, transient context) stays with it.

3. **Watch for inadvertent system-message mutations.**
   - Any byte change near the START of the system message (the first ~128 tokens of cache-block 1) breaks the cache from that block onward.
   - **Don't** append per-call salts to the system prompt for debugging.
   - **Don't** switch model names that change tokenizer output mid-session.
   - **Don't** reorder long-static sections of `FUSED_SYSTEM_PROMPT` without re-running the recall + accuracy benches.

### Cache observability

`dispatchChat`'s `ctx` accepts an optional `onUsage(u: UsageReport)` callback (June 2026). `UsageReport` exposes `{ promptTokens, completionTokens, cachedTokens, cacheHitRate }`. Cerebras and OpenAI surface `prompt_tokens_details.cached_tokens` on OpenAI-compatible responses; we parse it once in `dispatchChat` and call the callback.

The three semantic-`_` sources (`TransformBlankSource`, `FluidBlankSource`, `ConfigIntentSource`) wire `onUsage` to `this.log` and emit a debug-level line when `cachedTokens > 0`:

```
TransformBlank: usage prompt=20203 cached=20096 (99.5%) completion=181
FluidBlank: usage prompt=20347 cached=20096 (98.8%) completion=42
ConfigIntent: usage prompt=4823 cached=4736 (98.2%) completion=12
```

Enable `debug-mode: on` in `~/.cues/OPENCUES.md` to see them in `/tmp/opencues.log`.

**A `cachedTokens=0` line is a regression signal** — something in the prompt prefix is changing per-call when it shouldn't. Common causes:
- Someone added a per-call timestamp / counter / salt near the start of the system message.
- A new context block is being inadvertently included system-side without being session-stable (e.g. `cursor` offset, `signal` reflection).
- The runtime is dispatching to a different model than the cache was populated for.

### `prompt_cache_key` (we don't use it)

Cerebras supports an optional `prompt_cache_key` parameter as a routing hint that pins related requests to the same cache shard. We deliberately don't pass it. Two reasons:

1. **Auto-cache is consistent in our benches.** Warm-call latency is statistically indistinguishable between auto-cache and explicit-key variants in the n=4 trials × 5 warm calls ad-hoc bench (`/tmp/cerebras-restructure-bench.mjs` shape).
2. **Explicit keys risk shard hot-spotting at scale.** If many requests share an explicit key, they concentrate on one shard. Auto-cache lets cerebras distribute load naturally. The bottleneck-vs-benefit tradeoff doesn't favour explicit keys at OpenCues' single-user typing-rate dispatch pattern.

If we ever ship per-tab / per-textbox routing hints, the place to compute them would be at the source level (cache key already derives session-stable identifiers in `TransformBlankSource._computeCacheKey`). Until then, auto-cache.

---

## Cross-provider comparison for the same feature

| Provider | Automatic prefix cache | Cache-hit indicator | Routing hint |
|---|---|---|---|
| **Cerebras** | ✓ (gpt-oss-120b, zai-glm-4.7) | `prompt_tokens_details.cached_tokens` | optional `prompt_cache_key` |
| **OpenAI** | ✓ (gpt-5.x, gpt-4o) | `prompt_tokens_details.cached_tokens` | — |
| **Anthropic** | explicit `cache_control` markers only | `usage.cache_read_input_tokens` | n/a |
| **Groq** | none at time of writing | — | — |
| **Gemini / OpenRouter** | provider-dependent | — | — |

`dispatchChat`'s `onUsage` callback is silent on providers that don't surface the field. Anthropic prompt caching would need a future PR to add explicit `cache_control` markers around the static prompt sections.

---

## Predicted Outputs (speculative decoding)

Cerebras supports [Predicted Outputs](https://inference-docs.cerebras.ai/capabilities/predicted-outputs) — a client-side speculative-decoding hint where you pre-supply the expected output. The server validates token-by-token against the actual generation; matching tokens come from cache (billed at the input rate), mismatches regenerate (billed at the output rate).

Model support: `gpt-oss-120b` (the model we route to) + `zai-glm-4.7`.

### When OpenCues uses it

**TransformBlank fused path only**, gated at `extractText.length >= 200`. The prediction passed is `extractText` — the original buffer body that's about to be rewritten. For typical TransformBlank flows (fix typos, make formal, shorten, rephrase) the output preserves 50-95% of input byte content; cerebras's speculation engine accepts those tokens from the prediction cache instead of regenerating.

**Why TransformBlank only:**
- FluidBlank output is novel ("capital of france _" → "Paris" has zero prediction signal)
- ConfigIntent output is short (~20 tokens; speculation window doesn't engage)
- 3-pass mode (groq) — predicted outputs is a cerebras feature, doesn't apply

**Why a length gate:**

| Output length | Acceptance rate | Net latency effect |
|---|---|---|
| < 170 completion tokens (~100-200 input chars) | 0% | +12ms overhead from rejected tokens |
| 170-240 completion tokens (~200-400 input chars) | Variable; speculation window starts engaging | Break-even |
| ≥ 240 completion tokens (~400+ input chars) | ~66% | -150ms median, -750ms p95 |

Bench measurements at June 2026:
- `/tmp/cerebras-predicted-outputs-bench.mjs` (4 trials × 4 cases): long-rewrite (resignation email) +pred saves 156ms; short-rewrite + medium-rewrite show 0% acceptance.
- `/tmp/cerebras-reasoning-matrix.mjs` (6 trials × 2 models × 3 reasoning × {no-pred, +pred}): 66% acceptance consistent across reasoning levels on long inputs; gpt-oss-120b/low/+pred hits 258ms median (vs 261ms no-pred — savings are mainly tail).

### Fallback: cerebras intermittently rejects `prediction`

Predicted outputs is a **perf optimisation, not a correctness feature** — and cerebras `gpt-oss-120b` will **intermittently reject the field mid-session** with `property 'prediction' is unsupported` (a 400). Before the fallback, that hard-failed the whole TransformBlank call — a user's `add a paragraph _` over a >200-char body would silently do nothing.

`dispatchChat` (the single wire chokepoint that carries `prediction` — TransformBlank's fused path is its only setter) now catches that **specific** rejection and **retries once without `prediction`** (a strict subset of the original request, guaranteed valid, can't recur). Scoped tightly: only fires when `prediction` was actually sent and the error matches both `prediction` + `unsupported`; every other call keeps its single-attempt behaviour and unrelated errors surface unchanged. A rejected prediction now costs one extra round-trip, never a failed transform. Code: `dispatchChat` + `isPredictionUnsupportedError` in `llm-provider.ts`; pinned by 3 unit tests. (The sibling `seed` + `prediction` provider gates in `buildOpenAIBody` are the *send-side* half of the same "OpenAI-only param rejected by a strict gateway" class.)

### Cost arithmetic

Using approximate published cerebras rates ($0.10/M input, $0.60/M output):

| Scenario | 240 completion tokens, 40 accepted, 21 rejected | Without prediction |
|---|---|---|
| Generated at output rate | 200 × $0.60/M = $0.000120 | 240 × $0.60/M = $0.000144 |
| Accepted prediction (input rate) | 40 × $0.10/M = $0.000004 | — |
| Rejected prediction (output rate) | 21 × $0.60/M = $0.0000126 | — |
| **Total** | **$0.000147** | **$0.000154** |

Net: 5% cheaper on cache-hit cases, 6.5% more expensive on 0% acceptance. The length gate (≥200 chars) keeps us in the cache-hit regime.

### Accuracy validation

The prompt's INPUT/OUTPUT content is unchanged — predicted outputs only affects HOW the server generates each token (cache lookup vs regeneration), not WHAT it generates. Bench validation against `tests/benchmarks/transform-blank/prod-fused.ts`:

- Master baseline: 186-193/231 across runs (cerebras has ~7-case variance on this bench at temp=0 + seed=42).
- Branch with predicted outputs (200-char gate): 186-188/231 across runs — within variance, no measurable drift.

The accuracy signal can't be distinguished from cerebras's natural run-to-run variance, so we rely on the cost asymmetry: rejected predictions are billed but don't change the model's output trajectory (the model regenerates the actual token whenever it disagrees with the prediction). Per-token determinism at temp=0 + seed=42 is preserved.

### What it looks like in the log

With `debug-mode: on`, predicted outputs surfaces in the existing usage log line:

```
TransformBlank: usage prompt=20347 cached=20096 (98.8%) completion=242 pred-accepted=40 pred-rejected=21 (acc rate 66%)
```

A `pred-accepted=0` line on a long input is a regression signal — something about the prompt shape is breaking the speculation window. Check whether the catalog blocks moved positions, whether reasoning is producing far more tokens than expected, or whether the model changed.

### What we deliberately don't pass prediction for

- **FluidBlank**: output is short and novel; speculation window doesn't fire usefully.
- **ConfigIntent**: output is short and the gated pre-filter catches most calls before dispatch anyway.
- **3-pass TransformBlank (groq)**: predicted outputs is cerebras-specific.
- **TransformBlank fused with `extractText.length < 200`**: generation-style triggers like `draft an email _` have no body to predict against; rejected tokens would just be cost overhead.

## Hidden reasoning format on gpt-oss-120b

Cerebras's `gpt-oss-120b` accepts a [`reasoning_format` parameter](https://inference-docs.cerebras.ai/capabilities/reasoning) that controls how the internal reasoning trace appears in the response:

- **`text_parsed`** (default for gpt-oss): reasoning appears as a separate field in the response message.
- **`hidden`**: reasoning tokens are still **computed and counted**, but the response contains only the final answer in `message.content`. No `reasoning` field is returned.

**OpenCues passes `reasoning_format: "hidden"` for every cerebras dispatch to gpt-oss-120b.** This is conditional in `buildOpenAIBody`: gated on `provider === 'cerebras'` AND `req.model` starts with `gpt-oss`. Bench harnesses (`tests/benchmarks/fluid-blank/cerebras.ts`) mirror so future benches measure what production runs.

Why hidden:
- **Same accuracy**: same internal generation, identical content bytes. Bench-validated at 175/176 on `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` and 187/231 on `transform-blank/prod-fused.ts` (both within master's variance band).
- **Same cost**: reasoning tokens still counted (no change in per-call billing).
- **Same median latency** (within ±10ms noise).
- **Significant p95 tail reduction** on short-output sources:

  | Source | default p95 | hidden p95 | Δ |
  |---|---|---|---|
  | FluidBlank | 579ms | 348ms | **−231ms (−40%)** |
  | ConfigIntent | 603ms | 446ms | **−157ms (−26%)** |
  | TransformBlank | 461ms | 470ms | +9ms (noise) |

  N=20 trials per cell, June 2026. Long-output sources (TransformBlank's fused rewrite) are neutral because the output content dominates the response payload — the reasoning trace doesn't materially change the transmission cost. Short-output sources have a small content payload, so the reasoning trace was disproportionately inflating worst-case responses; hidden strips that overhead.

Why gated to gpt-oss-120b: cerebras docs scope `reasoning_format` to gpt-oss-120b and zai-glm-4.7. zai-glm-4.7 already runs at `reasoning_effort: 'none'` for us (no reasoning text to hide); the parameter is a no-op there. Tight gating avoids sending an unknown field to other providers' models.

Why NOT a runtime toggle: the behavior change is semantic-neutral and the bench data is clear, so we don't expose a config scalar for it. It's always on for cerebras gpt-oss-120b.

---

## Reasoning controls (`reasoning_effort` per-model)

Both cerebras reasoning-capable models accept `reasoning_effort` but behave differently. OpenCues sets per-model defaults via the `MODEL_THINKING` table in `packages/opencues-core/src/model-thinking.ts`.

### gpt-oss-120b — graduated knob

| `reasoning_effort` | Reasoning tokens | Notes |
|---|---|---|
| `none` | n/a | **HTTP 400** — cerebras rejects this value for gpt-oss-120b. `low` is the floor. |
| `low` | ~6 | Minimal thinking; sufficient for fluid-blank lookups |
| `medium` (OpenCues default for transform-blank) | ~120 | Bench-tuned for transform-blank quality |
| `high` | ~370 | Available but rarely beneficial |

Our default is `medium` for transform-blank and `low` for fluid-blank, tuned by the [thinking-budget bench](../../tests/benchmarks/thinking-budget/). The `max-thinking: off` scalar dials this down by one notch (see [max-thinking.md](max-thinking.md)).

### zai-glm-4.7 — binary knob

| `reasoning_effort` | Reasoning tokens | Median latency | Notes |
|---|---|---|---|
| `none` | 0 | ~280ms | Clean disable; usable output. **The only useful mode.** |
| `low` / `medium` / `high` | 500-700 | ~1000ms | Knob essentially ignored; always burns thinking tokens regardless of level |

OpenCues forwards `reasoning_effort: none` for this model via `'cerebras:zai-glm-4.7': { max: 'none', off: 'none' }` in `MODEL_THINKING`. The `isReasoningModelName` regex in `buildOpenAIBody` was extended in June 2026 to match `zai-glm` so the field actually reaches the wire — without the extension, the field is silently dropped and zai defaults to full thinking mode (slow + lower accuracy).

### Head-to-head accuracy (gpt-oss-120b vs zai-glm-4.7)

Both with their respective minimum-reasoning setting (gpt-oss-120b at `low`, zai-glm-4.7 at `none`):

| Bench | gpt-oss-120b/low | zai-glm-4.7/none | Delta |
|---|---|---|---|
| fluid-blank standard 137 | 137/137 (100%) | 136/137 (99.3%) | −0.7pp |
| fluid-blank ambient in-prompt 18 | 17/18 (94.4%) | 17/18 (94.4%) | 0pp |
| fluid-blank ambient holdout 21 | 21/21 (100%) | 14/21 (66.7%) | **−33pp** |
| transform-blank prod-fused 231 | 186/231 (80.5%) | 182/231 (78.8%) | −1.7pp (within cerebras variance) |

zai-glm-4.7 is competitive on in-distribution cases (within 1pp) but loses substantially on the ambient holdout — it doesn't generalize ambient patterns the prompt wasn't tuned against (ZIP codes, postcodes, callsigns, label-IS-question cases). gpt-oss-120b stays the cerebras default. zai is a viable opt-in via `blanks-llm-model: zai-glm-4.7` for users who prefer its ~50ms median latency edge over the holdout accuracy gap.

---

## Strict JSON output via `response_format`

Cerebras's `gpt-oss-120b` supports `response_format: { type: 'json_schema', json_schema: { strict: true, schema } }` for constrained decoding. OpenCues uses it in fluid-blank's fused path (`FLUID_FUSED_SCHEMA`) to lock the LLM into emitting `{ span, answer }` reliably.

Switching to a provider that doesn't support strict mode means the parser falls back to label-format output — see the dual-path parsers in `transform-blank-source.ts` / `fluid-blank-source.ts`.

## Payload optimization — gzip request compression

Cerebras's inference API accepts gzip-compressed request bodies via standard HTTP `Content-Encoding: gzip` ([docs](https://inference-docs.cerebras.ai/capabilities/payload-optimization)). OpenCues's `NodeHttpAdapter` gzips every outbound request to `api.cerebras.ai` and adds the header.

**Always on for cerebras. No size gate.** Bench evidence (N=20 per cell, gpt-oss-120b with hidden reasoning) — the saving is asymmetric across the source mix but never net-negative:

| Source shape | Plain body | Gzip body | Reduction | Δ median | Δ p95 |
|---|---|---|---|---|---|
| TransformBlank fused (FUSED_SYSTEM) | 86,384 B | 27,174 B | **−68.5%** | **−100ms** | **−179ms** |
| FluidBlank fused (FUSED_SYSTEM) | 86,205 B | 27,074 B | −68.6% | −44ms | +80ms (noise) |
| ConfigIntent (small system) | 839 B | 490 B | −41.6% | +6ms | −53ms |
| Word-cue spelling | 1,144 B | 701 B | −38.7% | +1ms | **−332ms (−45%)** |
| AgentRewrite short doc | 1,471 B | 828 B | −43.7% | +9ms | **−152ms (−23%)** |
| AgentRewrite long doc | 2,625 B | 1,369 B | −47.8% | −22ms | +7ms |

Big payloads (FUSED_SYSTEM-bearing — transform-blank, fluid-blank) hit −100ms median wins from the wire-size reduction alone. Small payloads (word-cues, ConfigIntent, AgentRewrite) are median-neutral but their p95 tail tightens dramatically — the word-cue p95 −332ms is the standout, since spelling fires on every typing pause.

Implementation: gating lives in `packages/opencues-core/node-http-adapter.js`'s `GZIP_REQUEST_HOSTS` set, currently `{'api.cerebras.ai'}`. The adapter buffers the JSON body with `zlib.gzipSync`, sets `Content-Encoding: gzip` + `Content-Length`, and writes the buffer. Other providers stay on plain JSON; they neither benefit similarly (lower latency floor, smaller prompts) nor have we bench-validated their decoder paths.

Chrome path is unaffected — the chrome bundle uses a throwing stub for `node-http-adapter` and routes through `FetchHttpAdapter` instead. Adding gzip to the browser path would require a `CompressionStream` change in the SW; deferred until measured chrome traffic justifies it.

Bench harnesses in `tests/benchmarks/{fluid-blank,transform-blank}/cerebras.ts` mirror the production wire shape (gzip outbound) so accuracy + latency numbers match what users see.

See [llm-routing.md](llm-routing.md) for the broader provider abstraction.

---

## Where to find these in code

| Feature | File | Symbol / search term |
|---|---|---|
| Provider adapter | `packages/opencues-core/src/llm-provider.ts` | `CEREBRAS` (export) |
| Dispatch + usage callback | `packages/opencues-core/src/llm-provider.ts` | `dispatchChat`, `UsageReport` |
| **Prefix caching** — catalog blocks in system message | `packages/opencues-core/src/sources/transform-blank-source.ts` | `Cerebras prefix-cache optimisation` |
| **Prefix caching** — fluid-blank | `packages/opencues-core/src/sources/fluid-blank-source.ts` | `Cerebras prefix-cache optimisation` |
| **Predicted outputs** — prediction parameter plumbing | `packages/opencues-core/src/llm-provider.ts` | `req.prediction`, `body.prediction` |
| **Predicted outputs** — TransformBlank gate | `packages/opencues-core/src/sources/transform-blank-source.ts` | `PREDICTION_MIN_CHARS` |
| **Hidden reasoning** — conditional gate | `packages/opencues-core/src/llm-provider.ts` | `reasoning_format = 'hidden'` |
| **Gzip request compression** | `packages/opencues-core/node-http-adapter.js` | `GZIP_REQUEST_HOSTS` set + `zlib.gzipSync` in `post` |
| **Reasoning per model** — table | `packages/opencues-core/src/model-thinking.ts` | `MODEL_THINKING` |
| **zai-glm-4.7 fix** — regex match | `packages/opencues-core/src/llm-provider.ts` | `isReasoningModelName` |
| **Cache-hit / pred-accept logging** | All three semantic-`_` sources | `onUsage:` callback in `callLLM` |
| Recall bench (fluid-blank) | `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` | 175/176 target on cerebras |
| Accuracy bench (transform-blank) | `tests/benchmarks/transform-blank/prod-fused.ts` | ~186-193/231 master variance band |

---

*Last updated: June 2026 — covers PR #137 (prefix-cache restructure), PR #138 (predicted outputs), PR #139 (zai reasoning fix), PR #140 (hidden reasoning format), PR #142 (gzip request compression).*
