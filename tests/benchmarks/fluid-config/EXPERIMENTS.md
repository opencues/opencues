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

*Last updated: 2026-05-18.*
