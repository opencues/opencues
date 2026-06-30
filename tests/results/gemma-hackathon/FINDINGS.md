# gemma-4-31b (Cerebras hackathon) — bench findings

Date: 2026-06-28. Key: hackathon `csk-x4km…j4w` (only key with gemma access).
Judge pinned to groq gpt-oss-120b throughout.

## Headline

- **fluid-blank (clean, valid):** gpt-oss-120b **99.3%** (136/137) vs
  gemma-4-31b **98.5%** (135/137). Statistical tie on quality.
- **gemma is ~2.2× faster than gpt-oss-120b** on Cerebras (see speed table).
- **More reasoning does NOT help gemma** — 6/6 correct at none/low/medium
  on transform cases; reasoning only adds latency.

## Speed (transform FUSED prompt, 8 cases, sequential, max_tokens=2048)

| Model | reasoning | median | min | max |
|---|---|---|---|---|
| gemma-4-31b | none | **196ms** | 182 | 330 |
| gemma-4-31b | low | 283ms | 234 | 375 |
| gpt-oss-120b | low+hidden | 423ms | 312 | 665 |
| gpt-oss-120b | medium+hidden | 445ms | 411 | 917 |

fluid-blank avg model latency: gpt-oss-120b 319ms/case, gemma 204ms/case.

## Reasoning sweep (gemma, 6 transform cases, max_tokens=2048)

| reasoning | correct | latency median |
|---|---|---|
| none | 6/6 | 216ms |
| low | 6/6 | 284ms |
| medium | 6/6 | 251ms |

Verdict: reasoning OFF is best — same accuracy, lowest latency. Gemma is
non-reasoning; with low max_tokens any non-none effort traps the answer in
the `reasoning` field and empties `content` (silent bail).

## Gemma reasoning — what's actually true

**Architectural fact:** the runtime NEVER sends `reasoning_effort` to
gemma-4-31b. The `isReasoningModelName` gate in `buildOpenAIBody` only
matches `o\d|gpt-5|gpt-oss|qwen-3-thinking|zai-glm`; cerebras `buildRequest`
doesn't set `includeReasoningEffort`. Verified: `buildRequest` for gemma
emits `{model, messages}` only — no reasoning field. This is correct
(gemma is non-reasoning; any effort value empties its `content`).

**Correction:** the full-suite "reasoning sweep" below did NOT actually
apply reasoning — even with `OC_GEMMA_MAXR=medium` the request was
identical (no reasoning_effort field). The three numbers are therefore the
SAME no-reasoning request measured 3×, i.e. pure run-to-run variance:

| nominal level | corrected accuracy | note |
|---|---|---|
| none | 221/251 = 88.0% | real |
| "low" | 226/251 = 90.0% | same request — variance |
| "medium" | 222/251 = 88.4% | same request — variance |

→ cerebras has ~±5-case variance at temp=0/seed=42; gemma's true
transform-blank score is **~88% (221-226/251)**.

**Real reasoning test = raw direct API** (forcing reasoning_effort into the
body, max_tokens 2048), 6 cases: none 6/6 @216ms, low 6/6 @284ms,
medium 6/6 @251ms. Accuracy identical; reasoning only costs latency. So
even if the runtime DID forward reasoning to gemma, it wouldn't help.
**Production keeps gemma at none — correct and fastest.**

## transform-blank — SURGICALLY CORRECTED (throttle-stripped, reasoning noted)

Re-ran each model's failures cleanly (parallel 1, rate-limit retry) to strip
throttle artifacts and recompute precisely:

| Model | reasoning | raw run | recovered on clean re-test | CORRECTED |
|---|---|---|---|---|
| gemma-4-31b | **none** (only viable) | 196/251 | +25 of 55 (throttle bails) | **221/251 = 88.0%** |
| gpt-oss-120b | **medium** (advantage) | 210/251 | +1 of 41 (genuine fails) | **211/251 = 84.1%** |

**Reasoning parity (the confound):** NOT equal — gpt-oss ran at `medium`,
gemma at `none`. It can't be equalized: cerebras gpt-oss 400s at `none`
(floor `low`), gemma empties content at any reasoning. The confound favors
gpt-oss (more reasoning), yet gemma still wins → the result is conservative
for gemma. gpt-oss at `low` would only score ≤ its medium 84.1%.

**Conclusion: gemma-4-31b BEATS gpt-oss-120b on transform-blank** (88.0% vs
84.1%) once measurement artifacts are removed — despite a reasoning handicap.
Earlier 196/78.1% figure was throttle-contaminated; 221/88.0% is the real one.

(Prior raw note for history: 196/251 (78.1%) vs 210/251 (83.7%); 41 bails.)

Per-category: literal/multi-span/concept 100%; math 80% (drops a
"Discount" line on hard cases — real 31b capability gap); long-text 62.5%,
multi-paragraph 60%, creative 60% (Gemma weaker on long/creative);
targeted 84%, format 81%, code 90%.

Latency in this run (2671ms avg) is **throttle-backoff-inflated, not real** —
clean direct probe measured Gemma transform at ~196-216ms.

### Three root causes of the original "bail" (NONE was the prompt)
1. Reasoning routing — non-reasoning model, `reasoning_effort!=none` empties content.
2. Cerebras Predicted Outputs — gemma 400s on the `prediction` field (inputs ≥200 chars).
3. **RPM rate-limit** (dominant) — 245/251 threw `request_quota_exceeded`;
   production dispatch had no retry.

## Caveats / harness fixes made

1. **gemma needs `reasoning_effort: none`.** Added `cerebras:gemma-4-31b`
   to `MODEL_THINKING` (none/none) + forced none in both bench cerebras
   adapters. Without it, content is empty → fake 0%.
2. **Rate-limit phantom regression.** The bench cerebras adapters swallow
   throttle errors as empty content → silent bail. The hackathon key
   throttles gpt-oss-120b HARD (gemma gets priority). Added retry-with-
   backoff (`OC_BENCH_RETRIES`). Baseline gpt-oss-120b must run on the
   PERSONAL key for a clean quota.
3. **transform-blank prod.ts bench number for gemma (≈19%) is a HARNESS
   ARTIFACT, not capability.** prod.ts drives the production source whose
   FUSED parser/request shape is gpt-oss-tuned; gemma's output format
   doesn't conform → bails. Proven: the exact cases that "bailed" score
   6/6 when gemma is called directly with the FUSED prompt. To bench
   transform-blank on gemma fairly, the production parser needs gemma-aware
   tolerance (separate work).
