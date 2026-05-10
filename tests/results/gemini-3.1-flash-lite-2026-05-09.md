# Gemini 3.1 Flash Lite vs Groq gpt-oss-120b — model comparison

**Date:** 2026-05-09
**Workload:** OpenCues' three production benchmarks (agent-rewrite, transform-blank, fluid-blank).
**Provider switch:** `OPENCUES_BENCH_PROVIDER=gemini-flash-lite` env var routes the existing benchmark runners through `gemini.ts` instead of `groq-impl.ts` — same cases, same scoring, same code paths, drop-in model swap.
**Commit at time of run:** `541dd8d` (master)

## Why this matters

OpenCues' production runtime defaults to **Groq + `gpt-oss-120b`** for every LLM-driven feature (agent-rewrite, transform-blank, fluid-blank, word-cues, etc.). The model is fast but inconsistent on harder workloads. Question: how does the cheapest current Gemini text model (`gemini-3.1-flash-lite`) stack up?

## Headline results

| Benchmark | Cases | Gemini 3.1 Flash Lite (think: low) | Groq gpt-oss-120b | Δ pp |
|---|---:|---:|---:|---:|
| agent-rewrite | 18 | 15/18 = 83.3% | 15/18 = 83.3% | 0 |
| **transform-blank** | 212 | **199/212 = 93.9%** | ~118/212 = 55.7% (3-run avg) | **+38** |
| fluid-blank (--mode answer) | 137 | 134/137 = 97.8% | 137/137 = 100.0% | −2 |
| **Combined** | 367 | **348/367 = 94.8%** | ~270/367 = 73.6% | **+21** |

The gap is dominated by **transform-blank** — Gemini Flash Lite is 38pp better. agent-rewrite and fluid-blank are within noise.

## Latency

| Workload | Gemini Flash Lite | Groq gpt-oss-120b |
|---|---:|---:|
| agent-rewrite | 1190 ms / call | 275 ms / call |
| transform-blank | 1043 ms / call (35.2 s @ p=8) | ~530 ms / call (~16 s @ p=8) |
| fluid-blank P1 | 1069 ms | 628 ms |

**Groq is 2-4× faster across the board.** That's the structural tradeoff — the 38pp accuracy win on transform-blank costs ~500 ms per call.

## Thinking on vs off (Gemini)

Gemini 3.x flash tier has a thinking-token budget knob. We default to `thinkingLevel: 'low'`; the script also accepts `OPENCUES_GEMINI_THINKING=none` (mapped to `thinkingBudget: 0`).

| Setting | transform-blank pass | Avg model latency | Wall-clock (212, p=8) |
|---|---:|---:|---:|
| `thinkingLevel: 'low'` | 199/212 = 93.9% | 1043 ms | 35.2 s |
| `thinkingBudget: 0` | 192/212 = 90.6% | 799 ms | 27.0 s |
| Δ | −7 cases (−3.3pp) | **−244 ms (−23%)** | −8.2 s |

Thinking-off regressions concentrate on the long/abstract categories:
`linked-concepts` (5→4), `long-text` (38→35), `tone-shift` (9→8), `adversarial` (10→9), `context-referring` (10→9).
Mechanical categories (literal, math, multi-span, negative, transform, conditional, concept, trailing-instruction, targeted) stay 100%.

**Practical:** thinking-off is a strict win for the simple workloads (agent-rewrite, fluid-blank). For transform-blank you're trading 3.3pp accuracy for 23% latency.

## Per-category transform-blank breakdown

| Category (10 cases each unless noted) | Gemini-low | Gemini-off | Groq |
|---|---:|---:|---:|
| adversarial | 100% | 90% | 60% |
| code-transform | 90% | 90% | 50–70% |
| concept | 100% | 100% | 60–70% |
| conditional | 100% | 100% | 70% |
| context-referring | 100% | 90% | 30–50% |
| creative-rewrite | 90% | 90% | 60–70% |
| format-transform | 80% | 80% | 40–60% |
| **linked-concepts** | **50%** | 40% | **0%** |
| literal | 100% | 100% | 60–80% |
| long-text (40) | 95% | 88% | 58–60% |
| math | 100% | 100% | 30–40% |
| multi-paragraph | 90% | 90% | 40–50% |
| multi-span | 100% | 100% | 70–80% |
| negative | 100% | 100% | 100% |
| targeted | 100% | 100% | 40–70% |
| tone-shift | 90% | 80% | 10–30% |
| trailing-instruction | 100% | 100% | 30–50% |
| transform (12) | 100% | 100% | 58–67% |

Groq's failures cluster on: anything requiring *reasoning across multiple spans* (`linked-concepts`, `tone-shift`, `context-referring`, `math`, `multi-paragraph`, `targeted`, `trailing-instruction`). The Gemini gap is concentrated where the prompt requires holding multiple concepts in working memory simultaneously.

## Run-to-run variance (Groq, transform-blank)

Three runs of the Groq baseline:

| Run | Pass | Wall-clock |
|---|---:|---:|
| 1 | 111/212 = 52.4% | ~16 s |
| 2 | 121/212 = 57.1% | 14.5 s |
| 3 | 122/212 = 57.5% | — |

**~5pp run-to-run noise.** Source: the LLM-judge step is *also* Groq + gpt-oss-120b, and Groq doesn't strictly honor `seed` — borderline cases flip per run. Honest center: ~56% ± 3pp.

Two Gemini runs at thinking-low both produced **199/212 (93.9%) — identical.** Gemini honors temp=0 determinism better.

## Pricing

Per 1M tokens, public list prices as of 2026-05-09 (sources: ai.google.dev/pricing, groq.com/pricing):

| Model | Input | Output | Batch (50% off) | Cache hit |
|---|---:|---:|---:|---:|
| Gemini 3.1 Flash Lite | $0.25 | $1.50 | $0.125 / $0.75 | $0.025 (text) + $1/M/hr storage |
| Groq gpt-oss-120b | $0.15 | $0.60 | n/a | n/a |

Notable:
- Gemini bundles **thinking tokens into the output rate** ($1.50/M) — no separate "thinking output" price. So `thinkingBudget: 0` saves only the volume of thinking tokens emitted, not a higher rate.
- Groq is **60% cheaper per call** at list, but its lower pass rate on transform-blank means **per-correct-answer cost is roughly tied** at ~$0.0006/pass on this workload (assuming ~2050 input + 50 output tokens per call).
- Gemini's **context-caching** ($0.025/M cached input) would drop per-call cost ~40% on transform-blank because the system prompt is identical across calls. Untested but the math is straightforward.

## WebSocket support

**Gemini text-tier API has no WebSocket transport.** Only `gemini-3.1-flash-live-preview` (audio/video, bidi) supports `bidiGenerateContent`. `gemini-3.1-flash-lite` only ships HTTP methods: `generateContent`, `streamGenerateContent`, `countTokens`, `createCachedContent`, `batchGenerateContent`.

Cross-reference: `tests/results/websocket-mode-2026-05-08.md` — covers WebSocket vs HTTP comparison for OpenAI Responses API + Groq/Cerebras chat-completions. Gemini was deliberately excluded there because no Gemini-WS-text cell exists to benchmark.

For Gemini latency optimization, the available knobs are:
1. `thinkingBudget: 0` — −23% latency, −3.3pp accuracy on transform-blank.
2. `streamGenerateContent` (SSE) — improves perceived TTFT for the runtime; benchmark wall-clock unchanged.
3. `cachedContent` — saves input tokens; modest TTFT win (~100-200ms).
4. Vertex regional endpoint — RTT shave (~50-150ms); requires auth migration.

## Reproducibility

Each benchmark dir grew a `gemini.ts` sibling alongside the existing `groq-impl.ts` (the original `groq.ts` was renamed). The new `groq.ts` is a thin router that dispatches to `gemini.ts` when `OPENCUES_BENCH_PROVIDER=gemini-flash-lite` is set.

Run the comparison:

```bash
# Default: Groq baseline
GROQ_API_KEY=… npx tsx tests/benchmarks/transform-blank/run.ts --parallel 8

# Switch to Gemini 3.1 Flash Lite (think: low)
GEMINI_API_KEY=… OPENCUES_BENCH_PROVIDER=gemini-flash-lite \
  npx tsx tests/benchmarks/transform-blank/run.ts --parallel 8

# Gemini with thinking off
GEMINI_API_KEY=… OPENCUES_BENCH_PROVIDER=gemini-flash-lite OPENCUES_GEMINI_THINKING=none \
  npx tsx tests/benchmarks/transform-blank/run.ts --parallel 8
```

Same env-var switch works for `agent-rewrite/run.ts` and `fluid-blank/run.ts`.

Output captures from this run:
- `/tmp/oc-bench-gemini-tb-full.txt` — Gemini transform-blank, thinking: low
- `/tmp/oc-bench-gemini-tb-nothink.txt` — Gemini transform-blank, thinking: off
- `/tmp/oc-bench-groq-tb-full.txt` (run 1), `-rerun.txt` (run 2), `-rerun3.txt` (run 3)
- `/tmp/oc-bench-gemini-fb-full.txt`, `/tmp/oc-bench-groq-fb-full.txt` — fluid-blank
- `/tmp/oc-bench-gemini-agent-rewrite.txt`, `/tmp/oc-bench-groq-agent-rewrite.txt` — agent-rewrite

(These are tmp captures — re-run the commands above to regenerate.)

## Recommendations

For **transform-blank specifically**, Gemini 3.1 Flash Lite is a strong drop-in upgrade — 38pp accuracy gain at 1.5-2× the latency and ~tied per-correct-answer cost. The runtime supports per-feature provider selection via CUES.md `transform-blank-provider:`, so this can be a targeted swap without touching agent-rewrite or fluid-blank.

For **agent-rewrite + fluid-blank**, accuracy is already at ceiling on Groq (83% / 100%) with sub-second latency. Switching to Gemini gains nothing.

If snappiness matters across the board, **Groq stays default**; CUES.md routes the harder transform-blank prompts to Gemini Flash Lite. That's the production-shaped recommendation from this data.

## Caveats

- **Judge variance**: transform-blank's pass/fail uses an LLM judge (Groq + gpt-oss-120b). The judge is non-deterministic; ~5pp Groq-side run-to-run noise.
- **Sample size**: agent-rewrite has only 18 cases — its 83.3% tied-result is a single-data-point reading, not a robust comparison.
- **Single judge model**: same Groq model judges both Gemini and Groq output. Not strictly biased (judge prompt is independent of model under test) but worth noting.
- **No batch / no caching tested**: pricing math for Gemini batch and cached-input is theoretical. Untested empirically.
- **Snapshot in time**: pricing and model availability change frequently. Re-confirm before making cost decisions on this data alone.
