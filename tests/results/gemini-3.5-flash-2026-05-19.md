# Gemini 3.5 Flash bench — 2026-05-19

First measurement of `gemini-3.5-flash` against the OpenCues fluid-blank
+ thinking-budget benches. The model is live on the v1beta endpoint
(`generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`)
as of today and answers identically-shaped requests to
`gemini-3.1-flash-lite` — same `generationConfig.thinkingConfig.thinkingBudget: 0`
disables the thinking step, same `generationConfig.maxOutputTokens`
caps content. No new request fields needed.

The bench adapters (`tests/benchmarks/{fluid-blank,transform-blank,agent-rewrite}/gemini.ts`)
gained an `OPENCUES_GEMINI_MODEL` env override so a one-line switch
selects the new model:

```bash
OPENCUES_GEMINI_MODEL=gemini-3.5-flash \
  OPENCUES_BENCH_PROVIDER=gemini-flash-lite \
  npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused
```

## Headline result — fluid-blank fused (137 cases, parallel=6, thinking off)

| Model                       | Accuracy  | Avg model | Δ vs 3.1-flash-lite |
|-----------------------------|-----------|-----------|---------------------|
| `gemini-3.1-flash-lite` (baseline, from `BENCHMARKS.md`) | 98.5% / 135 | 613ms     | —                   |
| `gemini-3.5-flash` (this run)                            | 98.5% / 135 | **727ms** | same accuracy, **+114ms** (+19%) slower |

Same two cases fail on both models (`r-stomach-ph`, `r-rgb-goldenrod`
formatting nits — known judge quirks). **3.5-flash is NOT a strict
upgrade over 3.1-flash-lite for fluid-blank lookups.**

## Thinking-budget breakdown (20-case stride sample, MAX_TOKENS=2048)

```
provider   reasoning    acc       median    mean      p95      err
─────────────────────────────────────────────────────────────────────
gemini     none         95%      887ms     876ms    1031ms    0
gemini     low          75%     1244ms    1341ms    2025ms    0   ← acc collapse
gemini     high         85%     2000ms    2023ms    2969ms    0
```

Compared to `gemini-3.1-flash-lite` at the same MAX_TOKENS (from
`thinking-budget-2026-05-18-maxtokens-2048.md`):

| reasoning | 3.5-flash acc | 3.1-flash-lite acc | 3.5-flash p50 | 3.1-flash-lite p50 | delta             |
|-----------|---------------|--------------------|---------------|---------------------|-------------------|
| none      | 95%           | 93%                | 887ms         | 502ms               | +2pp acc, +385ms  |
| low       | **75%**       | 93%                | 1244ms        | 787ms               | **−18pp acc**, +457ms |
| high      | 85%           | 93%                | 2000ms        | 1557ms              | −8pp acc, +443ms  |

**3.5-flash regresses on this workload at every reasoning level.** The
`low`-reasoning collapse (−18pp) is the most striking — the model's
thinking step appears to derail answers on the harder cases instead
of helping. `high` only partially recovers.

## Knee point — max reasoning where p50 ≤ threshold AND acc ≥ 90%

Targets: word-cue ≤ 500ms · fluid-blank ≤ 1500ms · transform ≤ 1000ms

```
provider     word-cue       fluid-blank    transform
─────────────────────────────────────────────────────────
gemini-3.5-flash   —              none           none
gemini-3.1-flash-lite —            medium         medium
```

3.5-flash fits NO pipeline above `none` (90% accuracy floor not met
at `low` or `high` due to the collapse, and `none` itself misses the
500ms word-cue budget at 887ms p50). 3.1-flash-lite remains useable
across pipelines at `medium`.

## Recommendation

**Do NOT promote `gemini-3.5-flash` to default.** Keep
`gemini-3.1-flash-lite` as the shipped gemini default in
`packages/opencues-core/src/llm-provider.ts:386`. The new model
might be better for OTHER workloads (longer prose generation, code
generation, multi-turn) — those aren't OpenCues's surfaces. Users
who want it can opt in via per-feature `fluid-blank-model:` /
`<feature>-model:` overrides in `~/.cues/OPENCUES.md`.

## Transform-blank fused (231 cases, parallel=6, thinking off) — added 2026-05-19

| Model                       | Accuracy   | Avg model | Δ vs 3.1-flash-lite |
|-----------------------------|------------|-----------|---------------------|
| `gemini-3.1-flash-lite` (baseline, from `BENCHMARKS.md` matrix) | 89.2% / 206 | 772ms     | —                   |
| `gemini-3.5-flash` (this run)                                   | **85.7%** / 198 | **892ms** | **−3.5pp accuracy**, **+120ms** (+15%) slower |

So the regression is NOT fluid-blank-specific — it generalises to
transform-blank too. Per-category breakdown reveals where 3.5-flash
loses ground vs 3.1-flash-lite:

```
linked-concepts        4/10  (40.0%)   ← worst regression
tone-shift             4/10  (40.0%)   ← worst regression
multi-paragraph        7/10  (70.0%)
long-text             32/40  (80.0%)
context-referring      8/10  (80.0%)
creative-rewrite       8/10  (80.0%)
adversarial            8/10  (80.0%)
code-transform         9/10  (90.0%)
conditional            9/10  (90.0%)
format-transform      27/29  (93.1%)
transform / negative / math / targeted / trailing-instruction  100%
```

The categories that hold (math, targeted, simple transforms) suggest
3.5-flash handles SHORT, LITERAL rewrites fine; it struggles on
LONG-CONTEXT or NUANCED tasks (linked-concepts, tone-shift,
multi-paragraph) — the model picks the wrong target or partially
rewrites. This matches the fluid-blank thinking-off-wins pattern:
3.5-flash's added capability comes with added inference variance
that hurts on workloads needing precise behaviour.

**Conclusion still holds:** keep `gemini-3.1-flash-lite` as shipped
default. Users with linked-concepts / tone-shift / multi-paragraph
needs (rare in interactive cue / blank flows) should NOT pick
3.5-flash either; 3.1-flash-lite remains higher accuracy at lower
latency.

## Min-token-floor sweep — both models at `OPENCUES_BENCH_MAX_TOKENS=2048` (added 2026-05-20)

Followup to rule out the "3.5-flash needed more budget" hypothesis.
Re-ran both pipelines with the bench harness's new `OPENCUES_BENCH_MAX_TOKENS`
env-var floor at 2048 (default was 512 / 1024 — see
`fluid-blank/fused.ts` and `transform-blank/fused-extract-apply.ts`).

**Transform-blank fused (231 cases, thinking off, min 2048 tokens):**

| Model                     | Accuracy   | Avg model | Δ vs 3.1-flash-lite |
|---------------------------|------------|-----------|---------------------|
| `gemini-3.1-flash-lite`   | **90.0%** (208/231) | **579ms** | —                   |
| `gemini-3.5-flash`        | 87.0% (201/231)     | 821ms     | **−3.0pp, +42% slower** |

**Fluid-blank fused (137 cases, thinking off, min 2048 tokens):**

| Model                     | Accuracy   | Avg model | Δ vs 3.1-flash-lite |
|---------------------------|------------|-----------|---------------------|
| `gemini-3.1-flash-lite`   | 97.8% (134/137) | **517ms** | —                   |
| `gemini-3.5-flash`        | 97.8% (134/137) | 689ms     | **same accuracy, +33% slower** |

### Verdict at higher budget

**Verdict unchanged — 3.5-flash still regresses, but the shape shifted:**

- Accuracy gap NARROWED slightly on transform-blank (was −3.5pp at default budgets, now −3.0pp at min 2048). The extra budget recovered ~2pp on `tone-shift` (40% → 60%).
- Latency gap WIDENED on both pipelines (was +15% / +19% at default budgets, now +42% / +33% at min 2048). The wider budget lets 3.1-flash-lite finish faster on cases that previously hit its cap; 3.5-flash sees only marginal latency gain.
- 3.1-flash-lite also benefits from the higher budget (+0.8pp on transform-blank, slight perf gain on both). So bumping the floor isn't a "free lunch" that only helps 3.5-flash — both models get headroom.

### Per-category breakdown at min 2048 (transform-blank)

3.5-flash gains:
- `tone-shift`: 40% → 60% (+2 cases)
- `creative-rewrite`: 80% → 90% (+1)
- Lost ground: none vs the 1024-floor baseline.

But 3.1-flash-lite ALSO gained at 2048:
- `tone-shift`: holds 80% (better than 3.5-flash's 60%)
- `linked-concepts`: 60% (vs 3.5-flash's 40% — still the worst category)
- `long-text`: 85% (vs 3.5-flash's 80%)

So the gap persists category-by-category. 3.5-flash isn't "starved" at the lower budget — it's structurally weaker on the long-context / nuanced categories.

## Verdict (final)

**`gemini-3.5-flash` regresses vs `gemini-3.1-flash-lite` on OpenCues
workloads at every budget tested.** Don't promote it to default.
Per-cue / per-feature overrides remain available for users who want
to opt in for other reasons (e.g. larger context window, different
training data — neither tested here).

## Followups

- Watch for `gemini-3.5-flash-lite` — Google may ship a flash-lite
  variant of 3.5 (probed today, returned 404). When it lands,
  re-bench — `-lite` variants historically fit OpenCues budgets
  better than full `-flash`.
- A `3.5-flash · high reasoning` transform-blank run would tell us
  whether thinking RECOVERS accuracy on the hard categories
  (linked-concepts, tone-shift) at the cost of latency. Today's
  fluid-blank thinking-budget evidence says no — but the workload
  is different enough that transform-blank with thinking might
  behave differently. Skipped here because the thinking-off result
  already disqualifies it.

## Repro

```bash
# Fluid-blank — full 137-case fused suite
OPENCUES_GEMINI_MODEL=gemini-3.5-flash \
  OPENCUES_BENCH_PROVIDER=gemini-flash-lite \
  OPENCUES_GEMINI_THINKING=none \
  npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused --parallel 6

# Thinking-budget — 20-case stride sample × {none, low, high}
OPENCUES_GEMINI_MODEL=gemini-3.5-flash MAX_TOKENS=2048 PROVIDERS=gemini \
  SUBSET=20 LEVELS=none,low,high PARALLEL=4 \
  npx tsx tests/benchmarks/thinking-budget/run.ts
```
