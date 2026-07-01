# Gemma-4-31b on Cerebras — Benchmark Findings (2026-07-01)

Fresh same-session benchmark of `cerebras:gemma-4-31b` ("Gemma4") vs the
current default `cerebras:gpt-oss-120b`, run to confirm/update the
2026-06-28 hackathon findings (`../gemma-hackathon/FINDINGS.md`).

**Method (per the bench-rate-limit discipline):** same-session baseline,
`--parallel 4`, `OC_BENCH_RETRIES=6`, judge the *delta* not the absolute.
Judge pinned to `groq gpt-oss-120b` for both. Rate-limit phantom
regression ruled out: 0 genuine API errors on transform, model-latency
floor 193ms (gemma) / 310ms (gpt-oss) — no ~20-30ms bail signatures.

## Headline

| Pipeline | gemma-4-31b | gpt-oss-120b | Δ accuracy | Δ latency |
|---|---|---|---|---|
| **transform-blank** (251) | **220/251 (87.6%)** | 209/251 (83.3%) | **+4.3pp** | **451ms vs 1028ms → 2.3× faster** |
| **fluid-blank** (137, answer) | 136/137 (99.3%) | 136/137 (99.3%) | tie | **427ms vs 607ms → 1.4× faster** |

**Verdict:** gemma-4-31b is the stronger choice on Cerebras — it *wins*
transform-blank accuracy AND runs 2.3× faster; it ties fluid-blank at
1.4× faster. Confirms and strengthens the hackathon finding (which had it
faster + tied; the throttle-corrected transform gap is now reproduced in
a clean same-session run).

## Wire-shape correctness (unit)

`llm-provider.gemma.test.ts` — 13/13 pass. gemma correctly **omits**
`reasoning_effort`, `reasoning_format`, and `prediction` (the three
fields it 400s on or that empty `content`). Live smoke: clean `content`,
0 reasoning tokens (non-reasoning model, `MODEL_THINKING` = none/none).

## Transform-blank — per-category (gemma | gpt-oss)

gemma wins the structural/multi-span/reasoning-shaped categories; gpt-oss
edges the nuance categories (multilingual, adversarial, creative).

| Category | gemma | gpt-oss | Δ |
|---|---|---|---|
| linked-concepts | 70.0% | 40.0% | **+30.0** |
| multi-paragraph | 70.0% | 40.0% | **+30.0** |
| code-transform | 100.0% | 80.0% | **+20.0** |
| tone-shift | 80.0% | 60.0% | **+20.0** |
| math | 100.0% | 90.0% | +10.0 |
| concept | 100.0% | 90.0% | +10.0 |
| conditional | 100.0% | 90.0% | +10.0 |
| context-referring | 90.0% | 80.0% | +10.0 |
| negative | 90.0% | 80.0% | +10.0 |
| long-text | 75.0% | 67.5% | +7.5 |
| literal / multi-span | 100% | 100% | 0 |
| format-transform | 96.9% | 100.0% | −3.1 |
| targeted | 94.7% | 100.0% | −5.3 |
| transform | 91.7% | 100.0% | −8.3 |
| trailing-instruction | 91.7% | 100.0% | −8.3 |
| creative-rewrite | 60.0% | 70.0% | −10.0 |
| adversarial | 80.0% | 90.0% | −10.0 |
| multilingual | 83.3% | 100.0% | −16.7 |
| **Total** | **87.6%** | **83.3%** | **+4.3** |

**Read:** gemma is markedly better at multi-span / linked / multi-paragraph
/ code / long structural edits — the bread-and-butter transform-blank
work. gpt-oss retains an edge on multilingual and adversarial/creative
nuance. If multilingual transform matters for a deployment, that's the
one category to weigh.

## Fluid-blank

Exact accuracy tie (136/137 each). The single miss (both effectively at
the ceiling) for gemma was a factual slip — `the largest river is _` →
`Nile` (expected `Loire`), not a pipeline defect. gemma is 1.4× faster on
model time (427ms vs 607ms) and 2.1× faster wall-clock.

## Throughput

| | gemma | gpt-oss |
|---|---|---|
| transform cases/sec | 7.21 | 3.54 |
| fluid cases/sec | 8.28 | 3.88 |

## Operational notes (already enforced in code)

- gemma is **non-reasoning**: any `reasoning_effort ≠ 'none'` routes the
  answer into the `reasoning` field and empties `content` (silent bail).
  Pinned via `MODEL_THINKING['cerebras:gemma-4-31b'] = {max:'none',off:'none'}`.
- gemma **400s on `prediction`** for inputs ≥200 chars — excluded via the
  `capabilities.prediction` allowlist (gpt-oss / zai only).
- Both guards have regression pins in `llm-provider.gemma.test.ts`.

## Reproduce

```bash
# transform (gemma), then baseline:
OPENCUES_CEREBRAS_MODEL=gemma-4-31b OC_BENCH_RETRIES=6 \
  npx tsx tests/benchmarks/transform-blank/prod.ts --provider cerebras --parallel 4
OPENCUES_CEREBRAS_MODEL=gpt-oss-120b OC_BENCH_RETRIES=6 \
  npx tsx tests/benchmarks/transform-blank/prod.ts --provider cerebras --parallel 4

# fluid (gemma), then baseline:
OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss OPENCUES_CEREBRAS_MODEL=gemma-4-31b \
  npx tsx tests/benchmarks/fluid-blank/run.ts --mode answer --parallel 4
OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss OPENCUES_CEREBRAS_MODEL=gpt-oss-120b \
  npx tsx tests/benchmarks/fluid-blank/run.ts --mode answer --parallel 4
```

Requires `CEREBRAS_API_KEY` (inference) + `GROQ_API_KEY` (judge).

---

## Steering experiment (2026-07-01) — over-editing rules, NOT shipped

**Hypothesis:** gemma's real (non-judge-subjective) failures cluster as
*over-editing* — applying a transform too broadly: `grass→grasses`,
`garden→gardens`, adding "some" on pluralize; `purred→barked` (cat→dog
leaked to a neutral verb). Added two surgical rules to `FUSED_SYSTEM`:
(11) pluralize/singularize precision — no mass nouns, no added
quantifiers; (12) literal single-token swap never propagates to
verbs/adjectives (propagation reserved for CATEGORY instructions).

**Targeted cases: the rules WORK** — 4/5 flipped FAIL→PASS
(`long-B5`, `mp-8`, `long-C4`, `long-A10`; `long-A8` still fails).

**But net effect is ZERO.** Same-session A/B (control for session
variance), gemma-4-31b, 251 cases, 2 runs each:

| Steering | run 1 | run 2 | mean |
|---|---|---|---|
| NEW (rules 11+12) | 219 | 212 | 215.5 |
| OLD (baseline)    | 218 | 212 | 215.0 |

Run-to-run variance is ±7 (same config); the new−old delta is +0.5 —
indistinguishable from noise. The targeted fixes are real but exactly
offset by noise-level flips in unrelated categories (math/code/adversarial
single-case swings). Cost: +~100ms latency + prompt bloat.

**Decision: reverted, not shipped.** No net accuracy gain to justify the
latency/bloat, and gemma already wins vs gpt-oss without it. The
over-editing rules are *correct* in isolation (they fix genuine
mis-edits) but the bench can't show a win against its own noise floor —
revisit only if a larger, lower-variance over-editing suite is built.

**Methodology note:** cerebras latency inflates on sustained load —
first clean run ~451-558ms, later sequential runs throttled to
1100-1300ms. Read latency from the FIRST run of a session; accuracy is
unaffected (retry-backed).

---

## Suite expansion (2026-07-01) — 251 → 487 cases, and the multilingual verdict

The 6-case `multilingual` category made the earlier −16.7pp "gap" a single
German sentence — inside the noise. Doubled the whole suite to lower the
noise floor and thickened `multilingual` 6 → 30 (15 languages × varied
ops). New cases in `tests/benchmarks/transform-blank/cases-expansion.ts`
(spread into `CASES`). Loads clean, no dup ids; deterministic categories
have ZERO both-model failures (well-calibrated); the both-fail cases
concentrate in the inherently open-ended categories (linked/creative/tone)
and in *genuine* model weaknesses — not bad expected values.

**Headline (487 cases, same-session, cerebras, parallel 4):**

| | gemma-4-31b | gpt-oss-120b |
|---|---|---|
| Total | **414/487 (85.0%)** | 405/487 (83.2%) |

gemma still wins (+9 cases, +1.8pp) — the gap tightened from +4.3pp (251)
to +1.8pp (487) as noise dropped, but the direction is stable.

**Per-category (now with adequate N):**

| Category (N) | gemma | gpt-oss | read |
|---|---|---|---|
| multilingual (30) | 23 (77%) | **27 (90%)** | **real gemma weakness — the gap survived N=30** |
| creative-rewrite (20) | 8 | 11 | gpt-oss better (subjective) |
| long-text (60) | **50** | 44 | gemma clearly better (structural core) |
| tone-shift (20) | **13** | 9 | gemma better |
| code-transform (20) | **20** | 17 | gemma better |
| math (20) | **20** | 18 | gemma better |
| negative (20) | **19** | 17 | gemma better |
| linked-concepts (20) | 7 | 6 | both weak (open-ended) |
| literal/multi-span/concept/targeted | ~ceiling | ~ceiling | tied |

**Verdict on the original question:** the multilingual gap is **real**, not
noise — with 30 cases gemma trails gpt-oss 77% vs 90% (both stumble on
German der/die article agreement and Spanish over-pluralization; gpt-oss
less so). This *overturns* the mid-investigation "it's just one sentence,
don't weight it" recalibration. So a default-switch to gemma should
genuinely weigh multilingual-heavy usage — the earlier caveat was
correct in spirit, just unmeasurable at N=6.

**Calibration:** two specs were over-narrow (rejected valid outputs) and
were broadened — `linked-n5` (accept "gluten-free pasta") and
`multilingual-n5` (accept the declarative vous form). All other both-fails
are genuine model failures kept as-is.
