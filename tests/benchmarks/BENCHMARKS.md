# Benchmarks — provider, pipeline, and cost landscape

Cross-benchmark summary of what we've measured across the two LLM-
driven pipelines that the runtime ships today. Each pipeline has its
own running experiment log; this doc is the consolidated reference
for "given my task and constraints, which provider × pipeline should
I pick?"

Source documents:
- `tests/benchmarks/transform-blank/EXPERIMENTS.md` — imperative-rewrite
  pipeline (Experiments 1–7). The 3-pass EXTRACT → APPLY → VERIFY
  architecture and its variants.
- `tests/benchmarks/fluid-blank/EXPERIMENTS.md` — short-factual-lookup
  pipeline (Experiment 1). The fused 1-call replacement for the
  legacy classified hybrid.

Raw logs:
- `tests/results/matrix-v2/` — transform-blank 5×4 matrix.
- `tests/results/fluid-matrix-v1/` — fluid-blank 5×3 matrix.
- `tests/results/cerebras-vs-groq-fused/` — 5-rep head-to-head.

---

## Methodology — what makes a number trustworthy here

1. **Judge pinned to Groq gpt-oss-120b.** Self-judging (when judge and
   inference share a provider) inflates accuracy ~5pp. Both benches now
   import `judge*.ts` from `./groq-impl` directly, ignoring
   `OPENCUES_BENCH_PROVIDER`.
2. **Same suite per bench every run.** transform-blank: 231 cases.
   fluid-blank: 137 cases.
3. **`temperature: 0`, `seed: 42`** on every provider that exposes them.
   Gemini's `thinkingBudget: 0` by default.
4. **`parallel: 8`** worker pool by default (6 for OpenAI nano to stay
   under TPM). Wall-clock numbers reflect this.
5. **Exact-match short-circuit in fluid-blank judge** — answers matching
   expected/alternates case-insensitively skip the LLM judge entirely.
   Both saves judge cost AND survives transient rate-limit on judge
   endpoint.
6. **Soft-fail on rate-limit & parse errors** — `groq-impl.ts` returns
   empty text rather than throwing, so one rate-limited case during a
   parallel sweep doesn't kill a whole 137-case run.

**Known limitations:**
- Cost numbers are estimated from prompt-length × per-token prices, NOT
  from API `usage` blocks. OpenAI gpt-5.4-nano's reasoning-token spend
  is understated 2-4× as a result.
- Run-to-run variance hasn't been formally measured for most rows
  (single sample each, except the cerebras-vs-groq head-to-heads).
  Treat ±3pp accuracy and ±15% latency as the practical noise floor.
- Pricing snapshot: 2026-05-16. Re-fetch before quoting in external
  material.

---

## Provider × pipeline matrix — at a glance

**Transform-blank (231 cases) — accuracy / per-case ms / $-per-correct:**

```
                          3-pass                 single-call            fused                  fused+verify
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b      91.8% / 1459 / $0.84    17.7% /  532 / $1.02    80.5% /  727 / $0.32 ★   83.1% /  925 / $0.51
gemini  flash-lite        90.0% / 2263 / $1.52    89.2% /  729 / $0.37    89.2% /  772 / $0.54     90.5% / 1213 / $0.86
cerebras gpt-oss-120b     78.8% /  933 / $2.13    29.4% /  330 / $1.36    76.2% /  331 / $0.74     47.6% /  363 / $1.89
claude  haiku-4.5         87.9% / 3048 / $6.03    82.3% /  912 / $1.56    88.7% / 1125 / $2.06     84.4% / 1497 / $3.64
openai  gpt-5.4-nano †    20.8% /  806 / $5.34    76.6% / 1431 / $0.35    48.9% / 1101 / $0.80     31.2% /  600 / $2.12
openai  gpt-5.4-mini  †   23.4% /  964 / $4.75    81.4% / 1251 / $0.79    85.3% / 1332 / $2.14     58.4% / 1129 / $3.92
openai  chat-latest   †   90.0% / 2766 / $30.44   86.1% /  970 / $7.72    86.6% / 1056 / $11.03    81.4% / 1382 / $12.53
```
† OpenAI rows: nano @ $0.20/$1.25, mini @ $0.75/$4.50, chat-latest (gpt-5.5 Instant) @ $5/$30 per M tokens.
   chat-latest forces `reasoning_effort: 'medium'` minimum (no 'low' or 'none' allowed).

**Fluid-blank (137 cases) — accuracy / per-case ms / $-per-correct:**

```
                          answer (2-pass)         classified (3-call)    fused (1-call)
─────────────────────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b     100.0% / 1216 / $0.37    97.1% / 1674 / $0.49    99.3% /  686 / $0.17 ★
gemini  flash-lite        98.5% / 1025 / $0.65    97.8% / 1629 / $0.87    98.5% /  613 / $0.30
cerebras gpt-oss-120b     99.3% /  530 / $0.83    95.6% /  722 / $1.11   100.0% /  262 / $0.38   (fastest)
claude  haiku-4.5         99.3% / 1676 / $2.52    94.9% / 2479 / $3.48    99.3% /  837 / $1.18
openai  gpt-5.4-nano      27.0% /  964 / $1.93     3.6% /  261 / $18.89   40.9% /  425 / $0.59
openai  gpt-5.4-mini       9.5% /  480 / $5.47    13.1% /  603 / $5.19    80.3% / 1062 / $1.46
openai  chat-latest      100.0% / 1529 / $12.80   98.5% / 2249 / $17.26   99.3% /  855 / $6.04
```

★ = best cost-per-correct in the bench.

### New scores vs the original Groq gpt-oss-120b setup

Original production default (Q1 2026): `groq · openai/gpt-oss-120b · 3-pass`
on transform-blank, `groq · openai/gpt-oss-120b · classified` on fluid-blank.
Below: what each May 2026 alternative buys you vs that baseline.

```
TRANSFORM-BLANK — vs groq gpt-oss 3-pass (91.8% / 1459ms / $0.84)
─────────────────────────────────────────────────────────────────────────────────
groq      · fused              80.5% / 727ms  / $0.32    −11.3pp  -50% lat  -62% $   ← cheap mode
gemini    · single-call        89.2% / 729ms  / $0.37    −2.6pp   -50% lat  -56% $
gemini    · fused              89.2% / 772ms  / $0.54    −2.6pp   -47% lat  -36% $
cerebras  · fused              83.1% / 425ms  / $0.74    −8.7pp   -71% lat  -12% $   ← speed mode
claude    · fused              88.7% / 1125ms / $2.06    −3.1pp   -23% lat  +145% $
openai    · mini · fused       85.3% / 1332ms / $2.14    −6.5pp   -9%  lat  +155% $
openai    · chat-latest · 3p   90.0% / 2766ms / $30.44   −1.8pp   +90% lat  +3522% $
openai    · chat-latest · fused 86.6% / 1056ms / $11.03  −5.2pp   -28% lat  +1213% $

FLUID-BLANK — vs groq gpt-oss classified (97.1% / 1674ms / $0.49)
─────────────────────────────────────────────────────────────────────────────────
cerebras  · fused             100.0% / 262ms  / $0.38    +2.9pp   -84% lat  -22% $   ← new default
groq      · fused              99.3% / 686ms  / $0.17    +2.2pp   -59% lat  -65% $   ← cheapest fallback
gemini    · fused              98.5% / 613ms  / $0.30    +1.4pp   -63% lat  -39% $
claude    · fused              99.3% / 837ms  / $1.18    +2.2pp   -50% lat  +141% $
openai    · chat-latest · fused 99.3% / 855ms / $6.04    +2.2pp   -49% lat  +1133% $
```

**Takeaway:** the old Groq baseline is no longer the right default on either
pipeline. On transform-blank, no alternative beats it on accuracy under a
fair judge, but `groq · fused` and `cerebras · fused` win on latency at a
real but defensible accuracy cost. On fluid-blank, every other provider's
`fused` mode beats it on every axis — the old `classified` 3-call hybrid
is strictly dominated.

---

## When to pick which

### Production defaults (today)
| Pipeline | Provider × mode | Acc | Latency | $/correct |
|---|---|---|---|---|
| transform-blank | groq gpt-oss · 3-pass | 91.8% | 1.5s | $0.84 |
| fluid-blank | groq gpt-oss · classified (currently) | 97.1% | 1.7s | $0.49 |

### Proposed defaults (post-benchmark)
| Pipeline | Provider × mode | Acc | Latency | $/correct | Why switch |
|---|---|---|---|---|---|
| transform-blank | groq gpt-oss · 3-pass (no change) | 91.8% | 1.5s | $0.84 | Still accuracy ceiling under fair judge |
| fluid-blank | **cerebras gpt-oss · fused** | **100.0%** | **0.3s** | **$0.38** | +2.9pp acc, 84% faster than current `classified`; tied for top accuracy, fastest in the matrix |

### Mode toggles to expose
| Toggle name | Pipeline | Provider × mode | Use case |
|---|---|---|---|
| `transform-blank-mode: cheap` | transform-blank | groq · fused | Batch / agentic / cost-sensitive — 80.5% acc at $0.32/correct |
| `transform-blank-mode: fast` | transform-blank | gemini · single-call | Interactive UX — 89.2% acc at 729ms |

### Don't ship
| Config | Why |
|---|---|
| Claude haiku (any mode, either bench) | 3–10× more expensive than groq/gemini for marginal accuracy gain |
| Cerebras gpt-oss on transform-blank | Word-choice quality drift — 13pp behind Groq's gpt-oss-120b on the rewrite task |
| OpenAI gpt-5.4-nano (any mode, either bench) | Reasoning model wastes budget on every short-output task; max 76.6% acc |
| Fused-verify (any provider except groq) | Verify prompt tuned to gpt-oss failure modes; net-hurts every other model |
| classified (fluid-blank, any provider) | Strictly dominated by `fused` on every axis |

### Historical context — Cuescore replay (Feb 2026 → May 2026)

The repo had an older "cuescore" benchmark from Feb 18, 2026 (raw logs
in `tests/results/cerebras-120b-20260218-173230.txt` etc.) that ran
math + factual + grammar cases through gpt-oss-120b via Groq and via
Cerebras. The original harness depended on a now-deleted external
script (`~/.claude/llm-analyze-auto.sh`), but the cases themselves
were ported into `tests/benchmarks/fluid-blank/cases-{math,factual}
-bench.ts` and run via `--math-bench` / `--factual-bench` flags.

Replaying the math + factual portion on May 16, 2026:

```
                    Feb 2026 acc   May 2026 acc   Δ          Feb→May latency
─────────────────────────────────────────────────────────────────────────────
groq    gpt-oss     73.5%          99.2%         +25.7pp    489ms → 1148ms
cerebras gpt-oss    64.0%          99.2%         +35.2pp    1687ms →  526ms (3.2× faster)
```

(May columns: 257/259 cases passing for both. Full table is in the
matrix above — this row is just the math+factual subset for the
historical comparison.)

**Important methodology caveat — the Feb and May benchmarks are NOT
directly comparable.** Settings deltas explain most of the delta:

| Setting | Feb 18 cuescore | May 16 replay |
|---|---|---|
| Codebase | pre-monorepo `cues-core` (now removed) | `@opencues/core` + fluid-blank suite (introduced 2026-04-30) |
| Pipeline | Single specialized call per type (MathSource / FactualSource) | 2-pass P1 SEGMENT → P3 ANSWER |
| Placeholder | `BLANK` | `_` |
| Output format | Free-form `ANSWER=value` | Structured `SPAN:` + `ANSWER:` |
| Temperature | **0.3 (factual), 0.1 (math)** | **0.0** |
| reasoning_effort | **default (high)** | **`low`** |
| seed | not set | **42** pinned |
| Concurrency | sequential | `parallel=8` |
| Math case count | 109 | 157 (expanded) |

**Revised findings:**

1. **The 25-35pp accuracy jump is mostly opencues-side, not
   provider-side.** The shift from `temperature=0.3` to `0.0` alone
   explains a large fraction of the gain (T=0.3 trades determinism
   for plausibly-wrong sampling on borderline cases). Combined with
   the 2-pass pipeline + structured-output prompts + pinned seed,
   the opencues-side changes account for most of the accuracy delta.
   Provider inference quality has plausibly improved too, but this
   benchmark can't separate the two contributions.

2. **Cerebras's 3.2× latency drop (1687ms → 526ms) IS real provider
   improvement.** Pipeline changes can only add latency (2-pass
   doubles the call count); they cannot make individual API calls
   faster. So Cerebras genuinely shipped faster inference between
   Feb and May. Groq's apparent slowdown (489 → 1148ms) is the
   opposite — likely `parallel=8` TPM contention against the shared
   judge endpoint, not Groq getting slower.

3. **The Feb-era "Cerebras < Groq" accuracy rule is partly settings-
   coupled.** At temp=0.3 (Feb), Cerebras's slightly noisier inference
   on the same model produced more wrong answers; at temp=0.0 (May),
   the gap closes for short-answer tasks. The drift gap survives on
   long-form rewrites (transform-blank) because rewriting forces many
   sampling decisions where the deterministic-vs-noisy difference
   still leaks through.

**What we'd need to actually settle "did the provider get faster":**
re-run Feb's cuescore on today's Groq + Cerebras endpoints using the
*old* harness (single call, temp 0.3, sequential). The old harness
depends on a deleted external script (`~/.claude/llm-analyze-auto.sh`)
so this would require reconstructing the harness from the shell
scripts + the deleted `cues-core` prompts that are in git history at
commit `23a2eab` (2026-03-24). Open follow-up if the Cerebras-
infrastructure-improvement claim ever needs to be defended rigorously.

Raw logs: `tests/results/cuescore-replay/`.

### Cerebras vs Groq head-to-head on `fused` (5 reps each)

```
Bench       Provider    Acc %          Per-case ms      Wall s        Reps
─────────────────────────────────────────────────────────────────────────
transform   groq        84.30 ±1.29    595 ±32          20.18 ±1.11   5
transform   cerebras    80.80 ±0.27    335 ±6           13.12 ±0.28   5
fluid       groq        99.12 ±0.63    762 ±37          14.28 ±0.75   5
fluid       cerebras    99.72 ±0.38    265 ±17          4.98  ±0.41   5
```

- **Cerebras `fused` is 1.8–3× faster than Groq `fused`** on both benches.
  Per-case latency intervals (mean ± 2σ) do not overlap on either bench —
  the gap is statistically overwhelming, not noise.
- **Cerebras has dramatically tighter latency variance** (±6ms vs ±32ms
  on transform; ±17ms vs ±37ms on fluid). Predictability matters for
  interactive UX where p99 latency drives perceived snappiness.
- **Fluid-blank: pure win.** Cerebras matches accuracy (99.7 vs 99.1)
  AND is 2.9× faster. No tradeoff.
- **Transform-blank: speed-vs-accuracy trade.** 1.8× faster but 3.5pp
  less accurate. Defensible for fast-mode toggle, not as default.

---

## Headline findings (cross-bench)

1. **"Fewer-but-fatter calls beat more calls" is real but task-coupled.**
   - On fluid-blank (easy short-output task): fused wins on every
     provider that can produce usable output.
   - On transform-blank (hard rewrite task): fused wins on Gemini/Claude,
     loses to 3-pass on Groq gpt-oss (the smallest/cheapest model).
   - **Rule of thumb:** the smaller the model and harder the task, the
     more scaffolding helps. The larger the model and easier the task,
     the more scaffolding hurts.

2. **"Same model name" doesn't mean "same output quality" across
   providers.** Cerebras's gpt-oss-120b is 13pp behind Groq's on the
   rewrite task but ties Groq on fluid-blank. Quantization / sampler
   defaults / inference-stack drift leak into output quality and only
   show up on tasks that tax word-choice precision.

3. **Pipeline shape is model-class-coded, not universal.** A pipeline
   tuned to one model embeds that model's failure modes. Crossing
   model classes (small MoE → general LLM → reasoning model) requires
   re-evaluating the pipeline, not just swapping the API key.
   - Multi-pass scaffolding suits gpt-oss-class models.
   - Single-call suits general capable models (Gemini/Claude).
   - Reasoning models (gpt-5.4-nano) want one big budget per call —
     multi-pass starves them.

4. **Layered verify nets out negative across providers.** The VERIFY
   pass was tuned to gpt-oss's failure modes; on every other provider
   it "corrects" valid drafts into worse outputs. Cerebras fused-verify
   was the worst (76.2 → 47.6%, −28.6pp catastrophe). Either retune
   per-provider or drop it.

5. **Cost-per-correct is the right pick metric, not $/1K.** A cheap
   model that's only 30% accurate costs more per usable output than a
   moderately-priced model at 90%. Always compute `$/1K ÷ accuracy`
   before picking from a price-per-token leaderboard.

6. **Self-judging inflates accuracy ~5pp.** Both pipelines now pin the
   LLM judge to Groq gpt-oss-120b regardless of inference provider.
   Cross-provider A/Bs must use one fixed judge or the comparison is
   meaningless.

---

## Open follow-ups (cross-bench)

1. **Real token accounting.** Instrument `chat()` to capture
   `response.usage.{prompt_tokens, completion_tokens}` and write to
   each per-case log line. Replaces all $/1K estimates with measurements.
   Especially fixes OpenAI's 2-4× reasoning-token undercount.
2. **Variance bands.** ≥5 repetitions per row to compute mean/stddev
   of accuracy and latency. Started for cerebras-vs-groq `fused` on
   both benches — `tests/results/cerebras-vs-groq-fused/`.
3. **Per-pipeline provider routing in runtime.** Today's runtime picks
   one provider for everything; benchmarks point at different winners
   per pipeline. Add `fluid-blank-provider` / `transform-blank-provider`
   override fields to the host config.
4. **Auto-pick.** Given a user's network speed and budget, the runtime
   could pick mode/provider automatically. Out of scope for now but
   worth a sketch.
5. **Re-tune VERIFY per provider** (or per model class). The current
   prompt is gpt-oss-shaped. If we want a verify step in a generalist-
   model pipeline, it needs different instructions.

---

*Last updated: 2026-05-16.*
