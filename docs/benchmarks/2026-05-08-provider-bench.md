# Provider Bench — gpt-oss-120b on Groq vs Cerebras (+ peers)

**Date:** 2026-05-08
**Models tested:** `openai/gpt-oss-120b` on Groq, `gpt-oss-120b` on Cerebras,
`gpt-5.4-nano` on OpenAI, `claude-haiku-4-5-20251001` on Anthropic.
**Reasoning levels tested:** `low`, `medium`, `high`.
**Prompts used:** the actual production system prompts —
`P1_SYSTEM_PROMPT` (fluid-blank), `P2_APPLY_SYSTEM` (transform-blank),
and `REWRITE_SYSTEM_PROMPT` (agent-rewrite). No abbreviation.
**Cases:** 38 realistic cases (14 agent, 12 transform, 12 fluid),
sourced from `tests/benchmarks/agent-rewrite/cases.ts`,
`tests/benchmarks/fluid-blank/cases.ts`, and the rules section of
`P2_APPLY_SYSTEM`.
**Bench scripts:** `packages/opencues-core/scripts/bench-realistic.ts`,
`bench-providers.ts`, `bench-quality.ts`, `bench-advanced.ts`.

---

## 1. Pricing (per million tokens, on-demand)

| Provider | Input | Output | Caching | Notes |
|---|---|---|---|---|
| **Groq** | $0.15 | $0.60 | input drops to $0.075/M with prompt caching | Batch API halves all rates |
| **Cerebras** | $0.35 | $0.75 | — | ~3000 tok/sec on wafer silicon |

**Cerebras costs roughly 2.3× more on input, 1.25× more on output**
than Groq for the same `gpt-oss-120b` weights. For OpenCues's
long-prompt surfaces (fluid-blank's 130-line P1, transform's
~100-line P2_APPLY) input dominates total cost, so the effective
multiplier is closer to 2× on those surfaces.

Sources:
- [Groq pricing](https://groq.com/pricing) — confirmed $0.15 / $0.60.
- [Cerebras pricing](https://www.cerebras.ai/pricing) — confirmed
  $0.35 / $0.75.
- [Groq prompt-caching announcement](https://groq.com/blog/gpt-oss-improvements-prompt-caching-and-lower-pricing).

---

## 2. Speed bench (3 input sizes × 3 output caps × 2 trials, median)

All numbers in ms. Lower is better. `TTFT` = time to first byte;
`Wall` = total round-trip; `Tok/s` = output_tokens / (Wall − TTFT).

### Final speed table (after tuning)

| Provider | TTFT (ms) | Wall (ms) | Notes |
|---|---|---|---|
| **groq** / gpt-oss-120b | **49–119** | **85–155** | Untouched config |
| cerebras / gpt-oss-120b | 167–328 | 184–530 | Same model, slower TTFT |
| openai / gpt-5.4-nano | 327–1336 → 344–539 | tuning gained ~30% | After `reasoning_effort: 'none'` + `verbosity: 'low'` |
| anthropic / haiku-4.5 | 524–1009 | 557–939 | Already at floor |

### Tuning that made a difference
- **HTTP keep-alive** (shared `https.Agent` per host): removes TLS-handshake noise from TTFT measurements. Production already uses this via `NodeHttpAdapter`.
- **OpenAI**: `reasoning_effort: 'none'` (not 'low'!) + `verbosity: 'low'` gained ~30% latency.
- **`max_completion_tokens` rename**: gpt-5/o-series hard-rejects `max_tokens`. Adapter detects by model-name regex.
- **`temperature` strip**: gpt-5/o-series only accepts default `1`. Adapter strips other values.

### Speed at increasing reasoning levels (gpt-oss-120b, 14 hard tasks, 1024-token budget)

| Reasoning | Groq avg | Cerebras avg |
|---|---|---|
| low | **174ms** | 240ms |
| medium | 282ms | **243ms** ← essentially flat on Cerebras |
| high | 495ms | 322ms |

**Crossover at `medium`:** Cerebras's wafer throughput catches up once
internal reasoning tokens dominate the wall time. For low reasoning
(production default), Groq wins by 38%; for medium, Cerebras wins by
14%; for high, Cerebras wins by 35%.

---

## 3. Quality bench — production prompts, 38 realistic cases

Run on 4 candidates: `groq (low)`, `groq (medium)`,
`cerebras (low)`, `cerebras (medium)`.

| Candidate | Agent (14) | Transform (12) | Fluid (12) | **Total** | Avg ms |
|---|---|---|---|---|---|
| 🥇 **cerebras (low)** | 11/14 | 8/12 | **12/12** | **31/38** (82%) | **342ms** |
| groq (low) | 10/14 | 9/12 | 10/12 | 29/38 (76%) | 477ms |
| groq (medium) | 11/14 | 9/12 | 5/12 ⚠️ | 25/38 (66%) | 933ms |
| cerebras (medium) | 11/14 | 8/12 | 5/12 ⚠️ | 24/38 (63%) | 407ms |

### Three load-bearing findings

**1. Medium reasoning DESTROYS fluid-blank (both hosts).** Pass rate
collapsed 10–12/12 → 5/12. Failure mode: model outputs prose-style
reasoning instead of the `SPAN: / CONTEXT:` two-line format the parser
requires. The fluid prompt's "Output exactly two lines" instruction
gets overridden by deeper internal reasoning. **Never use medium for
fluid-blank.**

**2. Cerebras (low) is faster than Groq (low) on long prompts.**
342ms vs 477ms — opposite of the short-prompt bench. The fluid
P1_SYSTEM_PROMPT alone is 130+ lines; transform P2_APPLY_SYSTEM is
similar. With this much input, Cerebras's per-token throughput
overtakes Groq's TTFT lead.

**3. Per-suite winners are different.**
- **Agent**: tied at 11/14 (cerebras low/medium and groq medium).
- **Transform**: groq edges (9/12 vs cerebras 8/12). Groq nails
  `tx-composed` ("organised the colours of my favourite analogue
  metres"); Cerebras misses "analogue".
- **Fluid**: cerebras wins decisively (12/12 vs groq 10/12). Groq
  fails `f-port` (kept "firewall config" chatter in the SPAN) and
  `f-nonseq-pizza` (dropped the trailing `_`).

---

## 4. Production routing recommendation

### Per-surface mapping

| Surface | Provider | Reasoning | Why |
|---|---|---|---|
| Per-cue / per-blank (default) | **groq** | low | Short prompts → Groq's TTFT wins; same quality |
| Spelling | **groq** | low | Same |
| TransformBlank | **groq** | low | Edges Cerebras on `tx-composed` |
| AgentRewrite | **cerebras** | low | Long prompts; Cerebras matches quality and is faster on long input |
| FluidBlank | **cerebras** | low | 12/12 vs Groq's 10/12 (clear quality win) |

### Reasoning level: stay on `low` everywhere
Quality saturates at `low`. Medium provides marginal agent gains but
catastrophic fluid regressions. High is even worse and slower across
the board. **No production surface benefits from going above `low`.**

### Fallback policy
**Groq ↔ Cerebras as automatic fallback for each other.** Both run the
same `gpt-oss-120b` weights with OpenAI-shape wire format, so
fall-through requires only URL + API key + model-name swap. This
gives:
- Quota resilience: per-RPM rate limits don't block the user.
- Outage resilience: regional Groq/Cerebras outages don't take the
  product down.
- Predictable cost: fallback only fires on transient failure.

Implementation: `withFallback()` in `@opencues/core`'s `llm-provider`
module wraps the HTTP adapter, detects 429 / 5xx / network errors in
the response body, and re-issues against the alternate provider
(swapping URL, auth header, and model name).

---

## 5. Methodology + caveats

### What I controlled for
- HTTP keep-alive (shared `https.Agent` per host) — consistent across
  candidates, so TLS-handshake noise doesn't bias against further
  hosts.
- Exact production prompts imported via re-export
  (`P1_SYSTEM_PROMPT`, `P3_SYSTEM_PROMPT`, `P2_APPLY_SYSTEM`).
- Token budget bumped to 1024–2048 so high-reasoning runs don't
  starve before producing visible output.

### What's still noisy
- Single-trial runs per cell. Some cell-to-cell deltas (esp. Cerebras
  medium vs low at ~3ms apart) are within variance. Trends across
  multiple cells are reliable; individual cells aren't.
- Free-tier rate limits hit during long runs. Both Groq and Cerebras
  threw 429s mid-bench; a couple of fluid-blank tasks got marked
  failure when they were really queue exhaustion.
- A few "transform" failures are prompt-design issues, not model
  issues:
  - `tx-multi-paragraph` — `P2_APPLY_SYSTEM` says "Output exactly one
    line, nothing else: `REWRITE: <text>`", which structurally can't
    represent multi-paragraph output. **Real bug in the production
    prompt.**
  - `tx-generative` — same prompt framing struggles with "ADD a
    closing line."
  - `tx-concept-vehicle` — my test fixture was too strict (rejected
    "highway" when bikes can in fact go on highways).

### What still needs benching
- Streaming TTFT under sustained throughput (current bench is
  one-shot; under load Groq's RPM cap might bite first).
- Long-document agent-rewrite (the `lng-1` agent case is still <100
  words; real OpenCues sessions can hit 5000+ word documents).
- Anthropic + OpenAI for the long-prompt tier — currently excluded
  for cost; worth re-running once the gpt-oss tier is stable.

---

## 6. Concrete wiring change as a result of this bench

The following per-feature settings get baked into `defaults/OPENCUES.md`
and the boot-layer fallback config:

```yaml
# Global default — short-prompt surfaces stay on Groq.
llm-provider: groq
llm-model: openai/gpt-oss-120b

# Long-prompt surfaces — Cerebras wins on quality + speed.
fluid-blank-provider: cerebras
fluid-blank-model: gpt-oss-120b
agent-provider: cerebras
agent-model: gpt-oss-120b

# Reasoning stays at low everywhere.
```

Both providers automatically fall back to each other on 429 / 5xx /
network errors. Implementation lives at
`packages/opencues-core/src/llm-provider.ts:withFallback()`.
