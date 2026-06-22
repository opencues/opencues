# Transform Blanks

**Imperative-instruction blanks** — type an imperative next to `_` and the
runtime rewrites the surrounding text per the instruction (or generates
new content from scratch when no surrounding text is given).

```
You type:   the boy ran fast change boy to girl _
You see:    the girl ran fast
Press ↓ :   the boy ran fast change boy to girl _   (revert)
Press ↑ :   the girl ran fast                        (apply)
```

Where **fluid-blank** answers questions at `_` ("capital of france _" → Paris),
**transform-blank** edits text around `_` ("the boy ran change boy to girl _"
→ "the girl ran") OR generates new content ("write a poem _" → a poem).

---

## Enable it

In `~/.cues/OPENCUES.md` (created automatically by `opencues seed-configs`):

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

## The shape — body first, instruction at the end

```
<TARGET> <INSTRUCTION> _
e.g.  the boy ran fast change boy to girl _
```

Body first, instruction last, `_` triggers the rewrite. This is the
only shape that works for live typing because `_` resolves the moment
you type it — anything you'd type *after* `_` would never reach the
source. (The EXTRACT prompt is also trained on the inverted layout
`<INSTRUCTION> _ <TARGET>` so a pasted snippet shaped that way still
parses, but you can't get there by typing.)

---

## How it works

Up to three sequential LLM calls (~1.4s end-to-end median on Groq
gpt-oss-120b):

```
P1 EXTRACT    →  { instruction, target }
                 splits "X and Y" composed instructions on "|"
                 ("make past tense | remove pronouns")
                 EMPTY target → routes to GENERATIVE branch (single call,
                 no APPLY/VERIFY) for "write a poem _" / "compose an
                 email _" type prompts

P2 APPLY      →  draft rewrite of TARGET
                 runs ONCE per pipe-part (sequential composition —
                 output of step N feeds target of step N+1)

P3 VERIFY     →  OK | REPAIR
                 OK   → trust draft.
                 REPAIR → emit corrected rewrite.
                 Catches AGREEMENT (they is → they are), COVERAGE
                 (changed first boy not all boys), STRUCTURAL
                 COMPLETENESS (made it a "?" not a real question), and
                 CONCEPT-SWAP propagation (cat that "barks" — cats
                 don't bark).

                 SKIPPED on literal swaps (`change X to Y`) and
                 BrE↔AmE conversions — saves ~13% latency at no
                 measurable accuracy cost.
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

The benchmark covers **212 cases across 18 categories**. Median pass
rate ~83%, ~1.4s per case end-to-end on Groq gpt-oss-120b.

### Strong categories (90-100% pass rate)

| Category | Example |
|---|---|
| literal swap | `the boy ran change boy to girl _` |
| multi-span | `price is 10 USD plus 2 USD replace USD with EUR _` |
| concept | `he gave the book to John he/she swap _` |
| transform | `I run to the store make past tense _` |
| math | `original price 100, final price 100 add 10% _` |
| linked-concepts | `the dog wagged its tail and barked change pet from dog to cat _` |
| targeted scope | `john and sarah went to lunch capitalize the names _` |
| composed (X and Y) | `I run to the store make past tense and remove pronouns _` |
| code-transform | `var name = "alice"; var age = 30; convert var to const _` |
| adversarial | `I want to change my approach change the word change to modify _` |
| negative (correctly bails) | `capital of france _` |

### Mid categories (70-90%)

| Category | Example |
|---|---|
| long-text (40 cases, 4 sub-buckets) | `<multi-paragraph input> make past tense _` |
| creative-rewrite | `Hello, where is the bathroom? translate to pirate speak _` |
| format-transform | `I need eggs, milk, bread, cheese convert to bullet points _` |
| multi-paragraph | `<2-3 paragraph story> change protagonist to wizard _` |
| conditional | `The boy ran. ... change boy to girl but not in the second sentence _` |

### Weak categories (50-70%)

| Category | Example |
|---|---|
| context-referring | `... match the style of the first sentence _` |
| tone-shift | `I think maybe we should perhaps consider make it more confident _` |

The persistent floor (~17%) is mostly upstream model variance + judge
calibration on open-ended cases ("make it casual", "match the style of
…"), not pipeline design issues.

---

## Generative blanks

When the instruction has no target text to operate on, the pipeline
routes to a single-pass generative branch:

```
write a poem _                              → a poem
compose an email asking for a meeting _     → email body
give me 5 startup ideas _                   → numbered list
draft a thank you note for an interview _   → letter
write a tweet announcing a product launch _ → tweet
```

Latency is ~700-1200ms (no VERIFY pass — there's nothing to verify
against). The generated content is the rewrite; cycle Down to revert
to the original instruction text.

---

## Debugging

With `debug-mode: on` the runtime emits a trace at every pipeline stage
to `/tmp/opencues.log`:

```
TransformBlank: starting (textLen=42, blankIdx=4)
TransformBlank P1 EXTRACT (351ms, max_tokens=820): verdict=TRANSFORM, instruction="change boy to girl", target="the boy ran fast"
TransformBlank P2 APPLY: 1 step(s) — ["change boy to girl"]
TransformBlank P2 APPLY step 1/1 (227ms, max_tokens=812): "the girl ran fast"
TransformBlank P3 VERIFY: SKIPPED (low-stakes instruction + faithful draft)
TransformBlank: pipeline done (578ms total) — final="the girl ran fast"
TransformBlank: substituting "the boy ran fast change boy to girl _" → "the girl ran fast" (origLen=42, rewriteLen=18, defAt=0)
```

Composed instructions show one APPLY line per step:

```
TransformBlank P2 APPLY: 2 step(s) — ["make past tense", "remove pronouns"]
TransformBlank P2 APPLY step 1/2 (412ms): "I ran to the store and I bought milk"
TransformBlank P2 APPLY step 2/2 (380ms): "ran to the store and bought milk"
```

Generative branch shows a different line:

```
TransformBlank: GENERATIVE branch (instruction with no target)
TransformBlank P2 GENERATIVE (724ms, max_tokens=768): "Crimson leaves drift down..."
TransformBlank: GENERATIVE done (1156ms total) — final="Crimson leaves drift down..."
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

## Latency breakdown

| Phase | Typical | Outlier |
|---|---|---|
| P1 EXTRACT | 300-700ms | 2000ms |
| P2 APPLY | 250-800ms | 1600ms (long inputs) |
| P3 VERIFY | 300-1000ms | 1700ms |
| P3 SKIPPED | 0ms | — |
| Substitution | 60ms | — |

| Scenario | Total |
|---|---|
| Best case — literal swap (skip VERIFY), `_` just typed | ~600ms |
| **Typical** — non-literal transform | **~1.4s** |
| Generative (no VERIFY) | ~800-1200ms |
| Long-input transform (700+ chars) | ~2-3.5s |
| `_` not at trailing edge | + 500ms debounce |

---

## Architecture references

For the canonical implementation reference (3-pass design rationale,
prompt design, parser quirks, runtime integration, all the
experiments) see **`docs/architecture/transform-blank.md`**.

Quick locator:
- **Source**: `packages/opencues-core/src/sources/transform-blank-source.ts`
- **Wire-up**: `packages/opencues-core/src/sources/build-sources.ts` (option
  `enableTransformBlank`, gated on `transform-blank-mode: on`)
- **Substitution**: `packages/opencues-runtime/src/modules/resolver.ts`
  (search for `isTransformBlank`)
- **Benchmark**: `tests/benchmarks/transform-blank/` — run via
  `GROQ_API_KEY=… npx tsx tests/benchmarks/transform-blank/prod.ts
  --mode 3-pass --parallel 8` (or `--mode fused` with `CEREBRAS_API_KEY`).
  `prod.ts` drives the production source — no bench-local prompt copy.
- **Experiments + design decisions**:
  `tests/benchmarks/transform-blank/EXPERIMENTS.md` — strategy
  comparison, prompt ablation, dynamic max_tokens, skip-VERIFY rule
  tuning
- **Priority chain**: BlankSource (95) > TransformBlankSource (93) >
  FluidBlankSource (92) > shipped spelling cue (80, ConfigSource)

---

## Known limits

- **Multi-paragraph >200 words untested.** Current cases top out at ~150
  words. Latency may exceed 2s on long inputs.
- **Conditional with paragraph-specific scope** ("only in the first
  paragraph") is hit-and-miss because the model needs to reason about
  paragraph boundaries while applying the edit.
- **Context-referring "match the style of X"** is the weakest category
  (50-70%) — open-ended style transfer is at the edge of the model's
  one-shot capacity.
- **Subjective register shifts** ("make it more confident", "make it
  sincere") often produce minimal-effort outputs (just appending "!"
  or "Oh,"). Pass rate hovers at 30-60% on tone-shift tasks.
- **No streaming.** The rewrite arrives all at once after ~1.4s.
- **No multi-span linked highlighting.** The runtime treats the whole
  rewrite as one block replacement. A future enhancement would diff
  the rewrite against the original and highlight individual word
  changes as linked spans.
