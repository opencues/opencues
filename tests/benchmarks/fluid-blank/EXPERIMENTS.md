# Fluid-blank pipeline experiments

Running log of pipeline / provider experiments for the fluid-blank
benchmark (short factual lookups triggered by `_`). Sister doc to
`transform-blank/EXPERIMENTS.md`; consult that doc for the same
analyses on the harder rewrite task — many findings carry over.

> Suite: 137 cases across factual / math / unit / color / http / roman /
> translation / spelling categories (curated `cases.ts`).
>
> All runs: `temperature: 0`, `parallel: 8`, judge pinned to Groq
> gpt-oss-120b regardless of inference provider (see methodology note
> in transform-blank Experiment 6).

---

## Experiment 1 — 5-provider × 3-pipeline matrix + fused mode introduction

**Hypothesis (carried over from transform-blank):** if "fewer-but-fatter
calls beat more calls" holds on capable models, it should also win on
fluid-blank's simpler task. Fluid-blank's production path is `classified`
(P1 SEGMENT → CLASSIFY → SPECIALIZED|P3 = 3 calls). Test whether a single
`fused` call that emits SPAN + ANSWER together can match or exceed it.

**New code:** `fused.ts` (prompt + parser) + `--mode fused` + `--parallel N`
worker pool in `run.ts` (fluid-blank previously ran sequentially — too
slow for the OpenAI reasoning model). Provider router expanded from 2 to
5 (mirrors transform-blank/groq.ts).

**Methodology fix:** `judge-segment.ts` and `judge-answer.ts` were re-
pinned to import from `./groq-impl` directly so the LLM-judge stays on
Groq gpt-oss-120b regardless of `OPENCUES_BENCH_PROVIDER`. Otherwise
each provider self-judges — see transform-blank Experiment 6 for the
~5pp self-judging inflation we measured there.

Also added an **exact-match short-circuit** at the top of
`judge-answer.ts`: when `actualAnswer` matches `expectedAnswer` (or any
alternate) case-insensitively with whitespace collapsed, return PASS
without a judge call. Survives judge rate-limit and saves a round-trip
on the common case (most fluid-blank answers are short codes/numbers
that match exactly).

**Variants tested:**

| Mode | Calls/case | Description |
|---|---|---|
| `answer` (2-pass) | 2 | P1 SEGMENT → P3 ANSWER, end-to-end |
| `classified` (3-call hybrid) | 3 | P1 → CLASSIFY → SPECIALIZED|P3 (production) |
| `fused` (1-call) | 1 | new — SPAN + ANSWER in one prompt |

**Results (137-case suite, parallel=8):**

```
                         answer (2-pass)    classified (3-call)   fused (1-call)
─────────────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b    100.0% / 1216ms    97.1% / 1674ms        99.3% /  686ms
gemini  flash-lite       98.5% / 1025ms    97.8% / 1629ms        98.5% /  613ms
cerebras gpt-oss-120b    99.3% /  530ms    95.6% /  722ms       100.0% /  262ms  ★
claude  haiku-4.5        99.3% / 1676ms    94.9% / 2479ms        99.3% /  837ms
openai  gpt-5.4-nano     27.0% /  964ms     3.6% /  261ms        40.9% /  425ms
```

**Cost analysis ($/1K cases, May 2026 pricing — see transform-blank
Experiment 7 price card; same per-token rates apply):**

Token estimates for fluid-blank: `fused` ≈ 1020 input / 30 output;
`answer` ≈ 2200 input / 60 output (P1 + P3 prompts compound);
`classified` ≈ 2800 input / 100 output.

```
                         answer (2-pass)    classified (3-call)   fused (1-call)
─────────────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b     $0.37 / $0.37     $0.48 / $0.49         $0.17 / $0.17  ★
gemini  flash-lite       $0.64 / $0.65     $0.85 / $0.87         $0.30 / $0.30
cerebras gpt-oss-120b    $0.82 / $0.83     $1.06 / $1.11         $0.38 / $0.38
claude  haiku-4.5        $2.50 / $2.52     $3.30 / $3.48         $1.17 / $1.18
openai  gpt-5.4-nano     $0.52 / $1.93     $0.68 / $18.89        $0.24 / $0.59
```
(each cell: `$ per 1K cases / $ per correct answer`)

**Findings:**

1. **Fused wins on every well-functioning provider.** Same accuracy or
   better than `answer` AND `classified`, with 2-3× lower latency and
   1.5-3× lower cost. On groq: 99.3% / 686ms / $0.17/correct — the best
   numbers across the entire matrix. The 1-call collapse hypothesis from
   transform-blank holds even more strongly here (fluid-blank's task is
   simpler — short factual output — so models don't get confused
   juggling extract-segment-answer in one prompt).

2. **Cerebras gpt-oss matches Groq on fluid-blank accuracy.** The 13pp
   provider drift we observed on transform-blank (Cerebras 78.8% vs Groq
   91.8% on 3-pass) DOES NOT REPRODUCE on fluid-blank — both providers
   land at 99-100% on `fused`. Cerebras even nominally wins `fused`
   (100.0% vs 99.3%). Inference quality drift hits long-form word-choice
   tasks but doesn't show up on short factual-lookup outputs.

3. **Cerebras `fused` is the speed king: 262ms/case.** Compare:
   - cerebras_fused: 262ms (28 cases/sec)
   - groq_fused:     686ms (11 cases/sec)
   - gemini_fused:   613ms (12 cases/sec)
   - claude_fused:   837ms ( 9 cases/sec)
   - openai_fused:   425ms (24 cases/sec — but at 40.9% acc)

   Cerebras's wafer-scale inference advantage shows up cleanly here — same
   gpt-oss-120b model, ~2.5× faster than Groq's already-fast TPU path.

4. **Classified (the production 3-call hybrid) is the worst pipeline
   choice across all providers.** Always lower accuracy AND higher cost
   AND higher latency than `answer`/`fused`. The "classify-then-route"
   pattern was a win when specialised single-shot prompts beat the
   generic P3 answer — but with current model quality, the routing
   overhead costs more than the specialisation saves.

5. **OpenAI gpt-5.4-nano is unusable here.** Even its best variant
   (`fused` 40.9%) is far below every other provider's worst. The
   classified mode collapses to 3.6% — the reasoning model spends its
   token budget on routing-decision reasoning and leaves nothing for
   the actual answer. Don't ship.

6. **Claude haiku is functional but expensive.** 99.3% on `fused` at
   837ms / $1.17/correct — 7× more expensive than groq for the same
   accuracy at 50% higher latency. No reason to choose it.

**Decision:**

- **New production default: `cerebras · fused`** — 100.0% / 262ms /
  $0.38/correct. Tied for top accuracy across the matrix, fastest by
  a wide margin, ~$0.20 more per 1K cases than groq-fused but worth it
  for the 2.6× latency win on interactive UX. Falls through to groq
  auto-fallback on transient Cerebras errors via the existing pair.
- **Cheapest fallback (auto-route step 2): `groq · fused`** — 99.3% /
  686ms / $0.17/correct. Picked automatically when only `GROQ_API_KEY`
  is set. Also handles transient errors when Cerebras returns 429/5xx.
- **Don't ship**: classified (worse on every axis), Claude (cost),
  OpenAI nano (broken).
- **Drop the classify+specialized infrastructure** unless we find a
  task where it earns its keep. Today's `fused` mode subsumes it.

**Comparison with transform-blank (companion bench):**

| Dimension | Transform-blank | Fluid-blank |
|---|---|---|
| Task | Imperative rewrite ("change boy to girl _") | Short factual lookup ("capital of france _") |
| Output length | Many tokens (whole sentences) | Few tokens (codes, numbers, names) |
| Best provider | Groq gpt-oss (91.8% on 3-pass) | Cerebras/Groq gpt-oss tied at ~100% |
| Best pipeline | 3-pass (high acc) OR fused (cost) | Fused (wins on every axis) |
| Provider drift visible? | Yes — Cerebras 13pp behind Groq | No — both at 99-100% |
| Verify pass useful? | Net-zero | n/a (no verify in fluid-blank) |
| Reasoning models work? | OpenAI single-call OK at 76.6% | OpenAI broken everywhere (<41%) |

**Why the divergence:** transform-blank's task taxes word-choice quality
(where Cerebras inference shows quantization-style drift). Fluid-blank
asks for short single-token answers; almost any competent inference of
any competent model lands the right answer. The pipeline-shape
hypothesis ("fewer calls win on capable models") is reinforced on the
easier task; the model-quality hypothesis ("same name = same model")
is contradicted on the harder task.

**Lessons:**

- **Single-call fused works better on easy tasks than hard ones.** The
  scaffolding-vs-juggling tradeoff cuts cleaner when each step in the
  task is structurally simple.
- **Provider drift is task-coupled.** Don't extrapolate a Groq-vs-Cerebras
  finding from one benchmark to another — re-measure.
- **Production 3-call hybrids age badly.** When the underlying models
  get strong enough to handle the combined job in one prompt, the
  routing layer becomes pure overhead.

**Open follow-ups:**

1. ~~Run the cerebras-vs-groq `fused` comparison ≥5 times.~~ **Done
   2026-05-16.** 5 reps on the full 137-case fluid-blank suite:

   ```
   Provider    Acc %          Per-case ms       Wall s
   ────────────────────────────────────────────────────
   groq        99.12 ±0.63    762 ±37           14.28 ±0.75
   cerebras    99.72 ±0.38    265 ±17           4.98 ±0.41
   ```

   Cerebras `fused` is **2.88× faster** with **slightly better accuracy**.
   Mean ± 2σ intervals don't overlap (Groq [688, 836] vs Cerebras
   [231, 299]) — the gap is statistical bedrock, not noise. Cerebras is
   also tighter on variance (±17ms vs ±37ms), so p99 latency tracks the
   mean more closely. Raw logs: `tests/results/cerebras-vs-groq-fused/`.

2. Implement per-task model mapping: the runtime should be able to read
   `fluid-blank-provider: cerebras-gpt-oss` while `transform-blank-
   provider: groq-gpt-oss` from CUES.md, so each pipeline picks its
   own winner. Today both share one provider config.

3. Add reasoning-token accounting to `chat()` so OpenAI's cost-per-correct
   reflects real spend (currently understated 2-4×).
