# fluid-config — experiments log

Each entry is one provider × prompt-variant run on the full 61-case
suite. Format: provider · variant · precision / recall / total · notes.

Targets (`run.ts` exit-gate): **precision ≥ 98%**, **recall ≥ 80%**.

---

## Experiment 1 — baseline (Groq gpt-oss-120b, fused prompt v1)

| Metric    | Result        | Gate      |
|-----------|---------------|-----------|
| Precision | 28/28 = 100%  | ≥ 98% ✅  |
| Recall    | 30/33 = 90.9% | ≥ 80% ✅  |
| Total     | 58/61 = 95.1% | n/a       |
| Avg lat   | ~310 ms       | n/a       |

**Per-bucket** (pass / total):

| Bucket                 | Pass  | Note |
|------------------------|-------|------|
| hit-clean              | 20/20 | perfect — direct-mention cases all land |
| hit-fuzzy              | 10/13 | 3 misses (2 WRONG_VALUE, 1 FN) — see below |
| reject-user-blank      | 7/7   | volume/brightness/stocks/weather/media all rejected |
| reject-fluid           | 7/7   | factual lookups all rejected |
| reject-ambiguous       | 5/5   | vague pronouns all rejected |
| reject-out-of-scope    | 9/9   | sounds-like-a-setting but no such feature — all rejected |

**The three fuzzy misses:**

1. `hf-voice-aloud` ("I want to hear the tips read aloud _") —
   parallel-run scored WRONG_VALUE (right setting, empty value); single-run
   scored WRONG_SETTING (model emitted `SETTING: voice`, dropping the
   `-mode` suffix). Truncated output — model bailed after the SETTING line.
2. `hf-ambient-page` ("let the model know which website I am on _") —
   right setting (`ambient-context-mode`), empty value. Same truncation
   pattern.
3. `hf-user-no-pii` ("stop sharing anything personal with the model _") —
   classified as NONE. Model didn't link "stop sharing personal" to
   `user-context-mode`. The system prompt example shows the inverse
   ("let it use my personal info") but not the explicit-off direction.

**Open hypotheses for v2 prompt:**

- Raise `maxTokens` from 64 → 128 to reduce truncation on edge cases.
- Add an explicit "stop sharing personal data → user-context-mode=off"
  few-shot to fix the one FN.
- Add a "never drop the `-mode` suffix" guardrail OR loosen the parser
  to accept `voice` → `voice-mode` via prefix match against FEATURES.
- Re-run across all 5 providers to see if any provider hits the same
  three failures (the truncation might be Groq-specific).

**Not pursuing yet:** the headline numbers already clear both gates;
the failures are recoverable (FN drops into FluidBlank, the two
WRONG_VALUEs no-op safely because the parser can't apply an empty
value). Pinning v1 as the reference and moving to implementation
seems right; v2 tuning can ride alongside the runtime work.

---

## Experiment 2 — v2 prompt (Groq gpt-oss-120b)

Three changes layered onto v1:

1. `maxTokens` raised 64 → 128 (was clipping truncated outputs).
2. "ALWAYS emit all three lines" + explicit `-mode` suffix guard
   added to the OUTPUT FORMAT section, listing every full scalar name
   so the model can't drop `-mode`.
3. Two new off-direction few-shots: "stop sharing anything personal"
   → user-context-mode=off; "don't tell the LLM what field I'm in"
   → ambient-context-mode=off. Plus the v1 "let the model know which
   website I am on" → ambient-context-mode=on promoted from a test
   case into an example.

| Metric    | v1        | v2        | Δ      |
|-----------|-----------|-----------|--------|
| Precision | 100%      | 100%      | —      |
| Recall    | 90.9%     | **100%**  | +9.1pp |
| Total     | 95.1%     | **100%**  | +4.9pp |
| Avg lat   | ~310 ms   | **~213 ms** | -97 ms |

**61/61 cases pass** — every bucket clean (hit-clean 20/20, hit-fuzzy
13/13, all four reject buckets perfect). The latency drop is a
side-effect of removing the cases where the model truncated and
the runtime then waited for a stall.

V2 is the reference. Future regressions should re-run against this
baseline. Next questions:

- Does the 5-provider sweep agree? Different providers may handle
  the off-direction examples differently. Cerebras gpt-oss-120b is
  the most interesting comparison (same model family, different
  inference stack).
- Holdout set — the bench is now showing the prompt the model trained
  AGAINST (added examples ≈ added test cases). Need a separate
  holdout suite of ~30 cases the prompt never saw before promoting
  v2 as truly validated. Mirror fluid-blank-ambient's pattern
  (in-prompt vs held-out).
- Production wiring — at 100% on the in-prompt set the prompt has
  earned the right to ship. `ConfigIntentSource` at priority 93 +
  `configChanged` on `StatuslinePayload` is the next step.

---

## Experiment 3 — v2 prompt on HOLDOUT suite (Groq gpt-oss-120b)

`cases-holdout.ts` — 34 unseen cases, every FEATURE exercised at
least once on each polarity (20 hits) + 14 rejects across all four
reject buckets, with phrasings deliberately drifted from anything
in the prompt's few-shot examples.

| Metric    | in-prompt | holdout   | Δ      |
|-----------|-----------|-----------|--------|
| Precision | 100%      | **100%**  | —      |
| Recall    | 100%      | **90.0%** | -10pp  |
| Total     | 100%      | **94.1%** | -5.9pp |
| Avg lat   | ~213 ms   | ~253 ms   | +40 ms |

**Both gates pass on the holdout** (precision ≥ 98%, recall ≥ 80%).
Precision still perfect — the trust boundary holds across novel
phrasings, which is the load-bearing result. The recall drop is
the honest measurement we couldn't see from the in-prompt run.

**The two holdout misses:**

1. `ho-tips-on` — "I want to see hover hints on words again _"
   classified as **word-cues-mode=on** instead of tips-mode=on.
   Genuinely ambiguous wording: "hover hints on words" could plausibly
   mean either popup tip-boxes (tips-mode) OR per-word alternative
   suggestions (word-cues-mode). Reasonable take, wrong label. The
   user would likely correct by saying "show the tip popups again"
   on the next try. Not a trust failure — both targets are settings,
   not user blanks.

2. `ho-trigger-immediate` — "fire blanks the second I press the
   underscore key _" classified as **blank-trigger-mode=spaced**
   instead of immediate. Right setting, wrong direction. Model
   appears anchored to the "spaced is the markdown-safe fix"
   few-shot in the prompt. A short "immediate" few-shot would
   probably resolve it.

**Verdict:** v2 generalises. The 10pp recall drop is large enough to
acknowledge but small enough that the feature is shippable. The two
failure modes are recoverable — neither leaks into FP territory.

Future tuning ideas (low priority — already past both gates):

- Add an explicit "immediate" direction few-shot for blank-trigger-mode
  to pin the polarity (one-line change).
- Add a "hover hints on words" disambiguation example if the
  tips-vs-word-cues confusion shows up in real usage.

**Status:** v2 promoted as the production reference prompt. Ready
to wire `ConfigIntentSource` (priority 93) + `configChanged` field
on `StatuslinePayload`.

---

## Experiment 4 — v2.1 (immediate-trigger few-shot added)

Added one few-shot for `blank-trigger-mode=immediate` to balance the
prompt's polarity coverage (v2 only had the spaced direction). The
holdout failure on `ho-trigger-immediate` became non-deterministic
across runs after the addition — sometimes passing, sometimes
shifting to a different fail mode. Net headline unchanged (90-95%
recall on holdout, Groq). Kept the few-shot since polarity balance
is structurally better.

---

## Experiment 5 — 5-provider sweep (in-prompt + holdout × 5)

Runs logged under `tests/results/fluid-config-matrix/`.

|             Provider            | In-prompt | Holdout (recall) | Holdout (precision) | Avg lat (HO) |
|---------------------------------|-----------|------------------|---------------------|--------------|
| gemini-flash-lite               | 100%      | **100%** (20/20) | 100% (14/14)        | 491 ms       |
| groq gpt-oss-120b               | 100%      | 95% (19/20)      | 100% (14/14)        | **251 ms**   |
| cerebras gpt-oss-120b           | 100%      | 95% (19/20)      | 100% (14/14)        | 248 ms       |
| openai-nano (gpt-5.4-mini)      | 100%      | 95% (19/20)      | 100% (14/14)        | 845 ms       |
| claude-haiku-4-5                | 100%      | 90% (18/20)      | 100% (14/14)        | 848 ms       |

**Headline result:** every provider clears both gates on the holdout.
Precision is **100% across 210 reject cases** (5 providers × 28 in-prompt
+ 5 × 14 holdout). The trust boundary is robust to provider choice.

**Recommendation for production default:**

- Use the existing OpenCues auto-route (groq → cerebras chain). Both
  hit 95% holdout recall at ~250 ms — the fastest tier.
- Gemini Flash Lite is the accuracy-pinned override (100% recall,
  ~490 ms — 2× latency cost for one recovered case).
- Claude Haiku trails by ~5pp on recall AND ~4× on latency — not a
  good fit for a per-keystroke classifier.

No per-pipeline override needed; the runtime's `llm-provider` auto
chain already routes correctly.

**Status:** v2.1 prompt validated across all 5 providers. Ready to
implement `ConfigIntentSource` (priority 93) + `configChanged` field
on `StatuslinePayload`.

---

## Experiment 6 — rewrite-imperative precision hole + bench re-pointed at the PRODUCTION prompt (July 2026)

**Trigger (live bug):** `congratz make more professional _` routed to
`sentence-cues-mode on` — and WROTE the scalar — instead of ceding to
TransformBlank. Reproduced twice on the user's host (gemma-4-31b) and
then on cerebras gpt-oss-120b.

**Discovery #1 — the bench was validating a phantom prompt.** fused.ts
carried its own copy of the v2.1 settings-only prompt; production's
`SYSTEM_PROMPT` (config-intent-source.ts) had since become the
three-intent classifier (SETTING/PROVIDER/NONE) and nobody re-pointed
the bench. Every number above this line measures a prompt that no
longer ships. Fix: fused.ts now imports the production `SYSTEM_PROMPT`
+ `parseConfigIntentOutput` directly (PROVIDER verdicts map to a
synthetic `provider:<scope>` setting for the judge). Same lesson as
transform-blank's archive/ — bench-local prompts drift; drive the
production artifact.

**Discovery #2 — the precision hole.** 10-case ad-hoc probe of rewrite
imperatives against the production prompt: **5/10 false positives**,
all → `sentence-cues-mode on` (`make (it/more) professional/formal`
pattern; the shipped `more-formal` sentence-cue is the semantic trap).
The stale bench prompt scored 4/10 on the same probe. The existing
suites had NO rewrite-imperative reject cases, hence the 100%-precision
headline.

**Fix:** INTENT-C rule — a rewrite imperative changes THE TEXT ONCE
(→ NONE, TransformBlank's job); a setting changes BEHAVIOUR from now
on; ongoing markers ("as I write", "while I type") applied to sentence
improvement ARE feature requests → sentence-cues-mode. Plus 2 NONE
few-shots + 2 sentence-cues positive contrasts. New `reject-transform`
bucket: 5 cases in the main suite, 5 in holdout (incl. the exact live
utterance; no phrasing overlap with the few-shots). `ro-keybind`
reclassified to `hf-keybind` (hit → nav-keymap ctrl-shift): it was
authored before nav-keymap existed and only survived as a reject
because the stale bench prompt predated the feature too.

**Results (production prompt, post-fix):**

| Run | Precision (gate ≥98%) | Recall (≥80%) | reject-transform |
|---|---|---|---|
| cerebras main (68) | **32/32 = 100%** | 32/36 = 88.9% | 5/5 TN |
| cerebras holdout (40) | **19/19 = 100%** | 17/21 = 81.0% | 5/5 TN |
| groq main (68) | **32/32 = 100%** | 31/36 = 86.1% | 5/5 TN |
| groq holdout (40) | **19/19 = 100%** | 17/21 = 81.0% | 5/5 TN |

Ad-hoc probe post-fix: **20/20 NONE** (10 utterances × gpt-oss-120b +
gemma-4-31b — the live model). Sentence-cues boundary intact:
`enable sentence cues _` / `turn off the sentence cues _` /
`suggest better versions of my sentences as i write _` all route
correctly.

Remaining recall tail (~4 cases per suite) is the pre-existing
identity-context phrasing cluster (`hc-user-*`, `ho-user-*`) — FN =
recoverable by design (fluid-blank answers), untouched by this change.

**Status:** production prompt v3 (three-intent + rewrite-imperative
rule) validated on cerebras + groq; bench structurally cannot drift
from production again.

## Experiment — v2.2: ACTION intent (undo/redo) added to the PRODUCTION prompt (2026-07-13)

The July 2026 undo feature adds a fourth verdict kind (ACTION —
undo/redo + count) to the production `SYSTEM_PROMPT` in
`@opencues/core`'s `config-intent-source.ts`. The existing `fused.ts`
bench drives its own settings-only prompt, so it cannot certify a
production-prompt edit — this experiment introduces **`prod.ts`**,
which drives the production `SYSTEM_PROMPT` + `parseConfigIntentOutput`
+ `validateAgainstRegistry` verbatim, plus **`cases-undo.ts`** (21
ACTION cases: 15 multilingual positives incl. digit + number-word
counts, 6 negatives pinning the outside-the-buffer boundary).

**Method** (phantom-regression discipline): same-session baseline
first, `--parallel 4`, cerebras-gpt-oss (the production default).
Baseline prompt = `origin/master`'s file snapshot imported via
`--prompt-module`; the tuned few-shot examples in the new prompt are
byte-identical to baseline (the ACTION change is purely additive).

**Results — settings suites (regression check):**

| Suite | Baseline (pre-ACTION) | New (with ACTION) |
|---|---|---|
| in-prompt (61) | precision 28/28 = 100%, recall 28/33 = 84.8%, pass 56/61 | precision 28/28 = 100%, recall 28/33 = 84.8%, pass 56/61 |
| holdout (34) | precision 14/14 = 100%, recall 12/20 = 60.0%, pass 26/34 | precision 14/14 = 100%, recall 13/20 = 65.0%, pass 27/34 |

No settings regression: headline numbers identical on the in-prompt
suite (the fail set shuffled by one case among the already-stale
`user-context-mode` cases, which predate the identity-context rename);
holdout moved +1 (noise-level, in the new prompt's favour). The
overloaded-prompt regression the SUMMON experiment hit (recall
~85% → ~60% when a second JOB was added) did not recur — classifying
a fourth intent KIND is the same job shape, not a second job.

**Results — undo suite (new):** precision 6/6 = 100%, recall
14/15 = 93.3% (pass 20/21). The one miss is `ua-redo-that`
("redo that _" → NONE, an FN — recoverable). Multilingual positives
all passed: ja (incl. `3回元に戻して` → count 3), zh, es, de, fr
(incl. `annuler les trois derniers` → count 3), ru.

**Status:** ACTION intent certified — settings precision gate intact
(100%), undo recall 93.3% ≥ the 80% target. `prod.ts` is now the
canonical runner for any future production-prompt edit; `fused.ts`
stays for continuity with the v2.x settings-only history.

---

## Experiment — v2.3: post-confirmation undo context (agentic finding) (2026-07-13)

Live agentic scenario 109 caught what the bench couldn't: after ANY
config-intent settings flip, the confirmation pair sits in the buffer,
so the very next `undo _` reads `debug-mode on undo _` — and the v2.2
prompt classified that as **SETTING debug-mode=on** (conf 0.92),
RE-APPLYING the change instead of undoing it. This is the most common
live undo context (undoing the change you just made), and it was
invisible to the bench because every v2.2 case was a bare command.
Same lesson class as PR #195: context-induced classification bugs need
the agentic host.

**Fix (additive):** one rule line in INTENT C ("the text BEFORE the
verb is often the visible confirmation of the change being undone —
do NOT re-read it as a SETTING command") + one few-shot
(`debug-mode on undo _` → ACTION undo). Five new bench cases
(`UNDO_CONTEXT_CASES`): pair+undo ×2, answer+undo, pair+redo,
pair+元に戻して.

**Results (cerebras, --parallel 4):**

- undo suite: precision 6/6 = 100%, recall 18/20 = 90% — all four
  undo-after-context cases now pass (incl. the Japanese pair case).
  Two redo FNs remain (`redo that _`, `tips-mode off redo _`) —
  recoverable, known limitation (bare `redo _` passes).
- settings (in-prompt): precision 28/28 = 100%, recall 27/33 = 81.8%
  (stable across 3 runs). One case down vs v2.2's 84.8%: the two
  symptom-phrased debug cases (`hf-debug-want-logs`,
  `hf-debug-too-noisy`) now both FN where one used to flap — the new
  conservatism rule slightly dampens symptom-phrased settings reads.
  FNs are recoverable (fluid-blank answers); precision gate intact;
  recall ≥ 80% target holds. Accepted trade for fixing an
  apply-the-wrong-thing bug in the dominant undo flow.

**Status:** shipped in the same PR as v2.2. Scenario 109 in the
agentic harness is the standing gate for this context class.

---

## Experiment — `qwen` model alias (2026-09-04)

Cerebras shipped `qwen-3.8-27b` and deprecated `gemma-4-31b` (Public
preview). One few-shot added (`switch model to qwen _` → cerebras /
qwen-3.8-27b) + `qwen` in the `hasLikelyIntent` curated keywords.

**Variants benched (cerebras gpt-oss, --suite all --parallel 4,
same-session baseline via `--prompt-module` on the HEAD prompt):**

| Prompt | settings P/R | undo P/R | total |
|---|---|---|---|
| baseline | 100% / 84.8% | 100% / 90% | 84/91 |
| qwen ADDED (shipped) | 100% / 81.8% | 100% / 95% | 84/91 |
| qwen REPLACING gemma | 100% / 84.8% | 100% / 90% | 84/91 |

The replacement variant looked like a free win but was rejected by an
alias probe: without its few-shot, `use gemma for blanks _` misroutes to
**ollama/gemma4:e2b** (the model's world knowledge grabs the nearest
in-prompt gemma-shaped id) — a deprecated alias must degrade safely, not
reroute to a provider the user doesn't run. Both examples kept. Shipped
prompt probes: qwen → cerebras/qwen-3.8-27b (.94-.96), gemma →
cerebras/gemma-4-31b (.93-.94). Full sweep:
`tests/results/qwen-3.8-discovery/REPORT.md`.

---

## Experiment — full-registry coverage sweep + MENU_TUNABLES plugged in (2026-09-05)

**Question:** does the classifier identify intent for EVERY `config _` menu
entry under varied phrasing, and are all entries reachable at all?

**Method:** `coverage.ts` (new, standalone) — every value of every
Claude-Code-reachable setting × four phrasings (clean / colloquial /
symptom-not-solution / terse `<setting> <value> _`), provider + model
routing for all three buckets, undo/redo, and 31 reject controls
(lookups, rewrites, user blanks, comparatives, ambiguous, out-of-scope,
prose). 248 → 262 cases as the sweep grew. Cerebras gpt-oss-120b (the live
blanks route), `--parallel 4`. Verified live on Claude Code through the
bridge (harness home, real OPENCUES.md writes): 12 original phrasings +
8 tunable/alias phrasings, 20/20.

**Findings before any change:**

1. **6 of the 35 menu entries were unreachable by sentence** (7 of 37 on
   chrome): the MENU_TUNABLES. `buildFeatureBlock` read FEATURES only.
2. Bench expectations were stale: six `user-context-mode` cases (renamed
   June 2026) marked the model WRONG for answering the current name —
   in-prompt recall read 84.8% when the classifier was at ~97%.
3. The bench's 128-token cap truncated ~5% of gpt-oss verdicts mid-line
   (`INTENT: PROVIDER` then nothing); the runtime floors that call at
   2048. Raised to 512: coverage hits 88.9% → 94.5% with NO prompt edit.
4. `blanks on claude please _` → "unknown provider 'claude'" (validator).
5. A terse `tips on _` was rejected while `tips off _` passed.
6. The bench never ran the runtime's deterministic undo/redo pre-pass, so
   `tips-mode off redo _` graded as a miss the runtime never makes.
   Mirroring it exposed the opposite bug: **`enable undo _` performed an
   undo** (trailing-alias match) instead of flipping undo-mode.

**Changes:** tunables enumerated (host-scoped alike) + validated at their
preset lists; `claude`/`google` alias normalisation; a PRESET TUNABLES
rule (listed number / mode name / superlative-as-endpoint routes;
comparatives and unlisted names → NONE; scoped to tunables so
`make it faster, less reasoning` stays max-thinking off) + three
few-shots (`tips on _`, braille, `wait longer … _` → NONE) + a
post-confirmation `redo` few-shot; deterministic matcher accepts a
trailing demonstrative (`redo that _`) and cedes when a settings verb or
question stem precedes the alias (`enable undo _`, `how do i undo _`).

**Ablation (why the rule is negative):** a positive-only tunable rule
routed every comparative to the nearest preset (`slow down the glimmer` →
1500, `wait longer` → 2000, `spinner` → braille) — precision is the
gate, so the explicit NONE clause stays; its collateral (`redo that _`
→ NONE) was fixed in the deterministic matcher instead of the prompt.

**Results (same session, cerebras gpt-oss-120b):**

| Suite | before | after |
|---|---|---|
| in-prompt settings P / R | 100% / 84.8% (stale names) | **100% / 95.0%** (71 cases; misses: keybind "shift-arrow", "what the runtime is doing") |
| undo | 100% / 95% | **100% / 100%** (deterministic pre-pass mirrored) |
| holdout settings P / R | 100% / 78.9% | **100% / 89.5%** (misses: "hover hints" → inline-cues, "synonym suggestions") |
| coverage hits / rejects | 88.9% / 100% (128-tok) | **95.7% / 100%** (262 cases) |
| live CC | 12/12 | **20/20** (incl. all 6 tunables + `claude` alias) |

Remaining coverage misses are phrasing-shaped and stable: the
`fluid-config-mode` self-reference ("natural language settings" reads as
sentence-cues), `sentinel-language` described without its name, a
model-only pick without the provider named (`gemini flash lite` picks
3.1 over 3.5 — both listed; `cerebras gpt-oss` drops the model).

---

*Last updated: 2026-09-05.*
