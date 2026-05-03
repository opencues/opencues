# Transform Blanks

**Imperative-instruction blanks** — type an imperative next to `_` and the
runtime rewrites the surrounding text per the instruction.

```
You type:   change boy to girl _ the boy ran fast
You see:    the girl ran fast
Press ↓ :   change boy to girl _ the boy ran fast   (revert)
Press ↑ :   the girl ran fast                        (apply)
```

Where **fluid-blank** answers questions at `_` ("capital of france _" → Paris),
**transform-blank** edits text around `_` ("change boy to girl _ the boy ran"
→ "the girl ran").

---

## Enable it

In `~/.opencuesrc` (created automatically by `opencues seed-configs`):

```yaml
transform-blank-mode: on
```

Hot-reloads — no restart needed.

You probably also want:

```yaml
debug-mode: on        # see the pipeline trace per substitution
fluid-blank-mode: on  # both blank handlers can coexist; instructions go to
                      # transform-blank, lookups go to fluid-blank
```

---

## How it works

Three sequential LLM calls (~1s end-to-end on Groq gpt-oss-120b):

```
P1 EXTRACT    →  { instruction, target }
                 splits "X and Y" composed instructions on "|"
                 ("make past tense | remove pronouns")

P2 APPLY      →  draft rewrite of TARGET
                 runs ONCE per pipe-part (sequential composition —
                 output of step N feeds target of step N+1)

P3 VERIFY     →  OK | REPAIR
                 OK → trust draft.
                 REPAIR → emit corrected rewrite.
                 Catches AGREEMENT (they is → they are), COVERAGE
                 (changed first boy not all boys), STRUCTURAL
                 COMPLETENESS (made it a "?" not a real question), and
                 CONCEPT-SWAP propagation (cat that "barks" — cats
                 don't bark).
```

Returns a single CueResult with:
- `alternatives = [originalFullText, rewrittenText]`
- `spanStart = 0, spanEnd = text.length`

The runtime auto-substitutes the rewrite (currentIndex=1). Cycle Down
to revert to the original instruction-plus-target. The blank is locked
against re-resolution (`blankName = 'transform-blank'`) so the LLM
won't be re-triggered on the rewritten text.

---

## What kinds of instructions work

The benchmark covers 130 cases across 12 categories (median 85% pass
rate, 1s end-to-end on Groq gpt-oss-120b):

| Category | Example | Pass |
|---|---|---|
| literal swap | `change boy to girl _ the boy ran` | 100% |
| multi-span | `replace USD with EUR _ price is 10 USD plus 2 USD` | 100% |
| concept | `he/she swap _ he gave the book to John` | 100% |
| transform | `make past tense _ I run to the store` | 92% |
| math | `add 10% _ original price 100, final price 100` | 100% |
| linked-concepts | `change pet from dog to cat _ the dog wagged its tail and barked` | 90% |
| targeted scope | `capitalize the names _ john and sarah went to lunch` | 100% |
| composed (X and Y) | `make past tense and remove pronouns _ I run to the store` | 100% |
| multi-paragraph | `make past tense _ I wake at six. … Later I take the dog…` | 70% |
| conditional | `change boy to girl but not in the second sentence _ The boy. The boy. The boy.` | 80% |
| context-referring | `match the tense of the first sentence _ I walked. Then I buy.` | 50% |

The persistent floor (~15%) is mostly upstream model variance + judge
calibration on open-ended cases ("make it casual", "match the style of
…"), not pipeline design issues.

---

## Debugging

With `debug-mode: on` the runtime emits a trace at every pipeline stage:

```
TransformBlank: starting (textLen=42, blankIdx=4)
TransformBlank P1 EXTRACT (351ms): verdict=TRANSFORM, instruction="change boy to girl", target="the boy ran fast"
TransformBlank P2 APPLY: 1 step(s) — ["change boy to girl"]
TransformBlank P2 APPLY step 1/1 (227ms): "the girl ran fast"
TransformBlank P3 VERIFY (340ms): verdict=OK, rewrite="the girl ran fast"
TransformBlank: pipeline done (918ms total) — final="the girl ran fast"
TransformBlank: substituting "change boy to girl _ the boy ran fast" → "the girl ran fast" (origLen=42, rewriteLen=18, defAt=0)
```

Composed instructions show one APPLY line per step:

```
TransformBlank P2 APPLY: 2 step(s) — ["make past tense", "remove pronouns"]
TransformBlank P2 APPLY step 1/2 (412ms): "I ran to the store and I bought milk"
TransformBlank P2 APPLY step 2/2 (380ms): "ran to the store and bought milk"
```

REPAIR cases:
```
TransformBlank P3 VERIFY (340ms): verdict=REPAIR, rewrite="the children found mice"
TransformBlank: REPAIR accepted — using verify's correction
```

When the safety net trips (truncated/garbled REPAIR), the runtime falls
back to the draft and logs why:
```
TransformBlank: REPAIR rejected (truncated=false, garbled=true) — falling back to draft
```

---

## Architecture references

For the canonical implementation reference (3-pass design rationale,
prompt design, parser quirks, runtime integration, all the
experiments) see **`docs/architecture/transform-blank.md`**.

Quick locator:
- Source: `packages/opencues-core/src/sources/transform-blank-source.ts`
- Wire-up: `packages/opencues-core/src/sources/build-sources.ts` (option
  `enableTransformBlank`, gated on `transform-blank-mode: on`)
- Substitution: `packages/opencues-runtime/src/modules/resolver.ts`
  (search for `isTransformBlank`)
- Benchmark: `tests/benchmarks/transform-blank/` — 212 cases, run via
  `GROQ_API_KEY=… npx tsx tests/benchmarks/transform-blank/run.ts
  --mode extract-apply-verify --parallel 8`
- Experiments + design decisions:
  `tests/benchmarks/transform-blank/EXPERIMENTS.md`
- Priority chain: BlankSource (95) > TransformBlankSource (93) >
  FluidBlankSource (92) > SpellingSource (80)

---

## Known limits

- **Multi-paragraph >200 words** untested; current cases top out at ~150
  words. Latency may exceed 2s on long inputs.
- **Conditional with paragraph-specific scope** ("only in the first
  paragraph") is hit-and-miss because the model needs to reason about
  paragraph boundaries while applying the edit.
- **Context-referring "match the style of X"** is the weakest category
  (50% median) — open-ended style transfer is at the edge of the model's
  one-shot capacity.
- **No streaming** — the rewrite arrives all at once after ~1s.
- **No multi-span linked highlighting** — the runtime treats the whole
  rewrite as one block replacement. A future enhancement would diff
  the rewrite against the original and highlight individual word changes
  as linked spans.
