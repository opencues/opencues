# fluid-blank-replace — REPLACE-detection accuracy

## The question

FluidBlank is a deterministic slot splice: the answer lands in the
verified SPAN, and nothing else in the buffer can change. That
structurally rules out replacement-shaped asks — `her name is Sarha fix
the spelling _` — which today route to TransformBlank's whole-buffer
merge (a full-buffer prompt, more latency, weaker guarantees).

The exploration: could fill grow a **replacement parse** — an extra
detection step that emits an exact-substring target for the answer to
replace — while keeping the deterministic-splice safety contract (the
target must verify as an exact contiguous substring of the input, same
trick the SPAN line already uses)?

This bench answers the FIRST question only: **detection accuracy**.
Latency/wiring (fused extra output line vs a true post-process second
call) is deliberately out of scope — the detection task is identical
either way.

## Method

- 56 labeled cases (`cases.ts`): 28 `replace` across 7 categories
  (spelling-fix, fact-correction, format/case, unit-in-place,
  value-update, math-fix, word-swap), 22 `fill` including two
  adversarial families — correction-adjacent vocabulary in unrelated
  chatter ("i fixed the bug… http status for not found _") and
  plausible-target bait (buffer contains a wrong-looking value but the
  ask is a plain lookup: "capital of germany _ munich trip next week"),
  6 `none` placeholders.
- Bench-local detector prompt (`prompt.ts`) — NOT the shipping
  FUSED_SYSTEM_PROMPT. Output: `CLASS: FILL|REPLACE|NONE`,
  `TARGET: <exact substring>`, `VALUE: <replacement>`.
- Fully deterministic grading, no LLM judge: class exact-match; target
  must be an exact contiguous substring of the input AND match the
  expected target (alternates allowed); value graded case-insensitively
  against an accept-list, informational only.
- One call per case, `--parallel 4`, all providers same session.

## Results — 2026-08-27

| model | class acc | replace recall | fill→replace FP | target substring | target correct | value (info) | p50 |
|---|---|---|---|---|---|---|---|
| groq gpt-oss-120b | 54/56 (96.4%) | 26/28 | **0/22** | 26/28 | 26/28 | 25/28 | 241ms |
| cerebras gpt-oss-120b | 56/56 (100%) | 28/28 | **0/22** | 28/28 | 25/28 | 23/28 | 316ms |
| cerebras gemma-4-31b | 56/56 (100%) | 28/28 | **0/22** | 28/28 | 28/28 | 27/28 | 277ms |
| gemini-3.5-flash | 56/56 (100%) | 28/28 | **0/22** | 28/28 | 28/28 | 27/28 | 1112ms |

The safety metric is **fill→replace false positives** — a false
positive means the runtime would touch text the user didn't ask to
edit. **Zero across all four models**, including every
correction-vocabulary and plausible-target-bait case. The prompt's
"prefer FILL when unsure" rule appears to hold.

### Failure notes

- groq `r-fact-4` (`fix the code _`) → NONE — collides with the
  placeholder shape ("fix _ here" is NONE in fluid's own SPAN rules).
- groq `r-unit-2` (`5 miles… convert to km _`) → FILL — defensible;
  as a fill, the fused path would answer "8 km" at the span anyway.
- cerebras gpt-oss target "misses" are mostly boundary width:
  `90 degrees celsius → 100 degrees celsius` and `five sides → six
  sides` yield the IDENTICAL corrected buffer as the expected narrow
  target. Only `target="code"` (r-fact-4) is a genuine wrong target.
  A buffer-equivalence grader would score these correct; per-case
  target strings are graded strictly for now.

## Verdict

Detection is not the bottleneck — every production-candidate model
clears 96%+ class accuracy with zero false positives, and
**gemma-4-31b (the current personal default) is perfect on class,
target-substring validity, and target correctness at 277ms p50.**

## Open questions before wiring

1. **Fused line vs post-process call.** A `REPLACE:` line on the
   existing fused call adds ~zero latency but requires re-running the
   176-case fluid-blank-ambient bench (prompt-edit rule). A
   post-process second call leaves the shipping prompt untouched but
   adds a full round trip (~250-350ms on cerebras).
2. **Occurrence ambiguity.** A target substring appearing twice in the
   buffer needs an occurrence rule (nearest-to-`_`?) before the splice
   is deterministic. Not yet covered by the suite.
3. **Routing overlap with TransformBlank.** These asks currently
   classify as transform. If fill claims them, the transform
   classifier's cede behaviour needs a matching bench pass.
4. **Grading**: switch target grading to buffer-equivalence
   (apply target→value, compare buffers) to stop punishing defensible
   boundary-width choices.

## Round 2 — 2026-08-27: shipping prompt (COMMAND line) + runtime gate

The feature shipped as `replace-parse-mode` (off by default), living in
**TransformBlankSource** — not FluidBlank: transform (priority 93)
claims imperative asks before fluid (92) ever sees them, so the
detector runs in parallel with the FUSED call and a verified detection
rides the resolver's existing bounded-splice branch
(`metadata.transformTarget`). The prompt moved to
`@opencues/core/src/sources/replace-detect.ts` and grew a `COMMAND:`
line (the imperative phrase + `_`, verified verbatim, consumed by the
splice); this bench now drives the shipping prompt/parser/verifier
directly — no bench-local copy.

Grading changed with it: `verifyReplaceDetect` IS the runtime
acceptance gate, so the bench's VERIFIED metric measures exactly what
production would splice.

| model | class acc | replace VERIFIED | fill→replace FP | target correct | p50 |
|---|---|---|---|---|---|
| cerebras gemma-4-31b | 56/56 (100%) | **28/28 (100%)** | **0/22** | 28/28 | 206ms |
| cerebras gpt-oss-120b | 54/56 (96.4%) | 26/28 (92.9%) | **0/22** | 25/28 | 356ms |

gpt-oss misses are all degrade-safe: `fix the code _` → NONE and
`convert to km _` → FILL both fall back to fused; `deadline friday,
move it…` verifies with the wider target `deadline friday` → "Monday"
(drops the word "deadline" — visible, Down-arrow-revertable, and the
kind of boundary-width judgement fused makes too).

The first gemma run rejected both swap-phrasing cases ("swap **kids**
for the formal word _") — the target legitimately appears INSIDE the
command, and the v1 whole-text uniqueness rule read that as ambiguity.
The gate now counts occurrences **outside** the command span (exactly
one required) and additionally rejects when a command-side copy
precedes the real target (the resolver splices the first occurrence).
Both cases verify after the fix; the mistaken-operand rejection
("fix the code _" → target "code") is preserved.

Operational note: cerebras rate-limiting produced one all-∅ phantom run
mid-session (empty responses after the adapter's 6 backoff retries —
the exact same-session-baseline trap `tests/benchmarks/CLAUDE.md`
warns about). Re-run with `--parallel 1`/`--parallel 2` and
`OC_BENCH_RETRIES=8` when cerebras is being hammered.

## Reproduce

```bash
npx tsx tests/benchmarks/fluid-blank-replace/run.ts                       # groq default
OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/fluid-blank-replace/run.ts
OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss OPENCUES_CEREBRAS_MODEL=gemma-4-31b npx tsx tests/benchmarks/fluid-blank-replace/run.ts
OPENCUES_BENCH_PROVIDER=gemini-flash-lite OPENCUES_GEMINI_MODEL=gemini-3.5-flash npx tsx tests/benchmarks/fluid-blank-replace/run.ts
```

> ⚠ The fluid-blank gemini adapter's default pin
> (`gemini-3.5-flash-lite`) is rejected upstream as of 2026-08-27
> ("invalid argument"), as is `gemini-3.6-flash`; `gemini-3.5-flash`
> works. The adapter pin needs a catalogue re-verify — separate issue,
> not touched here.
