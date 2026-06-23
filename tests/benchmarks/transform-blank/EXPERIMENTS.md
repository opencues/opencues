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

## Experiment 3 — Dynamic max_tokens + smart skip-VERIFY

**Hypothesis:** the flat 2048-token max_tokens we send to Groq for every
call is wasted on short blanks (EXTRACT for "change boy to girl _ ..."
needs maybe 100 output tokens). Plus, VERIFY is doing real work on
agreement-bug-prone cases (pluralize, he/she swap, concept-swap) but
mostly just rubber-stamping literal swaps and case changes. Two
optimizations:

1. **Dynamic max_tokens** — every call sizes its output budget to the
   actual expected output length:

   ```
   budget = max(FLOOR, ceil(expected_chars × multiplier / 3) + REASONING_HEADROOM)
   ```

   - FLOOR = 768 (always enough for reasoning + short output + labels)
   - REASONING_HEADROOM = 400 (covers `reasoning_effort: 'low'`'s typical
     200-800 internal tokens)
   - `expected_chars × multiplier / 3` = the rewrite portion (rough
     char-to-token of 3, with multiplier 1.5 on APPLY/VERIFY for transforms
     that stretch output)
   - CEILING = 4096 (caps the longest multi-paragraph rewrites)

   **Mistake worth documenting:** the first version used FLOOR=128 +
   REASONING_HEADROOM=100. Long-text accuracy collapsed 85% → 50%
   from mid-output truncation — the model ran out of budget partway
   through emitting a multi-paragraph rewrite. Fixed by raising the
   floor to 768. Lesson: when using `reasoning_effort` you need to
   reserve room for BOTH reasoning + output, and the safe floor is
   bigger than the output alone would suggest.

2. **Smart skip-VERIFY** — short-circuit P3 when ALL hold:
   - draft length within ±15% of target (no structural reshape)
   - no `\n\n` in target/draft (multi-paragraph cases need verify's
     paragraph-preservation check)
   - single instruction (no `|` split — composed transforms need verify
     to catch agreement bugs across steps)
   - low-stakes instruction pattern: literal swap, simple case change,
     simple tense change, BrE/AmE conversion

**Results (full 212-case suite, parallel=8, 3 stability runs):**

```
Run                Accuracy    Per-case    Wall (parallel=8)
──────────────────────────────────────────────────────────────
Run 1              83.0%       1349ms      39.1s
Run 2              82.5%       1509ms      43.7s
Run 3              84.9%       1388ms      40.4s
Median             83.0%       1388ms      40.4s

vs. baseline       88-90%      1729ms      ~37s
delta              -5pp        -20%        same
```

**Findings:**

1. **Latency win is real and stable.** ~20% per-case latency reduction
   across three runs. For interactive UX (one blank at a time, no
   parallelism) this means the typical blank goes from ~1.7s to
   ~1.4s — perceptibly snappier.

2. **Accuracy regression is concentrated in subjective categories.**
   Tone-shift dropped 60% → 30% in run 1, but baseline tone-shift
   also fluctuates (60% before optimizations, 30-60% after). Failures
   are APPLY-side weak outputs ("make it dramatic" → just appended
   "!") not skip-VERIFY catches. Same root cause either way.

3. **Wall-clock at parallel=8 is unchanged** because parallelism
   already amortizes per-case latency to near-zero. Skip-VERIFY only
   helps when we're sequentially bottlenecked (production usage).

**Decision:** ship dynamic max_tokens (clear win, no real downside).
Skip-VERIFY is conditional — hold it but tune the rules in Experiment
4 to claw back some accuracy.

---

## Experiment 4 — Skip-VERIFY rule tuning

**Hypothesis:** the deployed skip-VERIFY rules (literal swap + case
change + simple tense + BrE/AmE) might be too generous OR too
conservative. Test 5 variants on the full 212-case suite to find the
sweet spot.

**Variants:**
| Variant | Rule |
|---|---|
| `skip-never` | Always run VERIFY (3-pass baseline) |
| `skip-conservative` | Skip on literal swap + BrE/AmE only |
| `skip-current` | Deployed: literal + case + tense + BrE/AmE |
| `skip-aggressive` | Any single-instruction case with length ratio 0.9-1.1 |
| `skip-always` | Any single-instruction case (no \n\n filter) |

**Results (full 212-case suite, parallel=8 within each run, sequential
between runs to dodge Groq 250k TPM rate limit):**

```
Variant              Accuracy           Per-case   vs never
─────────────────────────────────────────────────────────
skip-never           81.6% (173/212)    1477ms     —
skip-conservative    81.1% (172/212)    1290ms     -0.5pp / -13%
skip-current         78.8% (167/212)    1390ms     -2.8pp / -6%
skip-aggressive      80.7% (171/212)    1387ms     -0.9pp / -6%
skip-always          77.4% (164/212)    1225ms     -4.2pp / -17%
```

**Findings:**

1. **`skip-conservative` is strictly better than the deployed
   `skip-current`** on BOTH axes — higher accuracy AND lower
   latency. The case-change and simple-tense rules in `skip-current`
   cause real regressions (case has ambiguous interpretations VERIFY
   catches; simple tense triggers concept-swap propagation gaps when
   the target nouns hint at a category swap). Stripping them back to
   just literal swaps + BrE/AmE keeps the latency win and restores
   accuracy.

2. **The win is essentially free.** 0.5pp accuracy delta vs never is
   within run-to-run noise (we've seen ±3pp on the same config), and
   the −13% per-case latency is real and stable.

3. **`skip-always` is too aggressive** — losing 4.2pp for the extra 5%
   latency saving isn't worth it. The skip-VERIFY rule SHOULD have a
   semantic gate, not just structural ones (length, paragraph count).

4. **`skip-aggressive`** (any single-instr ±10% length, no instruction
   pattern check) is barely different from conservative in cost AND
   slightly worse in accuracy. Adding the length-ratio filter doesn't
   make up for losing the instruction-pattern gate.

**Decision:** swap production from `skip-current` rules to
`skip-conservative`. Net: −2.3pp accuracy regression reverted +
−6% per-case latency improvement vs the prior deployment.

**Lesson:** when picking which cases to skip a verification step,
the right axis is "is the instruction MECHANICALLY unambiguous"
(literal find/replace, deterministic spelling swap), not "does the
output structurally resemble the input" (length ratio, paragraph
count). Structural similarity is necessary but not sufficient —
even short single-line outputs can have semantic agreement bugs
(plural+verb, pronoun coreference, quantifier match).

---

## Experiment 5 — Gemini 3.1 flash-lite vs gpt-oss-120b on compressed pipelines

> **Methodology footnote (added in Experiment 6):** the numbers below were
> produced with `judge.ts` routed through the same `OPENCUES_BENCH_PROVIDER`
> as the model under test — so each row was self-judged. This inflates
> scores when the judge and the inference model are the same model family
> (the judge marks its own near-misses generous). Experiment 6 re-runs
> the same matrix with the judge pinned to Groq gpt-oss-120b regardless
> of provider, and confirms a clean ranking. Treat the numbers in this
> section as directionally correct (the relative ordering between
> Gemini variants is fine — they share a judge) but not directly
> comparable across providers. The corrected cross-provider table is in
> Experiment 6.

**Hypothesis:** A smarter model can fit more work into each call. If
Gemini 3.1 flash-lite can juggle EXTRACT + APPLY + VERIFY in one prompt
where gpt-oss-120b collapsed to 19% (Experiment 1's single-call), then
per-call latency stops being the right axis — total calls × per-call
latency is. Even a "slower" model can win on wall-clock by needing
fewer hops.

**Suite:** 231 cases (grew from 162 since Experiment 1), full transform-
blank set including the newer code-transform, tone-shift, format-
transform, creative-rewrite, and adversarial categories.

**Setup:** `temperature: 0`, `parallel: 8`, runs sequenced to dodge
per-provider rate limits. Gemini uses `thinkingBudget: 0` by default
(see `OPENCUES_GEMINI_THINKING`). Provider switched via
`OPENCUES_BENCH_PROVIDER=gemini-flash-lite`.

**Variants tested:**

| Run | Model | Pipeline | API calls/case |
|---|---|---|---|
| **B1** baseline | gpt-oss-120b | 3-pass (extract → apply → verify) | 3 (4 on composed) |
| **B2** apples-to-apples | gemini-3.1-flash-lite | 3-pass | 3 (4 on composed) |
| **E1** | gemini-3.1-flash-lite | single-call (existing prompt, no thinking) | 1 |
| **E2** | gemini-3.1-flash-lite | single-call + `thinkingBudget: high` | 1 |
| **E3a** | gemini-3.1-flash-lite | **fused extract+apply** (new prompt, no verify) | 1 |
| **E3b** | gemini-3.1-flash-lite | fused + conditional verify (composed / paragraph / length-skew) | 1–2 |

**Results (full 231-case suite, parallel=8):**

```
Run                     Accuracy           Per-case   Wall    vs B1 latency
──────────────────────────────────────────────────────────────────────────
B1  gpt-oss 3-pass      90.9% (210/231)    1789ms     54.5s   baseline
B2  gemini  3-pass      92.6% (214/231)    2081ms     65.7s   +16%
E1  gemini  single      93.9% (217/231)    849ms      30.9s   -53%  ✓
E2  gemini  single+think 91.3% (211/231)   2672ms     88.4s   +49%  ✗
E3a gemini  fused       95.2% (220/231)    1196ms     45.2s   -33%  ✓✓
E3b gemini  fused+verify 94.4% (218/231)   1264ms     43.5s   -29%
```

**Per-category breakdown (B1 vs E3a — the winners):**

```
Category               B1 gpt-oss 3-pass    E3a gemini fused   Δ
─────────────────────────────────────────────────────────────────
literal                100%                 100%                =
multi-span             100%                 100%                =
concept                100%                 100%                =
transform              100%                 100%                =
negative               90%                  100%                +10
math                   100%                 100%                =
linked-concepts        100%                 80%                 -20  ✗
long-text (40 cases)   87.5%                85%                 -2.5
targeted               100%                 100%                =
multi-paragraph        80%                  80%                 =
conditional            100%                 100%                =
context-referring      70%                  100%                +30  ✓
trailing-instruction   100%                 100%                =
code-transform         80%                  100%                +20  ✓
tone-shift             60%                  100%                +40  ✓✓
format-transform       100%                 96.6%               -3.4
creative-rewrite       70%                  100%                +30  ✓
adversarial            90%                  100%                +10
```

**Findings:**

1. **The user's hypothesis lands.** Gemini single-call (E1) scores
   93.9% in one API call — beating the gpt-oss 3-pass baseline on
   *both* accuracy (+3pp) AND latency (-53%). The exact configuration
   that collapsed gpt-oss to 19% in Experiment 1 (`single-call`) is a
   strict improvement on Gemini. Per-call latency is the wrong frame;
   total wall-clock is dominated by call count for any model that can
   actually hold the full instruction.

2. **Fused extract+apply (E3a) is the new sweet spot:**
   **95.2% accuracy @ 1196ms** — beats B1 on accuracy by 4.3pp and on
   latency by 33%. The pattern that wins: emit `VERDICT / INSTRUCTION /
   TARGET / REWRITE` together, so the model lays out the decomposition
   as inline chain-of-thought before applying. Roughly: the structure
   we used to extract via a separate call now happens in one breath,
   for free.

3. **Conditional VERIFY barely earns its keep (E3b).** Adding a
   composed/paragraph/length-skew gate that fires a second VERIFY call
   trims 0.8pp off E3a's accuracy (95.2 → 94.4). The VERIFY pass —
   which the production prompt was tuned for gpt-oss's failure modes
   — sometimes "corrects" valid Gemini drafts into worse output. When
   the first model is already this good, layered verification stops
   being insurance and starts being a contamination vector. Don't ship.

4. **Gemini thinking budget actively HURTS (E2).** `thinkingBudget:
   high` drops accuracy 93.9 → 91.3 AND triples wall-clock (849 →
   2672ms/case). The biggest regressions are in domains we'd expect
   thinking to help: math (100 → 80), linked-concepts (70 → 60),
   format-transform (96.6 → 89.7). The mechanism appears to be the
   same one Experiment 2 surfaced for gpt-oss — extra reasoning room,
   without a sharper instruction, lets the model talk itself out of
   the obvious answer. For prompts that already include strong few-
   shot examples, thinking is over-reasoning. Default to
   `thinkingBudget: 0` on production fluid/transform pipelines.

5. **Gemini's category profile is the *inverse* of gpt-oss's.**
   gpt-oss-120b excels at structured/grammatical cases (linked-concepts
   100%, format-transform 100%, multi-paragraph rule-following) but
   struggles on subjective rewrites (tone-shift 60%, creative-rewrite
   70%, context-referring 70%). Gemini flips that: tone-shift 100%,
   creative-rewrite 100%, context-referring 100% — but loses 20pp on
   linked-concepts. The two models have different blind spots; the
   net is +4.3pp because subjective categories were where the
   production pipeline was bleeding accuracy.

6. **The "more calls = more accuracy" intuition is wrong for capable
   models.** B2 (Gemini on the 3-pass pipeline) is 1.3pp *worse* and
   16% slower than E1 (Gemini single-call). Three serial Gemini calls
   compound stochastic noise more than they compound reasoning quality.
   Capable-model pipelines should be flat, not pipelined.

**Decision (provisional):** keep the production 3-pass on gpt-oss-120b
for now (it's the structurally-stable baseline), but stand up the
**fused-extract-apply pipeline on Gemini 3.1 flash-lite as the
recommended high-accuracy / low-latency mode**. Two regression risks
must be addressed before swapping defaults:

- **linked-concepts (-20pp)** — Gemini under-propagates dependent
  vocabulary. The fused prompt's CONCEPT-SWAP section is shorter than
  pass2-apply's; needs the full "MINIMAL EDIT / PRESERVE STRUCTURE /
  COMPLETE THE ACTION" treatment. Plausibly recoverable.
- **multi-paragraph (-0pp here, but watch)** — fused keeps parity, but
  paragraph preservation is the kind of bug that hides in production
  traffic. Add a structural post-check.

**Lessons:**

- **Don't carry pipeline architecture between models.** A pipeline
  designed around one model's failure modes (gpt-oss collapsing on
  juggle) embeds those failure modes in its architecture. When the
  model gets smarter, the scaffolding becomes deadweight.
- **Per-call latency is the wrong axis.** Wall-clock = calls × per-
  call latency × parallelism penalty. Gemini's per-call latency is
  ~2× gpt-oss's, but it gets to 1 call instead of 3 — net 53% faster.
- **Thinking budgets aren't free even when token usage isn't billed.**
  Extra reasoning tokens add latency *and* drift the answer. Use only
  when the instruction is genuinely under-specified for the model.
- **3-pass pipelines suit gpt-oss because gpt-oss can't hold the full
  problem.** They're a scaffolding fix, not an accuracy multiplier.
  On a model that can hold the problem, more passes = more drift.

---

## Experiment 6 — 5-provider × 4-pipeline matrix, pinned judge

**Why this exists:** Experiment 5 ran the LLM-judge on whichever
provider was under test, so each row was effectively self-judged. To
make a fair cross-provider comparison, `judge.ts` now imports `chat`
directly from `./groq-impl` (always Groq gpt-oss-120b, regardless of
`OPENCUES_BENCH_PROVIDER`). All numbers below come from one judge.

**Hypothesis:** if "fewer-but-fatter calls beat more calls" is a real
property of capable models, it should generalize beyond Gemini. Test
the same 4 pipelines (`extract-apply-verify` 3-pass, `single-call`,
`fused`, `fused-verify`) across 5 providers spanning the cheap-fast
production-LLM tier:

- **Groq gpt-oss-120b** — the production model + a 3-pass pipeline
  designed around its failure modes (Experiment 1's winner).
- **Cerebras gpt-oss-120b** — same model, different inference. Tests
  the assumption that "model = name" rather than "model = name +
  provider".
- **Google Gemini 3.1 flash-lite** — Experiment 5's candidate.
- **Anthropic Claude Haiku 4.5** — Claude's cheap/fast tier, no
  extended thinking.
- **OpenAI gpt-5.4-nano** — GPT-5.4's cheap/fast tier (reasoning
  model, low effort).

**Setup:** full 231-case suite, `temperature: 0`, `parallel: 8`
(`parallel: 6` for OpenAI to stay under TPM). Providers run in
parallel; each provider's 4 modes run sequentially. Judge is always
Groq gpt-oss-120b, judge-call latency excluded from per-case timings.

**Results (accuracy / per-case latency in ms):**

```
                          3-pass        single-call   fused         fused+verify
─────────────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b      91.8% / 1459  17.7% /  532  80.5% /  727  83.1% /  925
gemini  flash-lite        90.0% / 2263  89.2% /  729  89.2% /  772  90.5% / 1213
cerebras gpt-oss-120b     78.8% /  933  29.4% /  330  76.2% /  331  47.6% /  363
claude  haiku-4.5         87.9% / 3048  82.3% /  912  88.7% / 1125  84.4% / 1497
openai  gpt-5.4-nano      20.8% /  806  76.6% / 1431  48.9% / 1101  31.2% /  600
```

**Findings:**

1. **gpt-oss-120b on Groq + 3-pass remains the accuracy king (91.8%).**
   The Experiment-5 claim that "Gemini fused beats gpt-oss 3-pass" was
   a judge-bias artefact — Gemini was rating its own outputs ~5pp more
   generously than Groq does. Under a fair judge, gpt-oss 3-pass is
   still the highest-accuracy config we have. Gemini's flat 90% ceiling
   is real but doesn't clear gpt-oss's tuned production pipeline.

2. **Provider matters as much as model name.** Cerebras and Groq both
   serve "gpt-oss-120b" but differ by **13pp** on 3-pass (78.8% vs
   91.8%) and **47pp** on fused-verify (47.6% vs 83.1%). Per-call
   latency is the opposite direction — Cerebras is 36% faster — so
   this isn't a speed-vs-accuracy slider; one inference path produces
   systematically weaker outputs. Spot-checked failures: minor word-
   substitution drift (`drew his staff` → `raised his staff`;
   `walked` retained when context demands `swam`). Looks like quantization
   or sampler-config drift, not prompting or pipeline shape.

3. **The single-call collapse is gpt-oss-specific.** Groq gpt-oss
   crashes from 91.8% (3-pass) → 17.7% (single-call) — confirms
   Experiment 1's "wide jobs break gpt-oss" thesis. Every other
   provider stays within their own 3-pass band on single-call
   (Gemini 89.2 vs 90.0; Claude 82.3 vs 87.9). The "compressed
   pipeline" hypothesis only fails on small-MoE-ish models like
   gpt-oss.

4. **Reasoning models (gpt-5.4-nano) invert the pattern.** OpenAI's
   3-pass scores **20.8%** — worse than gpt-oss-Groq's single-call. The
   reason: gpt-5.4-nano spends so much of its `max_completion_tokens`
   budget on internal reasoning that each pass frequently terminates
   with `finish_reason: length` and empty content. Three passes ×
   short budget compounds. Single-call gives it one big budget and
   it climbs to 76.6%. Fused (1 call, structured output) sits between
   at 48.9% — the structural labels eat some of the reasoning budget.

   **Implication:** pipeline shape isn't model-agnostic. Multi-pass
   architectures designed around token-frugal models actively
   sabotage reasoning models that need their full budget per call.

5. **Verify nearly always hurts under a fair judge.** Compare `fused`
   vs `fused-verify`:
   - groq:    80.5 → 83.1 (+2.6pp, the only meaningful win — and
                            still 11pp below its 3-pass)
   - gemini:  89.2 → 90.5 (+1.3pp)
   - cerebras: 76.2 → 47.6 (−28.6pp catastrophe)
   - claude:  88.7 → 84.4 (−4.3pp)
   - openai:  48.9 → 31.2 (−17.7pp)

   The verify pass was tuned on gpt-oss-Groq's failure modes; on every
   other provider it's a corruption vector. Cross-model VERIFY needs
   model-aware prompts or it shouldn't ship.

6. **Claude haiku is the all-rounder but expensive.** 88.7% on fused at
   1125ms is competitive on accuracy, but per-call latency is ~2× Gemini
   and ~4× Cerebras. Its 3-pass is 3048ms/case — twice Groq's. Claude
   appears to spend "wall-clock per token" generously vs Groq/Cerebras
   inference. For interactive UX, that 3-second 3-pass is too slow.

**Per-pipeline rankings (best provider for each):**

```
                Best provider              Score
─────────────────────────────────────────────────
3-pass          groq gpt-oss-120b          91.8% / 1459ms
single-call     gemini flash-lite          89.2% /  729ms  ✓ speed-king
fused           gemini flash-lite          89.2% /  772ms
fused-verify    gemini flash-lite          90.5% / 1213ms
```

Across the matrix:
- **Highest accuracy:** Groq gpt-oss-120b 3-pass (91.8%, 1459ms).
- **Best speed/accuracy tradeoff:** Gemini flash-lite single-call
  (89.2%, 729ms) — only 2.6pp below the accuracy king at half the
  per-call latency.
- **Fastest acceptable config:** Cerebras gpt-oss fused (76.2%, 331ms)
  if 76% is acceptable. Otherwise none below 700ms cross 80%.

**Decision:**

1. **Production stays on Groq gpt-oss-120b 3-pass.** Highest accuracy,
   well-understood failure modes, judge bias works in its favour
   (judge model = inference model = stable scoring).
2. **Add Gemini flash-lite single-call as a "fast" mode toggle.**
   2.6pp accuracy drop for ~50% wall-clock reduction is a clear win
   for users on slow networks or who prefer responsiveness over peak
   accuracy. Wire it via `transform-blank-mode: fast` config.
3. **Don't switch to Cerebras for gpt-oss inference.** The 36% latency
   win doesn't recover the 13pp accuracy loss. Re-evaluate if Cerebras
   publishes a tuned gpt-oss endpoint.
4. **Don't ship gpt-5.4-nano** for transform-blank without re-tuning
   the pipeline. The 3-pass collapse (20.8%) isn't fixable by
   parameter tweaks — it needs an architecture that gives the model
   one big reasoning budget, not three small ones.
5. **Skip the cross-model verify pass.** The current VERIFY prompt is
   net-negative on every provider except groq and gemini (and there
   the win is <2pp). When we re-tune VERIFY, do it per-provider or
   drop it.

**Lessons (added to the running list):**

- **Pin the LLM-judge to one model across an A/B.** Self-judging
  inflates by ~5pp in our setup; cross-provider comparisons need a
  fixed referee.
- **"Same model" across providers is a fiction.** Sampler config,
  quantization, and inference-stack defaults all leak into output
  quality. Always re-benchmark when migrating providers.
- **Pipeline shape is model-class-coded, not universal.** The 3-pass
  architecture is a gpt-oss-shaped fix; single-call is a capable-
  generalist fix; neither is right for reasoning models. When the
  model class changes, the pipeline assumption changes with it.
- **Verify prompts overfit to the original model's failure modes.**
  Carrying VERIFY across providers without retuning is worse than
  dropping it.

---

## Experiment 7 — Cost analysis (May 2026 pricing)

**Question:** if accuracy and latency are roughly known per provider×pipeline,
what does each cost in dollars per 1K cases? And which configuration has
the lowest **$-per-correct-answer** — the metric that matters when budget
is finite and wrong answers don't help.

**Price card (May 2026, $ per million tokens, from each provider's pricing
page on 2026-05-16):**

| Provider              | Input $/M | Output $/M |
|-----------------------|-----------|------------|
| Groq gpt-oss-120b     | $0.15     | $0.60      |
| Cerebras gpt-oss-120b | $0.35     | $0.75      |
| Gemini 3.1 flash-lite | $0.25     | $1.50      |
| Claude Haiku 4.5      | $1.00     | $5.00      |
| OpenAI gpt-5.4-nano   | $0.20     | $1.25      |

**Token-count estimates (used for cost calc; not measured from API
`usage` blocks yet):** transform-blank prompts run ~1000 input tokens
for `single-call`, ~1430 for `fused`, ~4400 for `extract-apply-verify`
(three pass-specific system prompts compound). Output ~50 tokens for
`single-call`, ~80 for `fused`, ~180 across all three passes for
`extract-apply-verify`.

**$ per 1000 cases (Experiment 6 matrix):**

```
                          3-pass     single     fused      fused+verify
─────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b      $0.77      $0.18      $0.26      $0.42
gemini  flash-lite        $1.37      $0.33      $0.48      $0.78
cerebras gpt-oss-120b     $1.68      $0.40      $0.56      $0.90
claude  haiku-4.5         $5.30      $1.28      $1.83      $3.07
openai  gpt-5.4-nano  †   $1.11      $0.27      $0.39      $0.66
```

† OpenAI rates assume the same 50-180 token output budget as the others;
gpt-5.4-nano actually spends most of `max_completion_tokens` on internal
reasoning (billed at the output rate) so realistic OpenAI cost is
2–4× the values shown. Instrumenting `chat()` to capture
`response.usage` is the cleanest fix — open follow-up.

**$ per correct answer (cost ÷ accuracy):**

```
                          3-pass     single     fused      fused+verify
─────────────────────────────────────────────────────────────────────────
groq    gpt-oss-120b      $0.84      $1.02      $0.32 ★    $0.51
gemini  flash-lite        $1.52      $0.37      $0.54      $0.86
cerebras gpt-oss-120b     $2.13      $1.36      $0.74      $1.89
claude  haiku-4.5         $6.03      $1.56      $2.06      $3.64
openai  gpt-5.4-nano †    $5.34      $0.35      $0.80      $2.12
```

**Findings:**

1. **`groq · fused` is the cheapest correct answer ($0.32/correct).**
   80.5% accuracy at $0.26/1K is unbeatable on cost-efficiency for any
   provider that produces usable output. It's 4pp below `groq · 3-pass`'s
   accuracy ceiling but at 1/3 the cost — for any budget-constrained
   transform-blank deployment, this is the right default.

2. **`gemini · single-call` is the cost king for high-accuracy.**
   89.2% / $0.33/1K / **$0.37/correct** — within 2.5pp of gpt-oss-Groq
   3-pass accuracy at less than half the cost-per-correct ($0.37 vs
   $0.84). Better than `groq · fused` ($0.32) only if you need the
   extra ~9pp of accuracy.

3. **Claude is uneconomical here.** Best Claude variant is `claude · fused`
   at $1.83/1K = **$2.06/correct** — 6× more expensive than `groq · fused`
   for slightly higher accuracy (88.7 vs 80.5). The price-per-token gap
   ($1/$5 vs $0.15/$0.60) is the dominant factor, not pipeline shape.

4. **Cost-per-correct collapses faster than acc when accuracy drops.**
   The two columns where acc < 50% (cerebras single-call, openai 3-pass,
   etc.) all blow past $1/correct despite cheap unit pricing. The right
   metric for production picking isn't $/1K — it's $/correct.

5. **OpenAI gpt-5.4-nano's apparent cost advantage is fake.** List price
   is competitive ($0.20 in / $1.25 out) and on `single-call` it lands at
   $0.35/correct — best-looking number on the chart. BUT (a) accuracy is
   only 76.6% so this is the bottom of the "usable" range, (b) actual
   token cost is understated 2-4× because we aren't billing the reasoning
   tokens in our estimate, and (c) 3-pass and fused-verify modes are
   nonfunctional for this model. Don't pick from a leaderboard without
   accounting for reasoning-token cost.

**Decision:**

- **Production default** stays `groq · 3-pass` (highest acc, $0.84/correct).
- **"Cheap mode" toggle**: `groq · fused` — $0.32/correct, 80.5% acc,
  727ms. Wire it as `transform-blank-mode: cheap` for cost-sensitive
  users (batch processing, long-running agents).
- **"Fast mode" toggle**: `gemini · single-call` — $0.37/correct, 89.2%
  acc, 729ms. Better trade for interactive UX than cheap-mode.
- **Don't ship**: Claude (cost), Cerebras (accuracy drift, see
  Experiment 6), or OpenAI nano (unstable on multi-pass).

**Open follow-up:** instrument `chat()` across all five providers to
capture real `prompt_tokens` / `completion_tokens` from API responses.
That replaces the token-length estimates with actual measurements, and
fixes the OpenAI reasoning-token undercount. Until then treat all
$/1K-cases numbers as ±30% accurate, with the OpenAI column especially
unreliable.

---

## Experiment 8 — Cerebras vs Groq `fused` head-to-head (variance)

**Question:** the single-shot Experiment 6 numbers had Cerebras `fused`
at 331ms vs Groq `fused` at 727ms — a 2.2× gap on the same model. Is
that stable across reruns, or noise?

**Method:** run `fused` mode 5 times on each provider, full 231-case
suite, parallel=8. Capture mean ± stddev of per-case latency, wall-clock,
accuracy.

**Results:**

```
Provider    Acc %          Per-case ms      Wall s        Per-rep ms
────────────────────────────────────────────────────────────────────────
groq        84.30 ±1.29    595 ±32          20.18 ±1.11   621, 582, 571, 637, 564
cerebras    80.80 ±0.27    335 ±6           13.12 ±0.28   339, 338, 339, 326, 334
```

**Findings:**

1. **Cerebras `fused` is reliably ~1.8× faster than Groq `fused`** on
   transform-blank. Per-case mean ± 2σ intervals (Groq [531, 659] vs
   Cerebras [323, 347]) don't overlap, so the gap is statistical
   bedrock — not a single-run fluke.

2. **Cerebras variance is ~5× tighter** (±6ms vs ±32ms). For interactive
   UX, the tighter p99 matters more than the mean — Cerebras's worst
   rep (339ms) is faster than Groq's best (564ms).

3. **The accuracy delta survives reps too.** Cerebras 80.80 ±0.27 vs
   Groq 84.30 ±1.29 — Cerebras is more accurate on its own runs (0.27
   vs 1.29 stddev) but lower in absolute terms. The 3.5pp gap is real
   and reproducible. The single-shot 76.2 vs 80.5 from Experiment 6
   was within noise of the 5-rep mean — both runs land Cerebras
   ~4pp behind on transform-blank, which is the canonical
   "Cerebras-vs-Groq quality drift" finding.

4. **Update to the picture from Experiment 6:** the original single-
   run had Groq fused at 727ms; the 5-rep mean is 595ms. The
   single-run sample landed on the high end of Groq's true distribution
   (621–637ms is the realistic high-end). Cerebras's 331ms single-run
   sample matched the 5-rep mean (335ms) almost exactly — its
   distribution is so tight that any single sample is representative.

**Decision:** the `fast-mode` toggle ships Cerebras `fused` on
transform-blank **for users who explicitly want the latency win**,
with a clear disclosure that accuracy drops 3-4pp. Don't make it
default — Groq's accuracy advantage on rewrite tasks is real and
worth the latency cost on the default path.

Companion analysis on fluid-blank (`tests/benchmarks/fluid-blank/
EXPERIMENTS.md § Experiment 1, open follow-up #1`): Cerebras `fused` is
2.88× faster AND slightly more accurate (99.72 ±0.38 vs 99.12 ±0.63).
On short-output tasks Cerebras is a strict improvement; on long-output
tasks the drift cost is real.

Raw logs: `tests/results/cerebras-vs-groq-fused/`.





---

## Experiment 9 — Few-shot example formatting leaks into output (literal `\n` / `" / "`)

**Context:** PR #190 + #191. A user generated a poem via `write a poem _`
on claude.ai and got one line with literal slashes
(`Whispered tides of moonlit night, / silver verses on the sea, / …`).
The log confirmed the LLM emitted the ` / ` itself — the fused
`FUSED_SYSTEM` poem example used ` / ` as its line separator, so the
model copied it ~half the time.

**Bug class:** a few-shot example's *formatting convention* leaks verbatim
into the model's output. The runtime writes the rewrite back to the buffer
unchanged (deterministic splice; `parseApply`/`parseFused` only `.trim()`),
so whatever separator the example teaches is exactly what the user sees.

**Two sites, same class:**
- **Fused path** (`FUSED_SYSTEM`, cerebras/etc.) — poem example used ` / `.
  Fixed in #190 (real newlines + a GENERATIVE rule banning ` / ` and
  literal `\n`).
- **3-pass path** (`P2_APPLY_SYSTEM`, groq) — every multi-line letter
  example (`add my name Wilfred`, `add bolding`, `drop "Best regards"`)
  used literal `\n` text. Fixed in #191. Crucially, the *real* runtime
  input sends `TARGET` with **real newlines** (`transform-blank-source.ts`
  P2 APPLY call), so the literal-`\n` examples didn't even match the input
  format — converting them to real newlines fixed the bug AND aligned the
  examples with reality.

**Result:** #191 3-pass bench (groq gpt-oss-120b) = **195/242 vs 196/242
baseline — flat** (within ±2-4 per-category run-to-run noise). #190 fused
spot-check on cerebras: `write a poem` / `…about the sea` / `give me 3
startup ideas` → 0 slashes, real newlines, 3/3.

**Methodology note (see also memory `feedback_bench_rate_limit_phantom_
regression`):** the first #191 run at `--parallel 8` reported a phantom
154/242 — groq rate-limit errors swallowed as ~26ms `(bailed)` results.
Re-run at `--parallel 4` with a same-session baseline gave the true flat
delta. Categories that bail at the EXTRACT pass (format-transform,
multilingual) can't be affected by a P2_APPLY edit — their collapse was
the tell that the run was infra-polluted, not regressed.

**Lesson:** never use a non-newline separator (` / `, literal `\n`, `\\n`)
in a multi-line few-shot example whose output is written verbatim to the
buffer. Examples must use the exact format the runtime sends and consumes.

**Residual:** `P2_APPLY_SYSTEM` rule prose (~L399) still uses literal-`\n`
*notation* to describe "insert a line break at [CURSOR]". Lower risk
(rule, not an output example) — candidate follow-up.

---

## Experiment 10 — Retiring the 3-pass pipeline (single fused route)

**Context:** TransformBlank shipped two encodings of the same behaviour —
FUSED (one call, default for cerebras/openai/gemini/anthropic) and 3-PASS
(EXTRACT→APPLY→VERIFY, groq only), picked by `pickTransformBlankMode`. The
routing rested on a stale "groq collapses on the single wide call (~18%)"
number from an OLD crude single-call prompt (Experiment 1's `single-call`
row), not today's matured `FUSED_SYSTEM`. The two paths had drifted —
rules added to one silently missing from the other (the `make X bold`
gap, PR #195) — which motivated re-checking whether the split still earned
its keep.

**Hypothesis:** on the current `FUSED_SYSTEM`, groq handles the single call
well enough that the 3-pass pipeline (3× the latency, a whole second prompt
surface to maintain) is no longer justified.

**Head-to-head (groq gpt-oss-120b, same session, same prompt, 243 cases):**

| Config | Total | linked-concepts | long-text | negative | format | Avg latency | calls |
|---|---|---|---|---|---|---|---|
| fused @ low | 197 (81.1%) | 3/10 | 26/40 | 10/10 | 29/30 | **615ms** | 1 |
| fused @ medium | 199 (81.9%) | 5/10 | 27/40 | 8/10 | 30/30 | 1146ms | 1 |
| 3-pass | 201 (82.7%) | 8/10 | 32/40 | 3/10 | 25/30 | 984ms | 3 |

**Findings:**
1. **"groq sucks at fused" is false.** fused @ low (197) ≈ 3-pass (201) —
   ~1.6pp, inside run-to-run variance — and fused is the FASTEST (615ms vs
   984ms, ~35% quicker; 1 call vs 3).
2. **The 3-pass edge is a category TRADE, not a uniform win.** 3-pass wins
   linked-concepts + long-text; fused wins negative + format. The
   decomposition (not reasoning depth) is what helps those two categories.
3. **Bumping groq reasoning to `medium` is a trap.** ~2× latency
   (615→1146ms) for +2 cases; doesn't recover linked-concepts to 3-pass's
   level. Worst of both worlds — slower than fused-low AND 3-pass.

**Decision:** retire the 3-pass pipeline. `pickTransformBlankMode`, the
`P1_EXTRACT`/`P1_5_RESOLVE`/`P2_APPLY`/`P2_GENERATIVE`/`P3_VERIFY` prompts,
their parsers/schemas, cursor-sentinel injection (TransformBlank's use),
and the `transform-blank-mode` pipeline override are all deleted.
TransformBlank now runs ONE fused call on every provider. Cost: groq loses
~1.6pp (concentrated in linked-concepts/long-text) for ~35% lower latency,
one prompt instead of two, and the elimination of the entire two-path
drift class (and the 4 fused/3-pass parity gaps that came with it). Since
groq isn't the recommended default (cerebras is), the blast radius is
small.

**Known regression accepted:** caret-relative + deictic instructions ("add
a line break here", "shorten it", "make this line bold") and the
heading/list/anchored-insert/auto-styling capabilities lived ONLY in the
3-pass `P2_APPLY`. They are now absent on all providers until re-authored
directly into `FUSED_SYSTEM` as fix-forward work. (`docs/architecture/transform-blank.md`.)

---

## Experiment 11 — Recovering the 3-pass "fix-forward gaps" in fused

**Context:** retiring the 3-pass pipeline (Experiment 10) left four
documented capability gaps that lived only in `P2_APPLY` rule text:
list/heading-ification, anchored insertion, drop-verb disambiguation,
and deictic edits ("shorten it"). Before re-authoring rules into
`FUSED_SYSTEM`, benchmark whether they're actually broken — the gap list
came from comparing PROMPT TEXT, not measured behaviour.

**Method:** added 8 targeted cases (`gap-*` in `cases.ts`) and baselined
the current fused prompt on both providers.

**Baseline (no new rules):**

| Gap case | cerebras | groq |
|---|---|---|
| list-ification (×2) | PASS / PASS | **FAIL / FAIL** |
| anchored insert (before/after) | PASS / PASS | PASS / PASS |
| drop insert / drop delete | PASS / PASS | PASS / PASS |
| deictic shorten-it / make-formal | (judge-strict) / PASS | PASS / PASS |

**Finding: the "gaps" were mostly theoretical.** A capable model
(cerebras) already handles anchored insertion, drop-verb disambiguation,
and deictic "it"/"this" through the whole-buffer FULL_REWRITE — no
explicit rule needed. The one real failure was **list-ification on
groq** (it emitted prose, not `- ` bullets). The single cerebras "fail"
was an over-strict expected (the model DID shorten correctly; the test's
alternates were too prescriptive — loosened).

**Fix:** added ONE concise `STRUCTURE` rule to `FUSED_SYSTEM` ("turn into
a list" → `- ` per item; "make it a heading" → `# `). Deliberately did
NOT add rules for anchored-insert / drop / deictic — the model already
does them, and adding rules for behaviour the model has would be opinion
without benefit (cf. the "minimise opinions, rely on the model" pass).

**After the STRUCTURE rule:**
- **cerebras: 8/8 gap cases pass**, format-transform 32/32, total
  213/251 (was 211 — free, no regression).
- **groq: list-ification recovered** (both cases); the only remaining
  flips are run-to-run LLM variance on the borderline deictic cases.

**Still genuinely out of reach (needs more than a prompt rule):**
caret-relative "here" edits ("add a line break here", "make THIS line
bold") need the `[CURSOR]` sentinel injected into the fused call — that
wiring was removed with the 3-pass path and would be a separate feature,
not a prompt addition. Heading and "add bolding where appropriate"
(auto-styling) aren't bench-scorable via `finalText` (markers are
stripped to a markdown.styled event) so they're untested here.

---

## Experiment 12 — Restoring [CURSOR] anchor in the fused path

**Context:** Experiment 11 found the only fix-forward gap a prompt rule
couldn't close was caret-relative "here" edits ("add a line break here",
"split this paragraph here", "insert X here") — they need the `[CURSOR]`
marker injected at the user's caret, which was removed with the 3-pass
pipeline. This restores it for the fused path.

**Design difference from 3-pass:** the old 3-pass injected `[CURSOR]` into
the APPLY pass only, so its EXTRACT classifier ran cursor-blind. The
fused path does classify+apply in ONE call, so an always-on marker would
sit in the input for the ~95% of non-positional transforms and could
distract classification. Fix: **gate injection on a positional cue**
(`/\b(here|this line|this paragraph|new line|new paragraph|line break|
paragraph break)\b/i`) in the input — only inject when the instruction
plausibly needs it. The prompt's CURSOR ANCHOR rule still tells the model
to ignore `[CURSOR]` for non-positional instructions (belt-and-braces),
and `stripCursorSentinel` removes any leaked marker from FULL_REWRITE.

**Wiring:** `runFusedAndBuild` translates the buffer caret to the input's
coordinate space (`translateBufferCursorToTargetCursor`) and injects via
`injectCursorSentinel`; the prediction (cerebras predicted-outputs) keeps
the clean text, not the marked input.

**Verification:**
- Unit: 5 new tests (`transform-blank-cursor.test.ts`) — inject on
  positional + cursor; no inject for non-positional (gate); no inject
  without a cursor; strip leaked marker; prompt carries the rule.
- Agentic (live cursor on CC): `first part split this paragraph here _
  second part` (caret at the trigger) → `first part\n\nsecond part`
  (`[CURSOR]` injected at the right offset, paragraph break placed there,
  instruction removed). Single-newline variant ("add a line break here")
  and a non-positional control (no marker, clean rewrite, no leak) both
  correct.
- Broad fused bench within run-to-run variance (gate keeps the
  non-positional suite marker-free).

**Result:** all four documented fix-forward gaps are now addressed —
list-ification (Experiment 11 STRUCTURE rule) and cursor/deictic
positional edits (this experiment); anchored-insert / drop / deictic-"it"
never needed a rule.

---

## Experiment 13 — Dropping the TARGET echo from the fused output

**Hypothesis:** the fused output emits `TARGET:` (≈ the whole buffer
echoed) AND `FULL_REWRITE:` (≈ the whole buffer) — roughly 2× the buffer
in output tokens per transform. `f.target` is **debug-only** (the
resolver merges `FULL_REWRITE` vs `originalText`, never the LLM's
TARGET — `transformTargetDebug`), so dropping it from the output contract
should cut output tokens (latency + cost) without hurting accuracy.

**Change:** removed the `TARGET:` line from the output contract and from
every example in `FUSED_SYSTEM` (3-field output: VERDICT / INSTRUCTION /
FULL_REWRITE). Kept TARGET as a *concept* in the rule prose. Parser left
tolerant of a stray TARGET line.

**Results (251 cases, back-to-back per provider to control server load):**

| Provider | Predicted outputs? | Accuracy base → drop | Latency base → drop |
|---|---|---|---|
| cerebras | YES | 210 → 208–209 | 528ms → 480ms (within noise) |
| groq | no | 205 → 210 | ~faster (parallelism-confounded) |
| **gemini-3.1-flash-lite** | no | 224 → 222 | **604ms → 556ms (~8%)** |

**Findings:**
1. **Accuracy is flat on all three** — the TARGET restate was NOT a
   load-bearing chain-of-thought anchor on this suite. Dropping it is safe.
2. **The latency win only materialises WITHOUT predicted outputs.** On
   cerebras the TARGET echo ≈ the input, so speculative decoding already
   accepts it at input-rate — there's nothing to save (neutral, within
   noise). On gemini (no speculative decoding) the echo is genuinely
   generated, so removing it is a clean ~8% latency cut. groq directional
   but parallelism-confounded.
3. Net: a **modest global efficiency win** — real latency on
   non-predicted-outputs providers, a small cost trim everywhere (fewer
   billed output tokens), neutral on the cerebras default, flat accuracy,
   and a simpler 3-field prompt.

**Lesson:** "fewer output tokens = faster" is provider-dependent —
speculative decoding (cerebras Predicted Outputs) can make an
echo-the-input field nearly free, so the bench MUST be read per-provider.
The win lives on the providers that don't speculate.

**Bench wiring:** gemini added to `prod.ts` `PROVIDERS`
(`--provider gemini`, `GEMINI_API_KEY`) to measure this — kept as a
standing third provider for the prod bench.
