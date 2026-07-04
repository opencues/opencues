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
source. (The fused prompt is also trained on the inverted layout
`<INSTRUCTION> _ <TARGET>` so a pasted snippet shaped that way still
parses, but you can't get there by typing.)

---

## How it works

A single fused LLM call (~700ms–1.4s end-to-end on Groq gpt-oss-120b)
that classifies and rewrites in one pass. The `FUSED_SYSTEM` prompt
emits four labelled lines:

```
VERDICT:        TRANSFORM | NONE | TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW
INSTRUCTION:    the imperative phrase (_ removed), or empty
TARGET:         the body the instruction operates on, or empty
FULL_REWRITE:   the ENTIRE final buffer — instruction phrase + _ removed,
                everything else preserved verbatim or transformed per the
                instruction. Empty for NONE / TASK_* verdicts.
```

- **Classification + rewrite happen together.** The same call decides
  whether the input is a real transform (`VERDICT: TRANSFORM`), a bail
  (`NONE` — e.g. `capital of france _`), or an agent-task command
  (`TASK_*`), and — when it's a transform — emits the full rewritten
  buffer in `FULL_REWRITE`.
- **Composed "X and Y" instructions** pipe-join in `INSTRUCTION`
  (`make past tense | remove pronouns`) and are applied together in the
  one `FULL_REWRITE`.
- **EMPTY target → generative.** `VERDICT: TRANSFORM` with an empty
  `TARGET` routes to the generative branch (same single call); `write a
  poem _` / `compose an email _` put the generated content in
  `FULL_REWRITE`.

Because `FULL_REWRITE` is the entire final buffer, the runtime folds it
into the live text with a whole-buffer three-way merge against the
original — any hunk overlapping a concurrent user edit is dropped, so
typing during the call is never clobbered.

Returns a single CueResult with:
- `alternatives = [originalFullText, rewrittenText]`
- `spanStart = 0, spanEnd = text.length`

The runtime auto-substitutes the rewrite (currentIndex=1). Cycle Down
to revert to the original instruction-plus-target. The blank is locked
against re-resolution (`blankName = 'transform-blank'`) so the LLM
won't be re-triggered on the rewritten text.

---

## What kinds of instructions work

The benchmark has grown since this doc was first written — 212 cases
across 18 categories originally, expanded to **487 cases across 19
categories** as of the 2026-07 suite (`tests/benchmarks/transform-blank/cases.ts`
+ `cases-expansion.ts`). Overall pass rate ~83% on gpt-oss-120b
(`tests/results/gemma-benchmark-2026-07-01/FINDINGS.md`), ~1.4s per
case end-to-end on Groq gpt-oss-120b.

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

When the instruction has no target text to operate on, the fused call
routes to its generative branch:

```
write a poem _                              → a poem
compose an email asking for a meeting _     → email body
give me 5 startup ideas _                   → numbered list
draft a thank you note for an interview _   → letter
write a tweet announcing a product launch _ → tweet
```

Latency is ~700-1200ms. The generated content lands in `FULL_REWRITE`
and is the rewrite; cycle Down to revert to the original instruction
text.

---

## Debugging

With `debug-mode: on` the runtime emits a trace for the fused call to
`/tmp/opencues.log`:

```
TransformBlank: starting (textLen=42, blankIdx=4)
TransformBlank FUSED (351ms, max_tokens=820, source=trailing): verdict=TRANSFORM, instruction="change boy to girl", target="the boy ran fast", rewrite="the girl ran fast"
TransformBlank: substituting "the boy ran fast change boy to girl _" → "the girl ran fast" (origLen=42, rewriteLen=18, defAt=0)
```

Composed instructions show the pipe-joined instruction in the same
line:

```
TransformBlank FUSED (412ms, max_tokens=820, source=trailing): verdict=TRANSFORM, instruction="make past tense | remove pronouns", target="I run to the store and I buy milk", rewrite="ran to the store and bought milk"
```

The generative branch shows an empty target:

```
TransformBlank FUSED (724ms, max_tokens=820, source=trailing): verdict=TRANSFORM, instruction="write a poem about autumn", target="", rewrite="Crimson leaves drift down..."
```

Agent-task commands log the TASK branch (FULL_REWRITE empty):

```
TransformBlank FUSED: TASK branch (TASK_ARM, instruction="add a closing paragraph")
```

A `NONE` verdict on a long buffer is not trusted (the bail might be
budget-pressure under truncation), so the source cedes:

```
TransformBlank FUSED: verdict=NONE on a long buffer (812 chars) — not trusting it; ceding
```

---

## Latency breakdown

| Phase | Typical | Outlier |
|---|---|---|
| Fused call | 300-1000ms | 2000ms (long inputs) |
| Substitution | 60ms | — |

| Scenario | Total |
|---|---|
| Best case — literal swap, `_` just typed | ~600ms |
| **Typical** — non-literal transform | **~700ms-1.4s** |
| Generative | ~800-1200ms |
| Long-input transform (700+ chars) | ~2-3.5s |
| `_` not at trailing edge | + 500ms debounce |

---

## Architecture references

For the canonical implementation reference (single-fused-call design
rationale, prompt design, parser quirks, runtime integration, all the
experiments) see **`docs/architecture/transform-blank.md`**.

Quick locator:
- **Source**: `packages/opencues-core/src/sources/transform-blank-source.ts`
- **Wire-up**: `packages/opencues-core/src/sources/build-sources.ts` (option
  `enableTransformBlank`, gated on `transform-blank-mode: on`)
- **Substitution**: `packages/opencues-runtime/src/modules/resolver.ts`
  (search for `isTransformBlank`)
- **Benchmark**: `tests/benchmarks/transform-blank/` — run via
  `CEREBRAS_API_KEY=… npx tsx tests/benchmarks/transform-blank/prod.ts
  --provider cerebras` (or `--provider groq` with `GROQ_API_KEY`).
  `prod.ts` drives the production source — no bench-local prompt copy.
- **Experiments + design decisions**:
  `tests/benchmarks/transform-blank/EXPERIMENTS.md` — strategy
  comparison, prompt ablation, dynamic max_tokens, and the Experiment 10
  retirement of the old 3-pass pipeline
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
