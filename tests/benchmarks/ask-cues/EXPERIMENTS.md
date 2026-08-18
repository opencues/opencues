# ask-cues prompt experiments

Every variant tried against `bench.mjs` on cerebras/gpt-oss-120b, 3 runs each
(v4 has 9). Recorded so the next attempt starts from the dead ends rather than
rediscovering them.

**Read the noise floor first.** `p1-quality` is an average over 12 judge calls
and still swings ±0.15 between identical runs — v4 measured 0.83 pooled over six
runs and 0.69 over the next three, same bytes. `p2-quality` (n=8) is steadier,
and `MENTIONS CONTEXT` is deterministic. Rank variants on p2-quality and
mentions; treat a p1-quality difference under ~0.15 as nothing. One earlier
round of tuning was scrapped precisely because it "improved" a metric that was
this noisy.

| Variant | p1-quality | p2-quality | mentions | firing | Verdict |
|---|---|---|---|---|---|
| baseline | 0.69 | 0.83 | 9/24 (38%) | 12/12 · 8/8 | — |
| v2 anti-echo block | 0.80 | 0.87 | **3/24 (13%)** | 12/12 · 8/8 | grounding halved: worked examples were all context-free, so the model imitated their genericness |
| v3 + context worked-examples | 0.65 | 1.05 | 9/18 | 12/12 · **6/8** | two example blocks compete; firing suppressed |
| **v4 = v2 + one-line context rule** | 0.77 (9 runs) | **1.13** | **12/24 (50%)** | 12/12 · 8/8 | **SHIPPED** |
| v5 + "name the fork" (terse examples) | **0.61** | **1.47** | 9/21 | 12/12 · 7/8 | best p2 quality of any variant, at a real p1 cost |
| v6 = v5 with natural phrasing | 0.80 | 0.92 | 9/24 | 12/12 · 8/8 | recovers p1, loses the p2 gain — so terseness was not the driver |
| v7 = v4 + fork rule scoped to context-present | 0.54 | 1.22 | **12/18 (67%)** | 11/12 · 6/8 | best mentions rate; p1 fell even though the rule cannot apply there |

## What shipped, and why

**v4.** Two changes over baseline:

1. **An anti-echo block.** The dominant failure was restating the sentence as a
   question — "Just hardcode the API key for now." → *"Do you want to hardcode
   the API key for now?"*. Six of twelve phase-1 questions scored 0 on that
   pattern. Four BAD/GOOD pairs kill it: hardcode-the-key and skip-the-tests
   both moved 0 → 2.
2. **One sentence** requiring at least one option to be built from the session
   or page context when there is any.

Phase 2 quality separates cleanly from baseline (every v4 run ≥ 1.00, every
baseline run ≤ 0.88) and mentions go 3/8 → 4/8 in every single run. Phase-1
quality is inside the noise floor, so v4 claims nothing there.

## The open lead

**v5's "name the fork" rule is the strongest single result in this table** —
phase-2 quality 1.47 against v4's 1.13 — and it costs phase-1 quality. v6 shows
the cost is not the clipped phrasing, and v7 shows scoping the rule to the
context-present branch does not avoid it either, which is strange enough to be
worth understanding: the rule cannot apply when there is no context, yet phase 1
still dropped. Prompt length is the obvious suspect and was not isolated.

If you pick this up: get a real p1 baseline (10+ runs) before trusting any
phase-1 delta, and try the fork rule as a *replacement* for the anti-echo block
rather than an addition — they may be teaching the same lesson twice, and the
combined prompt is long.

## Rerun

```
CEREBRAS_API_KEY=… ANTHROPIC_API_KEY=… node tests/benchmarks/ask-cues/bench.mjs
node tests/benchmarks/ask-cues/bench.mjs --gen gemma   # the live default
node tests/benchmarks/ask-cues/bench.mjs --gen haiku   # fires on 1-2 of 8 — see below
```

**Model choice is not the lever.** On the fixed bench: `gpt-oss-120b` mentions
context 6/16, `gemma-4-31b` 4/16, both firing 8/8. `claude-haiku` fires on only
1–2 of 8 — it abstains rather than asking generically, which is a different
failure, not an improvement. The gap is the prompt and the task.
