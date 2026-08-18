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

## The document (August 2026) — the biggest lever found so far

The source sent the model **one sentence** and nothing else. The rest of the
draft sat in `context.text` and was never passed. That made a whole class of
question unanswerable in principle: writers routinely make a loose claim and
support it in the very next line, and a cue that flags the loose half has
merely proved it did not read on.

`renderDocumentWindow` now sends a bounded window with the target sentence
marked `⟦⟧`, and the prompt tells the model to **answer its own question from
the document before asking it**. Phase 3 of the bench exists to measure this:
eight cases where the same kind of sentence appears in a document that either
does or does not resolve it — including the same sentence ("I'll deal with the
error handling later") in both roles, so the suite discriminates rather than
rewarding a blanket policy.

| Arm | Silent when the doc answers | Useful, of what it showed |
|---|---|---|
| no document (what shipped before) | **0/4** — twice | **0/8** — twice |
| document sent | 2/4 | 1/6 |
| document + "answer it from the doc first" | **3/4** | 1/5 |

The first row is the finding: without the surrounding text it asked on every
single case, and **not one of those questions was useful** — they were all
questions the document had already answered. Coverage on genuinely-open cases
stayed 4/4 throughout, so the restraint was not bought by going quiet.

### Next lead: template lock-in

The GOOD examples in the anti-echo block all phrase their question as "How will
you mitigate / verify …", and the model has generalised the *phrasing* rather
than the *principle*: nearly every question now opens "How will you …",
including "We should make the app more user-friendly" → "How will you make the
app more user-friendly", which is the echo again wearing the winning costume.
Diversify the GOOD examples' surface forms and re-measure; the fix is probably
several differently-shaped examples rather than more rules.

## The architecture sweep (August 2026) — every inference-time mechanism, benched

The research literature offers three mechanisms (EVPI candidate-ranking, ACL
2018; future-turn discrimination, ICLR 2025; detect-then-generate, EMNLP 2023).
`explore-bench.mjs` runs all of them as arms over six realistic drafts — the
suite where the shipping arm scores 1/14 useful — with three gates applied
post-hoc, and `detect2-bench.mjs` + follow-ups harden the detector every
standard way. The result is a map of dead ends, which is worth exactly as much
as the map of what works:

| Mechanism | Result | Why it fails |
|---|---|---|
| strict apply-gate (≥2 distinct applies) | **REFUTED as a usefulness proxy** | dropped 17 questions of which 2 were the useful ones (advisory-shaped, no applies); kept 10 of which 6 were junk. The moment a prompt demands applies, the model fabricates 3–4 distinct ones for junk questions. Applies measure editability, not usefulness. |
| EVPI-lite (3 candidates, rank by discrimination) | no lift | the ranker is the refuted gate; candidates game it |
| whole-document single call | 3× fewer interruptions, same low useful% | volume win only — worth having, doesn't fix quality |
| detect-then-generate, naive detector | detector 3–4/6 | catches forks, invents them on clean drafts |
| + hardened prompt | 3/6 | fixes clean drafts, loses 3 of 4 real forks — the precision/recall seesaw |
| + 3-sample consensus | 1–2/6 | collapses toward NONE |
| propose-then-verify-settled | 1/6, three runs | the verifier finds a "settling" quote for nearly everything — models answer rather than abstain |
| reasoning effort low → medium → high | 3/6 = 3/6 = 3/6 | not a compute problem |

One real signal survived: **judge quality tracks ON-FORK** — whether the
question addresses the draft's genuinely open decision — far better than any
structural property of the output. And where the detector was right
(launch-scope), the targeted generator produced the only q2 in the document
family. The bottleneck is identifying the fork, and no inference-time
configuration of this model does that reliably on prose.

### The conclusion the whole session points at

Every feature in this codebase that benches well verifies LLM output against
CHECKABLE DATA (session-contradiction: watchlist + verbatim quote;
contradiction-cues: runtime-computed corrections; fluid-blank: a fact). Ask-cues
has no reference data — its output is judgement about prose — and every attempt
to bolt a checkable invariant onto it either got gamed (applies) or collapsed
recall (verify/consensus). The literature's actual answer is training (the ICLR
2025 method labels preferences by simulating future turns), which is out of
scope for a runtime that ships prompts.

Inference-time ceiling on realistic drafts, as measured: **~20–35% of shown
questions are genuinely useful**, whatever the architecture. The two honest
product options are (a) default `ask-cues-mode` off, or (b) restrict asking to
GROUNDED triggers — a tension with the session watchlist or a contradiction
with the document — which converges ask-cues onto the session-cue design that
already works.

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
