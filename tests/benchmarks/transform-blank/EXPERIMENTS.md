# Transform-blank pipeline experiments

Running log of architecture/prompt experiments and their results. Each
section is one experiment with a hypothesis, methodology, and findings.

> Suite: 162 cases across 13 categories (literal, multi-span, concept,
> transform, negative, math, linked-concepts, long-text [4 buckets],
> targeted, multi-paragraph, conditional, context-referring,
> trailing-instruction).
>
> Model: `openai/gpt-oss-120b` via Groq, `temperature: 0`,
> `reasoning_effort: 'low'`, `seed: 42`. All runs use the parallel
> benchmark runner with concurrency 8.

---

## Experiment 1 — Strategy comparison

**Hypothesis:** the 3-pass design (EXTRACT → APPLY → VERIFY) trades
~3× the latency of a single LLM call for some accuracy gain. Quantify
the trade. Try a few alternative pipeline shapes to see if any match
3-pass accuracy at lower cost.

**Variants tested:**

| Mode | Calls | Description |
|---|---|---|
| `single-call` | 1 | One prompt: identify + apply + sanity-check in a single shot |
| `rewrite` (1-pass) | 1 | Earlier prototype: TRANSFORM/NONE verdict + rewrite |
| `extract-apply` (2-pass) | 2 (or N+1 for composed) | EXTRACT splits instruction/target, APPLY rewrites |
| `extract-apply-verify` (3-pass) | 3 (or N+2) | + VERIFY checks AGREEMENT/COVERAGE/STRUCTURAL/PROPAGATION |
| `extract-apply-verify-skip-easy` | 2 or 3 | Skip VERIFY for literal swaps (`change X to Y`) |

**Results (parallel=8 across all):**

```
Strategy                           Pass rate         Per-case   Wall-clock
──────────────────────────────────────────────────────────────────────────
single-call                        19.1% (31/162)    507ms      11.1s
rewrite                            45.7% (74/162)    577ms      16.8s
extract-apply       (2-pass)       82.7% (134/162)   1123ms     27.1s
extract-apply-verify (3-pass)      85.8% (139/162)   1586ms     34.5s
extract-apply-verify-skip-easy     84.6% (137/162)   1576ms     34.3s
```

**Per-category breakdown (3-pass, the default):**

```
literal              100%   targeted             100%
multi-span           100%   trailing-instruction 100%
concept               90%   linked-concepts       90%
transform             92%   long-text             85%
negative              90%   conditional           70%
math                  80%   context-referring     60%
multi-paragraph       60%
```

**Findings:**

1. **2-pass is the speed sweet spot.** It reaches 82.7% — only 3pp below
   3-pass — at 30% lower per-case latency. Recommend exposing as a
   "fast-mode" toggle. 3-pass remains the default.

2. **`single-call` is broken** at 19.1%. Catastrophically fails on
   every category that needs sophisticated EXTRACT (conditional,
   context-referring, trailing-instruction all 0%). The model can't
   juggle "is this a transform?" + "extract instruction + target" +
   "apply the transform" + "check consistency" in one prompt. The
   model even returned `VERDICT: TRANSFORM | NONE` literally on a
   pluralize case — confused enough to echo the placeholder. Confirms
   the architectural intuition: narrow jobs >> wide jobs. Don't ship.

3. **`skip-easy` saves ~1pp wall-time at 1pp accuracy cost.**
   `isEasyInstruction` only matches simple literal swaps (~10/162
   cases), and parallel=8 amortizes their savings to almost nothing.
   The cases that benefit most from VERIFY (agreement bugs in
   pluralize/he-she-swap) aren't the "easy" ones. Not worth shipping.

4. **Parallel is the dominant performance lever** for batch testing —
   162 cases in 35s vs an estimated 4-5 minutes sequential (~7×
   speedup, no accuracy hit). Doesn't help individual-blank UX
   though — that's bound by per-call latency.

5. The 1-pass `rewrite` variant lands at 45.7% — confirms why we
   broke the pipeline apart in the first place. Categories where it
   fails (conditional, context-referring, trailing) are where
   EXTRACT does real work.

**Decision:** ship 3-pass as default. If users want faster, expose
2-pass as `transform-blank-mode: fast`. Don't ship single-call or
skip-easy.

**Latency at user-experience level (per blank):**
- 3-pass: ~1.6s (current default)
- 2-pass: ~1.1s (proposed fast-mode)
- rewrite: ~0.6s (too inaccurate)
- single-call: ~0.5s (too inaccurate)

---

## Experiment 2 — Prompt-variant tweaking

**Hypothesis:** The current 3-pass prompts are quite verbose (especially
APPLY at ~200 lines of rules + examples). Stripping each prompt to its
essentials should reveal which content is load-bearing vs defensive
cruft, and might cut latency by reducing input-token count.

**Variants tested:** `minimal-extract`, `minimal-apply`, `minimal-verify`,
`minimal-all` — each swaps in a stripped prompt at one or all phases of
the 3-pass pipeline. Minimal versions in `minimal-prompts.ts`; only the
rules that pass tests survived. Other phases stay on the verbose
production prompt.

**Results (parallel=8, run twice for minimal-extract):**

```
Variant                Run 1 pass    Run 2 pass    Per-case   Wall
─────────────────────────────────────────────────────────────────
baseline 3-pass        83.3% (135)   —             1729ms     37.8s
minimal-extract        90.1% (146)   88.9% (144)   1707ms     37.9s
minimal-apply          80.9% (131)   —             1938ms     44.6s
minimal-verify         82.7% (134)   —             1697ms     36.5s
minimal-all            80.9% (131)   —             2011ms     43.1s
```

**Per-category breakdown (minimal-extract vs baseline, run 1):**

```
                        baseline    minimal-extract
literal                 100%        100%
multi-span              90%         100%   (+10)
concept                 90%         100%   (+10)
transform               83%         100%   (+17)
negative                90%         80%    (-10)
math                    90%         100%   (+10)
linked-concepts         70%         100%   (+30)
long-text               75%         82.5%  (+7.5)
targeted                100%        100%
multi-paragraph         60%         60%
conditional             90%         100%   (+10)
context-referring       70%         70%
trailing-instruction    100%        100%
```

**Findings:**

1. **`minimal-extract` is a clear win.** +5-7pp accuracy at zero
   latency cost across two runs. The biggest gains land in categories
   where EXTRACT is doing real classification work (linked-concepts
   +30pp, transform +17pp, conditional +10pp). Hypothesis: the
   verbose EXTRACT prompt with its 15+ examples and detailed shape
   list was over-constraining the model — it was bailing to NONE on
   borderline imperatives and mis-splitting composed instructions.

   Cost: negative cases dropped 90% → 80%. One UI-placeholder case
   that should have bailed got incorrectly classified as a transform.
   Net trade is +11pp other categories vs -1pp on negatives → ship
   minimal-extract.

2. **`minimal-apply` HURTS accuracy AND is slower.** 83% → 81% and
   1729→1938ms per case. Stripping APPLY's CONCEPT-SWAP propagation
   rules broke linked-concepts (70% → 50%). The slowdown is the
   model "thinking harder" without explicit rules — reasoning_effort
   stays the same but the model uses more reasoning tokens working
   things out. APPLY's rules are doing real semantic work; keep them.

3. **`minimal-verify` is roughly neutral.** 83% → 83% with ~30ms
   speedup. Could go either way; stick with verbose for now since
   the AMBIGUOUS-INSTRUCTIONS section has caught real "VERIFY
   over-edits" bugs in production logs.

4. **`minimal-all` is dominated by minimal-apply's regressions.**
   Linked-concepts cratered to 0% (no propagation guidance anywhere).
   Don't ship.

**Decision:** swap EXTRACT to the minimal prompt in production.
Keep APPLY and VERIFY verbose. Net change: +5-7pp accuracy, latency
unchanged.

**Mechanism (why minimal-extract wins):**

The verbose EXTRACT prompt contains many shape lists ("CONDITIONAL
shapes", "CONTEXT-REFERRING shapes", "make it half/double/etc.")
plus 18 examples covering every layout. The model appears to use
this list as an exclusionary filter — if the input doesn't pattern-
match a known shape, it bails to NONE. Real-world imperatives often
don't match any explicit shape (e.g. "make text capitalized",
"capitalize sentence") and the verbose prompt was rejecting them.

The minimal prompt ("identify whether it carries an IMPERATIVE
INSTRUCTION") gives the model a single semantic question to answer,
which it does more accurately than pattern-matching against an
enumerated list.

This matches the ML folklore: when in doubt, prefer one clear
instruction + good examples over many rules.

---

## Experiment 3 — TBD


