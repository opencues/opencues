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

## Live-host validation (2026-09-04, headless opencode, isolated home pinned to qwen)

23 scenarios driven against the real runtime with every bucket on
cerebras/qwen-3.8-27b. **16 passed** — including the full transform /
fluid / replace-parse / config-intent / selector-satellite / sentence-cue
(passive+cycle+cede) / session-contradiction / bill-split contracts, and
the three-trigger chain with no double-fire. Cerebras prefix caching
confirmed live on qwen: 96.5% cached tokens on the fluid prompt.

Failure triage (2 env, 2 qwen, 0 runtime bugs):

| Scenario | Verdict |
|---|---|
| 15/16 sentence-cue (first run) | ENV — shipped `more-formal` now carries `not-on-host: claude-code, gemini-cli, opencode`; the cue never builds on opencode for ANY model. Unscoping it in the test home → 3/3 pass on qwen (incl. `ALT: NONE` cede discipline). Scenarios predate the host-scoping. |
| 119 fluid-blank WIPE | ENV — `reddit com _` is claimed by the STOCKS blank (`reddit` → RDDT via deterministic shape match, 0 LLM); fluid-blank never runs, on any model. Deleting the home's `blanks/stocks/` did NOT remove the blank (baked defaults keep it — blank count stayed 99), so the scenario is un-runnable in a stocks-enabled home. |
| 112 contradiction weekday-date | **QWEN** — the contradiction EXTRACT (cues bucket) returns no typed claim for the weekday-date sentence; Tier-0 verify is deterministic so a correct parse must flag. Control: pass in 2.4s on groq/gpt-oss. Reproduced twice on qwen. Consistent with the wrapper pinning gpt-oss as the validation model. |
| 121 ask-cues | **QWEN latency** — the cue EMITTED correctly (sensible question, 3 options) but ~36s after inject, 1.6s past the 30s budget; gpt-oss lands it in 6.9s. Content fine, throughput isn't. |

Also found + fixed during triage: `describeLLMCall` logged
`reasoning=medium` for qwen (it read the provider default, not the
model-thinking ceiling) while the wire correctly sent `low` — the debug
line now runs the same resolution as the wire.

**Net:** no runtime bugs; qwen holds every interactive contract. Its weak
spots agentically match the bench: background whole-buffer analysis calls
(contradiction extract, session-cue/ask) are where its parse quality and
throughput lag gpt-oss — and those ride the cues bucket. A config that
keeps `cues` on gpt-oss-120b and puts blanks on qwen gets the best of
both.

## Raw logs

`fluid-*.txt` (fluid-blank), `transform-*.txt` (transform-blank),
`fluid-config-baseline.txt` / `fluid-config-candidate2.txt` (shipped
prompt run — `.txt` because the repo gitignores `*.log`). Bench adapters: fluid-blank's cerebras adapter gained
`OPENCUES_CEREBRAS_REASONING` sweep override; transform's `prod.ts`
gained `OPENCUES_BENCH_MAX_THINKING=off` to measure reduced tiers
through the production resolution path.
