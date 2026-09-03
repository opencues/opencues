# qwen-3.8-27b discovery sweep — 2026-09-03/04

Cerebras shipped `qwen-3.8-27b` and deprecated `gemma-4-31b` to Public
preview. This sweep discovers the model's wire behaviour, benches it
against same-session baselines, and certifies the config-intent prompt
edit that adds the `qwen` natural-language alias.

## Wire discovery (live probes, 2026-09-03)

`/v1/models` (live key): `gpt-oss-120b`, `gemma-4-31b`, `qwen-3.8-27b`.
gemma still serves (back-compat holds) but is deprecated upstream.

| Probe | Result |
|---|---|
| plain call (no `reasoning_effort`) | **thinks by default** — separate `reasoning` field, content populated (31 reasoning tokens on trivial math) |
| `reasoning_effort: low` | accepted; ~16 reasoning tokens; content populated |
| `reasoning_effort: none` | accepted; 0 reasoning tokens; clean content |
| `prediction` (Predicted Outputs) | **HTTP 400** `"prediction" is not currently supported` — same as gemma; the `capabilities.prediction` allowlist already excludes it |
| strict JSON schema | works |

Consequences wired into `@opencues/core` 0.57.0:
- `isReasoningModelName` regex matches `qwen-3.8` (forwarding is what
  makes the pin controllable — same trap shape as zai-glm-4.7).
- `MODEL_THINKING['cerebras:qwen-3.8-27b'] = { max: 'low', off: 'none' }`.
- `knownModels` + config-intent `qwen` alias (few-shot + prefilter keyword).
- Pinned by `llm-provider.qwen.test.ts`.

## fluid-blank (137 cases, fused, parallel 4, judge pinned groq gpt-oss-120b)

| Model · reasoning | Accuracy | Avg latency |
|---|---|---|
| gpt-oss-120b · low (baseline) | 137/137 (100%) | 288ms |
| gemma-4-31b · none | 136/137 (99.3%) | 245ms |
| **qwen-3.8-27b · low** | **137/137 (100%)** | **274ms** |
| qwen-3.8-27b · none | 135/137 (98.5%) | 279ms |

'low' fixes both 'none' misses (Loire/Seine knowledge miss + a
multi-clause formatting fail) at zero latency cost → ceiling = `low`.

## transform-blank (487 cases, PROD fused source, parallel 4, judge pinned)

| Model · reasoning | Accuracy | Avg latency |
|---|---|---|
| gpt-oss-120b · medium (baseline) | 415/487 (85.2%) | 531ms |
| gemma-4-31b · none | 424/487 (87.1%) | 413ms |
| **qwen-3.8-27b · low** | **424/487 (87.1%)** | **1153ms** |
| qwen-3.8-27b · none | 405/487 (83.2%) | 1080ms |

- qwen @low ties gemma for top accuracy and beats gpt-oss by ~2pp.
- The latency is raw throughput (~1500 tok/s vs gpt-oss's ~3000), NOT
  thinking: dropping to 'none' saves only ~73ms while costing 3.9pp.
  Confirms `off: 'none'` is a real reduced tier but `low` is the ship level.
- qwen weak categories @low: linked-concepts 10/20, creative-rewrite 13/20,
  tone-shift/multi-paragraph/context-referring 15/20 — same families gemma
  struggles with, plus linked-concepts.

## Verdict

`qwen-3.8-27b` is the recommended small-model pick replacing the
deprecated `gemma-4-31b`: parity-or-better accuracy everywhere, but ~2.2×
gpt-oss latency on long rewrites — so `gpt-oss-120b` STAYS the cerebras
default; qwen is the by-name choice (`blanks-llm-model: qwen-3.8-27b`,
`use qwen for blanks _`), strongest on lookup-heavy configs.

## config-intent prompt edit (qwen alias) — certification

Same-session, cerebras gpt-oss, `fluid-config/prod.ts --suite all --parallel 4`:

| Prompt | settings precision / recall | undo precision / recall | total pass |
|---|---|---|---|
| baseline (HEAD) | 100% / 84.8% | 100% / 90% | 84/91 |
| qwen example ADDED (gemma kept) | 100% / 81.8% | 100% / 95% | 84/91 |
| qwen REPLACING gemma | 100% / 84.8% | 100% / 90% | 84/91 — but `use gemma for blanks _` misroutes to **ollama/gemma4:e2b** (dead local provider) |

Shipped: BOTH examples kept (qwen + gemma). Total pass identical to
baseline (one marginal settings hidden-fail case trades for one undo
case); precision 100% on every variant. Alias probes on the shipped
prompt: `use/switch qwen` → cerebras/qwen-3.8-27b (conf .94-.96) on
blanks AND cues scopes; `use/switch gemma` → cerebras/gemma-4-31b
(conf .93-.94). The replacement variant was rejected specifically for
the ollama misroute — a deprecated alias must degrade safely, not
reroute to a provider the user doesn't run.

## Raw logs

`fluid-*.txt` (fluid-blank), `transform-*.txt` (transform-blank),
`fluid-config-baseline.txt` / `fluid-config-candidate2.txt` (shipped
prompt run — `.txt` because the repo gitignores `*.log`). Bench adapters: fluid-blank's cerebras adapter gained
`OPENCUES_CEREBRAS_REASONING` sweep override; transform's `prod.ts`
gained `OPENCUES_BENCH_MAX_THINKING=off` to measure reduced tiers
through the production resolution path.
