# Thinking-budget bench — May 18 2026 · MAX_TOKENS=2048 re-run

Follow-up to `thinking-budget-2026-05-18.md`. Tests the hypothesis
that the `reasoning: high` accuracy collapse on gpt-oss-120b (98% → 20%)
was purely a `max_tokens=512` budget issue — reasoning tokens
consumed the entire output budget, leaving no room for output.

**Workload:** identical to the original run (40-case stride sample of
fluid-blank, p50 latency, parallel=8). Only knob: `MAX_TOKENS=2048`.

## Per-cell results (MAX_TOKENS=2048)

```
provider   reasoning    acc       median    mean      p95      err
─────────────────────────────────────────────────────────────────────
groq       none            0%      0ms      0ms      0ms   40   ← rejects 'none'
groq       low            95%    834ms    861ms   1543ms    0
groq       medium         98%   1668ms   1605ms   2882ms    0
groq       high           95%   3685ms   3664ms   5227ms    0   ★ acc recovered (was 20% at 512)

cerebras   none            0%    187ms    209ms    333ms    0
cerebras   low            98%    244ms    265ms    462ms    0
cerebras   medium        100%    329ms    332ms    448ms    0
cerebras   high           98%    529ms    552ms    861ms    0   ★ acc recovered (was 20% at 512)

gemini     none           93%    502ms    969ms    932ms    0
gemini     low            93%    787ms    808ms    897ms    0
gemini     medium         93%    795ms    823ms   1022ms    0
gemini     high           93%   1557ms   1737ms   2525ms    0   ← acc up from 85%

openai     none           95%    742ms   1330ms   6517ms    0
openai     low            93%   1040ms   1277ms   3709ms    0
openai     medium         93%   1953ms   2210ms   4615ms    0
openai     high           93%   1928ms   3067ms  12714ms    0
```

## Delta vs MAX_TOKENS=512

```
                                    acc                latency
                              ─────────────────   ─────────────
groq       high             20% → 95%  (+75pp)   2501 → 3685 ms  ★
cerebras   high             20% → 98%  (+78pp)    430 →  529 ms  ★
gemini     high             85% → 93%   (+8pp)   1535 → 1557 ms
openai     high             93% → 93%      —      1936 → 1928 ms
groq       medium           98% → 98%      —     1436 → 1668 ms
cerebras   medium           98% → 100%  (+2pp)    358 →  329 ms
```

**Hypothesis confirmed.** The 75-78pp accuracy collapse on
`gpt-oss-120b · high` was 100% a budget-starvation artifact, not a
model failure. Reasoning tokens were consuming the entire 512-token
output budget, leaving zero room for the model to emit its answer.

Bumping to 2048 tokens adds 47-184 ms of latency (the model uses the
extra budget to actually finish reasoning + emit) and unlocks
near-perfect accuracy on what was previously the worst-rated
configuration.

## Knee point — MAX_TOKENS=2048, transform target tightened to 1000 ms

Targets: word-cue ≤ 500 ms · fluid-blank ≤ 1500 ms · transform ≤ 1000 ms
(the bench previously used 3000 ms for transform; tightened May 18 to
match OpenCues's actual UX bar — interactive transform rewrites should
feel under-a-second, not "up to three seconds is fine").

```
provider     word-cue       fluid-blank    transform
─────────────────────────────────────────────────────────
groq         —              low            low
cerebras     medium         high           high            ★ wins every pipeline + reasoning slot
gemini       —              medium         medium
openai       —              low            none            (low 1040 ms misses 1000 ms by 40 ms)
```

Versus the 512-token + 3000-ms-transform knee:

| Provider | word-cue | fluid-blank | transform |
|---|---|---|---|
| groq | unchanged (—) | medium → **low** (latency over at 2048) | medium → **low** (target tightened) |
| cerebras | unchanged (medium) | medium → **high** ★ | medium → **high** ★ |
| gemini | unchanged (—) | unchanged | medium → **medium** (high now 🟡 at 1557 ms) |
| openai | unchanged (—) | unchanged | high → **none** (every reasoning level now over 1000 ms target) |

**Cerebras unlocks `high` reasoning on every non-word-cue pipeline.**
At 552 ms p50 for `high`, it's still inside the 1500 ms fluid-blank and
3000 ms transform budgets. No other provider gets that headroom — gemini
high hits 1557 ms (just over fluid-blank target), openai high is 1928 ms
p50 but 12714 ms p95 (variance murders it).

## Implications for production routing

1. **`reasoning: high` is no longer disqualified on gpt-oss models.**
   The `don't ship` rule in BENCHMARKS.md should soften to: "ensure
   max_tokens ≥ 1024 when shipping high reasoning". The pairing is
   already commit `132fd3d` (`per-provider reasoning defaults +
   paired max_tokens on high`).
2. **Cerebras gpt-oss · high is a new viable configuration** for
   fluid-blank + transform-blank surfaces where the extra reasoning
   buys accuracy and 552 ms p50 is acceptable.
3. **`groq · high` is viable on transform-blank** (3685 ms p50 is
   just over the 3000 ms target — 🟡 amber, not 🔴) but the latency
   hit is real (2.5× slower than groq medium for +0pp accuracy on
   fluid-blank, marginal on harder tasks).

## How to re-run

```bash
MAX_TOKENS=2048 GROQ_API_KEY=... CEREBRAS_API_KEY=... GEMINI_API_KEY=... OPENAI_API_KEY=... \
  npx tsx tests/benchmarks/thinking-budget/run.ts
```

For comparison against the original 512-token bench, omit `MAX_TOKENS`
(default 512) or set `MAX_TOKENS=512` explicitly.

---

*Generated 2026-05-18 follow-up to `thinking-budget-2026-05-18.md`.*
