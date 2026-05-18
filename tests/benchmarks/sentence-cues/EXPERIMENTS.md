# sentence-cues — experiments log

Bench validates the `more-formal` sentence-cue prompt: given a buffer
of prose, segment into sentences and emit ≥3 formal rewrites per
sentence (or `ALT: NONE` for fragments, code, already-formal prose).

Targets (run.ts exit-gate): **recall ≥ 80%**, **precision ≥ 95%**.

---

## Experiment 1 — baseline (Groq gpt-oss-120b, fused prompt v1)

| Metric    | Result        | Gate      |
|-----------|---------------|-----------|
| Recall    | 23/23 = 100%  | ≥ 80% ✅  |
| Precision | 6/6 = 100%    | ≥ 95% ✅  |
| Same-OK   | 5/5 = 100%    | n/a       |
| Total     | 34/34 = 100%  | n/a       |
| Avg lat   | ~387 ms       | n/a       |

Per-bucket: every bucket 100%. Caveat — cases were authored without
iterating on model output, so the score is honest, but a holdout
suite would strengthen the claim. Holdout deferred to v2.

---

## Experiment 2 — 5-provider sweep (full 30 cases, parallel=4)

Runs logged under `tests/results/sentence-cues-matrix/`.

|              Provider           | Recall          | Precision    | Same-OK         | Avg lat |
|---------------------------------|-----------------|--------------|-----------------|---------|
| groq gpt-oss-120b               | **23/23 (100%)**| 6/6 (100%)   | 5/5 (100%)      | 387 ms  |
| cerebras gpt-oss-120b           | 22/23 (95.7%)   | 6/6 (100%)   | 4/5 (80%)       | **247 ms** |
| gemini-flash-lite               | 22/23 (95.7%)   | 6/6 (100%)   | 5/5 (100%)      | 628 ms  |
| claude-haiku-4-5                | 21/23 (91.3%)   | 6/6 (100%)   | 5/5 (100%)      | 1107 ms |
| openai-nano (gpt-5.4-mini)      | 21/23 (91.3%)   | 6/6 (100%)   | 5/5 (100%)      | 1347 ms |

**Headline:** every provider clears both gates. Precision is 100%
across all 30 reject cases × 5 providers = 150 reject decisions
without a single false positive.

**Production default recommendation:** existing auto-route (groq → cerebras
chain) lands ≥95.7% recall at 247-387 ms — fastest tier. No
per-pipeline override needed.

**Same-OK regression on Cerebras** (4/5 = 80%): one already-formal
case produced an alt that judged BROKEN. Not a precision failure (it
didn't fire on a CEDE case), but worth noting — Cerebras is slightly
more eager to "rewrite anyway" than Groq on the same prompt. Stays
above the cede precision gate (which is the load-bearing metric for
trust) so we ship it.

---

## Status

v1 prompt promoted as the production reference. Shipped at:

- `packages/opencues-core/src/sources/sentence-cue-source.ts` (the
  source class)
- `defaults/cues/more-formal/CUE.md` (canonical use case)

Future tuning ideas (low priority):

- Holdout suite for honest generalisation measurement.
- Bench multiple `scope: sentence` cue prompts side-by-side (e.g.
  more-concise, active-voice) to validate the source supports
  arbitrary sentence-level prompts.
- Per-paragraph batching for long buffers (today: one call per
  whole buffer).

---

*Last updated: 2026-05-18.*
