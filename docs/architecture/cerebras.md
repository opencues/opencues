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

## Other Cerebras-specific behaviour OpenCues relies on

(Future-proofing: every new Cerebras feature OpenCues adopts gets a section here. Today the list is short.)

### Reasoning effort `medium` for transform-blank / fluid-blank dispatches

Cerebras's `gpt-oss-120b` exposes a `reasoning_effort` parameter. Our default is `medium` for transform-blank and `low` for fluid-blank, tuned by the [thinking-budget bench](../../tests/benchmarks/thinking-budget/). The `max-thinking: off` scalar dials this down further (see [max-thinking.md](max-thinking.md)).

### Strict JSON output via `response_format`

Cerebras's `gpt-oss-120b` supports `response_format: { strict: true, schema }` for constrained decoding. We use it in fluid-blank's fused path (`FLUID_FUSED_SCHEMA`) to lock the LLM into emitting `{ span, answer }` reliably. Switching to a provider that doesn't support strict mode means the parser falls back to label-format output — see the dual-path parsers in `transform-blank-source.ts` / `fluid-blank-source.ts`.

See [llm-routing.md](llm-routing.md) for the broader provider abstraction.

---

## Where to find these in code

| What | File | Symbol |
|---|---|---|
| Provider adapter | `packages/opencues-core/src/llm-provider.ts` | `cerebrasAdapter` |
| Dispatch + usage callback | `packages/opencues-core/src/llm-provider.ts` | `dispatchChat`, `UsageReport` |
| Catalog blocks in system message | `packages/opencues-core/src/sources/transform-blank-source.ts` | search `Cerebras prefix-cache optimisation` |
| Same for fluid-blank | `packages/opencues-core/src/sources/fluid-blank-source.ts` | search `Cerebras prefix-cache optimisation` |
| Cache-hit debug logging | All three semantic-`_` sources | `onUsage:` callback in `callLLM` |
| Recall bench | `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` | 175/176 target on cerebras |

---

*Last updated: June 2026 (cerebras prefix-cache restructure PR).*
