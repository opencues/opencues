# Transform-Blank — Implementation Reference

This is the canonical reference for the **transform-blank** system: the
LLM-driven pipeline that catches imperative instructions placed next to
`_` and rewrites the surrounding text. It's a cornerstone mechanic for
OpenCues — alongside `BlankSource` (keyword-bound blanks) and
`FluidBlankSource` (free-form lookup blanks), `TransformBlankSource`
makes `_` a *universal interaction handle* rather than just a slot to
fill.

If you're touching the prompts, debugging an edge case, or porting the
pipeline to a different host — start here.

Companion docs:
- **`docs/features/transform-blank.md`** — user-facing reference
  (what to type, expected behaviour, settings)
- **`tests/benchmarks/transform-blank/EXPERIMENTS.md`** — experiment log
  with all the alternative-architecture tests we ran and their results
- **`docs/architecture/spans-and-cycling.md`** — how the runtime
  handles the substitution + cycling once the rewrite arrives

---

## The problem

OpenCues has had two `_` handlers:

| Source | Trigger | Example |
|---|---|---|
| `BlankSource` (priority 95) | `_` near a registered keyword | `volume _` → reads system volume |
| `FluidBlankSource` (priority 92) | `_` next to a lookup phrase | `capital of france _` → "Paris" |

Both are **interrogative** — the user is asking a question, the system
substitutes an answer at `_`. But people often want the opposite:
**imperative** — they want to *edit* the text around `_` per an
instruction.

```
You type:   change boy to girl _ the boy ran fast
You see:    the girl ran fast
```

That's transform-blank. The instruction is the imperative phrase next
to `_`, the surrounding text is the target, and the rewrite replaces
the whole region.

---

## The user model

`TransformBlankSource` (priority 93) sits **above** `FluidBlankSource`
(92) and **below** `BlankSource` (95) in the priority chain. So:

```
Priority chain (highest first):
  95  BlankSource          ← keyword-bound (volume, brightness, ...)
  93  TransformBlankSource ← NEW: imperative instructions
  92  FluidBlankSource     ← free-form lookups
  80  SpellingSource       ← misspelled words on plain text
```

When the user types `_`, all sources whose `supports()` returns true
race in parallel. The highest-priority result wins via the resolver's
priority-merge step.

`TransformBlankSource.supports()` always returns `true` for any input
containing `_` (after ceding to keyword-bound `BlankSource`). EXTRACT —
the first LLM call — is the authoritative classifier. If the input
isn't actually a transform-shaped imperative, EXTRACT returns
`VERDICT: NONE` and the source bails with empty results, letting
`FluidBlankSource` (priority 92) take the slot.

This was a deliberate architectural choice. We initially used a
keyword/regex heuristic in `supports()` to avoid the extra LLM call on
non-transform inputs, but it was brittle ("full caps all words" didn't
match any obvious imperative verb). The cost of one EXTRACT call per
non-transform `_` is ~400ms, which is acceptable for the cleanliness
gain.

### Two layouts the user can type

Both work — the EXTRACT prompt is trained on both:

```
(a) <INSTRUCTION> _ <TARGET>
    e.g.  change boy to girl _ the boy ran fast

(b) <TARGET> <INSTRUCTION> _
    e.g.  the boy ran fast change boy to girl _
```

Real users mostly do (b) — they type their text first, then realize
they want to transform it, and add the imperative at the end. (a) is
more common when a user is dictating an imperative they've already
formulated.

---

## Pipeline architecture (the 3-pass design)

```
INPUT → EXTRACT → APPLY → VERIFY → SUBSTITUTE
        (P1)      (P2)     (P3)
        LLM       LLM(s)   LLM     code
        ~400ms    ~500ms   ~600ms  ~10ms
```

Total: ~1.4-1.6s per blank in production, dominated by sequential LLM
latency. At `parallel=8` in the benchmark, throughput is ~5 cases/sec.

### Why 3 passes and not 1

This was the central design decision. We tested:

| Architecture | Accuracy | Per-case latency |
|---|---|---|
| Single-call (all in one prompt) | 19% | 0.5s |
| 1-pass rewrite | 46% | 0.6s |
| 2-pass extract → apply | 83% | 1.1s |
| **3-pass extract → apply → verify** | **86-90%** | **1.4-1.7s** |

Single-call is broken because the model can't juggle "is this a
transform?" + "extract instruction + target" + "apply the transform" +
"check consistency" simultaneously. It scored 0% on conditional,
context-referring, and trailing-instruction (the categories that need
sophisticated EXTRACT). It even returned `VERDICT: TRANSFORM | NONE`
literally on a pluralize case — confused enough to echo the placeholder.

The 3-pass split is the same architectural insight that made the
2-pass `FluidBlankSource` work: **narrow jobs are easier than wide
jobs**. P1's only question is "is this an imperative? if so, what's
the instruction and what's the target?" P2 only does the rewrite —
no decisions about validity. P3 only checks for consistency bugs —
never re-litigates whether to fire.

This recursive structure (split a pipeline into single-purpose phases)
is the cornerstone pattern for OpenCues' LLM-orchestration code.
See `tests/benchmarks/transform-blank/EXPERIMENTS.md`, "Experiment 1"
for the full strategy comparison.

---

## P1 — EXTRACT

**Job:** decide whether the input carries an imperative instruction. If
yes, split the input into `instruction` and `target`. If no, bail with
`VERDICT: NONE`.

**Output format:**
```
VERDICT: TRANSFORM | NONE
INSTRUCTION: <imperative phrase, _ removed; or empty>
TARGET: <text the instruction should apply to; or empty>
```

### Why minimal prompts win here (Experiment 2)

The first version of EXTRACT had ~200 lines of rules and 18 examples
covering every layout, conditional shape, context-referring shape,
etc. Stripping it to a single semantic question and 4 layout-spanning
examples improved accuracy from 83% to 88-90% (Experiment 2).

Mechanism: the verbose prompt enumerated 10+ imperative shapes. The
model treated this list as an *exclusionary filter* — bailing to NONE
on borderline imperatives that didn't match a listed shape. The
minimal prompt asks ONE semantic question and the model answers it
more accurately than pattern-matching against an enumerated list.

The current production prompt is in
`packages/opencues-core/src/sources/transform-blank-source.ts`,
constant `P1_EXTRACT_SYSTEM`. It contains:

- One paragraph defining what an "imperative instruction" is
- The two-line output format spec
- A note about the two layouts (a/b)
- A note about composed instructions ("X and Y" → pipe-joined)
- A NONE-rule list (bail conditions)
- 5 carefully-chosen examples covering both layouts + composed + NONE

**Don't add more examples.** Each addition risks pushing the model
back into pattern-matching mode. Add only when a concrete production
failure shows the model needs the example.

### Composed instructions

When the imperative joins two transforms with "and"
("make past tense and remove pronouns"), EXTRACT outputs them
**pipe-joined** in `INSTRUCTION`:

```
INSTRUCTION: make past tense | remove pronouns
```

The pipe is the wire format that signals "run APPLY twice, sequentially,
output of N feeds target of N+1". This was Experiment 3's main
architectural change — see "Sequential composition" below in the APPLY
section.

The "would each half stand alone?" guard lives in the prompt as the
test for whether to split. The model rarely violates it on the 162-case
suite.

### Parser quirks

The output is line-based, parsed by regex:

```ts
const verdictMatch     = raw.match(/^VERDICT:[ \t]*(TRANSFORM|NONE)[ \t]*$/im);
const instructionMatch = raw.match(/^INSTRUCTION:[ \t]*(.*?)[ \t]*$/im);
const targetMatch      = raw.match(/TARGET:[ \t]*([\s\S]*?)\s*$/i);
```

**Two non-obvious bug fixes** baked in:

1. **`[ \t]*` not `\s*`** for single-line fields (VERDICT, INSTRUCTION).
   Production bug: model emitted

   ```
   VERDICT: NONE
   INSTRUCTION:
   TARGET:
   ```

   The `\s*` matched the newline AND the next line's "TARGET:" text,
   so the lazy `.*?` extended across lines and captured `TARGET:` as
   the instruction value. Trace showed
   `verdict=NONE, instruction="TARGET:"` — pure noise. Fixed by using
   `[ \t]*` (horizontal whitespace only).

2. **TARGET drops the `m` flag** because it can span multiple
   paragraphs (multi-paragraph rewrites). With `m`, `$` matches at
   end of each line and lazy `[\s\S]*?` stops at the first newline,
   truncating multi-paragraph TARGETs to one line. Multi-paragraph
   accuracy went from 0% → 80% with this fix alone.

### Dynamic max_tokens

Each EXTRACT call computes its own `max_tokens` budget from the input
length:

```
budget = max(FLOOR=768, ceil(input_chars / 3) + REASONING_HEADROOM=400)
```

- **FLOOR=768** is a hard minimum to ensure room for both
  `reasoning_effort: 'low'` reasoning tokens AND a short structured
  output. An earlier version used FLOOR=128 — long-text cases
  truncated mid-output and accuracy dropped 85% → 50%. Lesson: when
  using `reasoning_effort`, you need to reserve room for BOTH
  reasoning + output, and the safe floor is bigger than the output
  alone would suggest.
- **`input_chars / 3`** estimates output tokens (TARGET echoes most
  of the input back; rough char-to-token of 3).
- **CEILING=4096** caps multi-paragraph rewrites.

The previous flat `2048` budget was wasting 50-200ms per call on Groq
via higher TTFT and longer planning overhead.

---

## P2 — APPLY

**Job:** execute the instruction on the target. Pure rewrite — no
decisions about validity (P1 already gated that).

**Output format:**
```
REWRITE: <rewritten target>
```

### Why APPLY's verbose rules ARE load-bearing

Experiment 2 stripped APPLY to minimal rules — accuracy DROPPED from
83% to 81% AND latency went UP from 1729ms → 1938ms per case. The
model thinks harder without explicit guidance. APPLY's rules carry
real semantic load and should NOT be pruned.

The current ruleset (in `P2_APPLY_SYSTEM`):

1. Apply to ALL applicable spans (not just the first)
2. Preserve everything not targeted (other words, punctuation, casing)
3. Pick a consistent interpretation when ambiguous
4. Output only the rewritten target — no instruction, no commentary
5. **CONCEPT-SWAP PROPAGATION** — when the instruction names a CATEGORY
   (pet, vehicle, profession, era, etc.) update verbs, sounds, objects,
   properties to match. Cats meow not bark; cars use seatbelts not
   helmets; teachers assign homework not prescribe medicine.
6. **ROLE PRESERVATION** — when modifying SOME numbers but the target
   labels them with roles ("original price 100, final price 100"),
   update only the role the instruction names.
7. **COMPOSED INSTRUCTIONS** — apply both transforms; result must be
   grammatical under both constraints simultaneously.
8. **PRESERVE STRUCTURE** — `\n\n` paragraph breaks must round-trip
   verbatim. Multi-paragraph in → multi-paragraph out.
9. **CONDITIONAL INSTRUCTIONS** — "X but not Y", "X except Y",
   "X only when Z" — apply only where the condition holds.

Plus ~25 worked examples covering each rule. Examples are the
load-bearing part for APPLY (unlike EXTRACT, where they hurt).

### Sequential composition for "X and Y" instructions

When EXTRACT pipe-joins ("X | Y"), the resolver runs APPLY twice — the
output of step 1 becomes the target of step 2:

```
EXTRACT → INSTRUCTION: pluralize | make past tense
          TARGET: the child runs to the park

APPLY 1 → ("pluralize", "the child runs to the park")
       → "the children run to the parks"

APPLY 2 → ("make past tense", "the children run to the parks")
       → "the children ran to the parks"

VERIFY  → ("pluralize and make past tense", original_target, "the children ran to the parks")
```

VERIFY sees the **original** ("X and Y") form, not the pipe-joined
form, so it can check both transforms were applied to the correct
starting text.

This was Experiment 3's main win. Asking ONE APPLY call to do
"pluralize AND make past tense" simultaneously dropped to 47%. Splitting
into two sequential APPLY calls jumped to 73%. The model handles ONE
transform at a time much better than two — same "narrow jobs" insight
as the 3-pass split.

### Garbled output — soft-fail Groq parse errors

Sometimes Groq returns a parse error mid-completion:

```json
{"error": {"message": "Parsing failed. The model generated output that could not be parsed..."}}
```

We swallow these in the Groq client and return empty text. Caller's
parser treats empty as a bail. One bad response shouldn't kill a
50-case benchmark or ruin a user's session.

---

## P3 — VERIFY

**Job:** check the draft for AGREEMENT, COVERAGE, STRUCTURAL
COMPLETENESS, and CONCEPT-SWAP PROPAGATION bugs. Either pass through
(`VERDICT: OK`) or emit a corrected rewrite (`VERDICT: REPAIR`).

**Output format:**
```
VERDICT: OK | REPAIR
REWRITE: <DRAFT verbatim when OK; corrected rewrite when REPAIR>
```

**Authority is narrow:** P3 NEVER bails to NONE. P1 already decided
this is a valid transform; P3 only repairs the rewrite.

### When VERIFY actually catches things

The four checks (each with worked examples in the prompt):

1. **AGREEMENT** — when an edit changes number/tense/case, dependent
   words must follow. "they is" → "they are"; "one mice" → "mice".
2. **COVERAGE** — edit applied to ALL applicable spans, not just the
   first. "the boy and the boy" → both should change.
3. **STRUCTURAL COMPLETENESS** — restructuring instructions actually
   restructure. "make it a question" must produce a real question, not
   just append "?".
4. **CONCEPT-SWAP PROPAGATION** — for category swaps, dependent
   vocabulary updates. Cats don't bark; cars don't use helmets.

### "Default to OK" is critical

VERIFY's biggest failure mode used to be **over-editing already-correct
drafts**. APPLY would produce a clean rewrite, VERIFY would decide it
could rephrase it more elegantly, and the "improved" rewrite was often
wrong (added prose, changed valid word choices, mangled the structure
mid-paragraph).

Prompt fix: "DEFAULT TO OK. Only output REPAIR when you can name a
SPECIFIC, IDENTIFIABLE defect. If the draft looks fine — even if you
could rephrase it more elegantly — output OK and pass it through.
Stylistic improvement is NOT your job. You are a defect catcher, not
a writer."

Plus a section on AMBIGUOUS INSTRUCTIONS:
"`capitalize all words` can mean Title Case OR ALL CAPS. When the
DRAFT picks ONE valid interpretation, ACCEPT IT. Do NOT REPAIR just
because YOU would have interpreted differently."

This single rule prevented a class of regressions where APPLY's valid
output got reverted to a different valid output by VERIFY.

### OK passthrough — code-level safety net

Even with the prompt rule, VERIFY occasionally emits a slightly
different rewrite when verdict is OK (model adds a period, swaps
"the" for "a", etc.). The runtime ignores this:

```ts
finalRewrite = ver.verdict === 'OK' ? draft : ver.rewrite;
```

When VERIFY says OK, we pass through the draft, NOT verify's echo.
This caught real production drift where a perfectly valid
"the colour of the harbour is grey" got OK'd but verify echoed
"the colour of the harbour" (truncated).

### Garbled-repair safety net

When `VERDICT: REPAIR` fires, the rewrite sometimes comes back garbled —
not truncated (length check would catch that) but full of separator
dashes, ellipsis-of-omission, zero-width chars, or stray "END" markers.
The model is going off the rails mid-output.

```ts
function repairLooksGarbled(repair: string): boolean {
  if (/[ \t]{4,}/.test(repair)) return true;        // whitespace runs
  if (/[\u200B-\u200F\uFEFF\u2028\u2029]/.test(repair)) return true; // hidden chars
  if (/\.{3,}\s*\S/.test(repair)) return true;       // mid-sentence ASCII ellipsis
  if (/…/.test(repair)) return true;                 // U+2026 ellipsis
  const dashes = repair.match(/[‑–—]/g) ?? [];
  if (dashes.length >= 3) return true;               // separator dashes
  if (/\?END\?|END\?\s*END|END\s+END/.test(repair)) return true;
  return false;
}
```

Plus a length check (`repair.length < 0.5 × draft.length AND <
0.5 × target.length`). When either trips, fall back to the draft.

This safety net was added after a real production case mangled a
multi-paragraph BrE rewrite into:
```
the colour of the harbour — the grey ‑ the walk ‑ the pav ‑ the theatre ‑ ...
```
The dashes-as-separators pattern is the model losing its place. The
safety net catches it; the user gets the (correct) draft instead.

### Smart skip-VERIFY

VERIFY is the slowest single phase (~600-1500ms per call). For some
input types, it almost never fires REPAIR — running it is pure
latency cost.

We tested 5 skip-rule variants in Experiment 4:

| Variant | Accuracy | Per-case |
|---|---|---|
| skip-never (always run) | 81.6% | 1477ms |
| **skip-conservative (DEPLOYED)** | **81.1%** | **1290ms** |
| skip-current (broader rules) | 78.8% | 1390ms |
| skip-aggressive (any single-instr ±10%) | 80.7% | 1387ms |
| skip-always (any single-instr) | 77.4% | 1225ms |

`skip-conservative` is essentially free — 0.5pp accuracy delta is
within noise, but −13% per-case latency is real. The current rules:

Skip VERIFY when ALL hold:
- draft length within ±15% of target length
- no `\n\n` in target/draft (multi-paragraph needs verify)
- single instruction (no `|` — composed needs verify for cross-step
  agreement)
- instruction matches one of:
  - **literal swap**: `change|replace|swap|rename A to|with|for B`
  - **BrE↔AmE**: `make it (british|american) english`

Adding case changes or simple tense to this list (the previous
deployment) HURT accuracy by 2.3pp because case has ambiguous
interpretations VERIFY catches and simple tense triggers
concept-swap propagation gaps when target nouns hint at a category
swap.

**Lesson** documented in EXPERIMENTS.md, Experiment 4: skip-rules
need a **semantic gate** ("is the instruction MECHANICALLY
unambiguous"), not just structural ones (length ratio, paragraph
count). Even short single-line outputs can have agreement bugs that
VERIFY catches.

---

## Runtime integration

### File layout

```
packages/opencues-core/src/sources/transform-blank-source.ts
  ↳ TransformBlankSource (CueSource)
  ↳ Prompts (P1/P2/P3 system prompts inlined as constants)
  ↳ Parsers
  ↳ Skip-VERIFY heuristic
  ↳ Garbled-repair safety net
  ↳ Dynamic max_tokens (budgetForOutput)

packages/opencues-core/src/sources/build-sources.ts
  ↳ enableTransformBlank flag (option to buildSourcesFromConfig)
  ↳ Constructs TransformBlankSource at priority 93

packages/opencues-runtime/src/modules/resolver.ts
  ↳ Reads opencues.md `transform-blank-mode` setting
  ↳ Passes adapter.log → source's `log` callback (debug-mode trace)
  ↳ Inline-substitute branch on `r.source === 'transform-blank'`
  ↳ Builds WordDef with alternatives = [originalText, rewrittenText]
```

### CueResult shape

```ts
{
  wordIndex: blankIdx,
  word: '_',
  alternatives: [originalFullText, rewrittenText],
  source: 'transform-blank',
  priority: 93,
  spanStart: 0,
  spanEnd: context.text.length,    // entire input region
  metadata: {
    transformInstruction: <pipe-joined or single>,
    transformTarget:      <original target>,
    verifyVerdict:        <'OK' | 'REPAIR'>,
  },
}
```

`alternatives[0]` is the original input (so cycling Down restores it).
`alternatives[1]` is the rewrite (the magic). `spanStart=0,
spanEnd=text.length` covers the entire input — the runtime replaces
everything with the rewrite when applying.

### Substitution

In `packages/opencues-runtime/src/modules/resolver.ts`, the inline-
substitute branch (mirrored from FluidBlank):

1. Race-guard: if `liveText !== originalText`, another module touched
   the text — skip with a "skipping — live text changed since resolve"
   log.
2. Compute `newWords = splitWords(rewrittenText)`. Key the WordDef at
   `newWords[0].index` so cycling targets the right position in the
   new text.
3. Build a WordDef with `currentIndex=1` (showing the rewrite) and
   `blankName='transform-blank'` (locks against re-resolution by
   subsequent LLM passes — same mechanism FluidBlank uses).
4. Call `adapter.pushText(rewrittenText, newCursor)` — atomic
   text-and-cursor update. Falls back to `setText` + `setCursorOffset`
   + `forceRender` for hosts without pushText.
5. Log: `TransformBlank: substituting "originalText…" → "rewrittenText…"
   (origLen=…, rewriteLen=…, defAt=…)`.

### Cycling

Cycling is delegated to the runtime's existing `WordDef`/`DynDefs`
machinery. With `currentIndex=1` (showing rewrite), cycling Down sets
`currentIndex=0` and replaces the span with `alternatives[0]` (the
original input including the instruction phrase). Cycling Up wraps
back to `1`.

The `blankName='transform-blank'` field prevents the resolver from
re-firing on the rewrite text — same lock that prevents FluidBlank's
answer from being clobbered by RoutedWordSourceGroup synonyms.

---

## Configuration

### opencues.md settings

```yaml
transform-blank-mode: on    # required to enable TransformBlankSource
debug-mode: on              # surfaces per-pipeline-stage logs (recommended)
```

Hot-reload picks up changes — no restart needed. Both settings are
declared in `packages/opencues-cli/src/templates/opencues.md` so
`opencues seed-configs` lays them out for new users with
`transform-blank-mode: off` as the default (opt-in).

The selector/satellite UI also surfaces them via the matching
`settings:` block entry — typing `config _` and cycling lets users
toggle them without editing the file.

### Tunables (in source code)

```ts
// transform-blank-source.ts

budgetForOutput(expectedChars, multiplier)
  FLOOR              = 768   // reasoning + short output headroom
  REASONING_HEADROOM = 400   // covers reasoning_effort: 'low'
  CEILING            = 4096  // caps multi-paragraph rewrites

shouldSkipVerify(instruction, target, draft)
  Length window     = ±15% of target
  Filtered patterns = literal swap, BrE↔AmE only
```

Don't ship tunables to users via opencues.md — they're fragile and
the right values are determined by benchmarks, not preference.

---

## Debugging

### Debug log trace

With `debug-mode: on`, every pipeline stage emits a structured log:

```
TransformBlank: starting (textLen=42, blankIdx=4)
TransformBlank P1 EXTRACT (351ms, max_tokens=820): verdict=TRANSFORM, instruction="change boy to girl", target="the boy ran fast"
TransformBlank P2 APPLY: 1 step(s) — ["change boy to girl"]
TransformBlank P2 APPLY step 1/1 (227ms, max_tokens=812): "the girl ran fast"
TransformBlank P3 VERIFY: SKIPPED (low-stakes instruction + faithful draft)
TransformBlank: pipeline done (578ms total) — final="the girl ran fast"
TransformBlank: substituting "change boy to girl _ the boy ran fast" → "the girl ran fast" (origLen=42, rewriteLen=18, defAt=0)
```

Each log line maps to a code location in `transform-blank-source.ts`
(`this.log(...)` calls). The log function is wired in
`resolver.ts:rebuildResolver` as
`(msg) => this.adapter.log('debug', msg)`, gated by `debug-mode`.

### Diagnosing common failures

| Symptom in trace | Likely cause | Fix |
|---|---|---|
| `verdict=NONE, instruction=""` | Real NONE — input isn't a transform | None needed (FluidBlank takes over) |
| `verdict=NONE, instruction="TARGET:"` | Parser bug (regex swallowing newlines) | Should be fixed; if recurring see commit ac7f79d |
| `verdict=TRANSFORM, target=""` | Layout (b) parsing issue — instruction at end with leading text the model thinks is also instruction | Add a similar-shape example to EXTRACT prompt |
| `APPLY step 1 returned empty` | Model bailed mid-output or rate-limited | Check Groq dashboard for TPM cap |
| `REPAIR rejected (truncated=…, garbled=…)` | Safety net working as designed | None — VERIFY produced bad repair, fell back to draft |
| `skipping — live text changed since resolve` | Race with another module; rare | None — substitution skipped to avoid clobbering |
| Long latency (>5s) per call | Model in deep reasoning loop | Check if `reasoning_effort` setting changed |

---

## The benchmark suite

`tests/benchmarks/transform-blank/` has the empirical foundation for
every design decision in this document.

### Suite scope

**212 cases across 18 categories:**
```
literal              10  multi-span      10  concept              10
transform            12  negative        10  math                 10
linked-concepts      10  long-text       40  targeted             10
multi-paragraph      10  conditional     10  context-referring    10
trailing-instruction 10  code-transform  10  tone-shift           10
format-transform     10  creative-rewrite 10 adversarial          10
```

Each case has:
- `input`: the full text the user typed (with `_`)
- `expected.finalText`: canonical correct rewrite
- `expected.finalTextAlternates`: optional acceptable variants
- `expected.shouldFailSoft`: when present, the case should bail (NONE)

Per-case judgment uses an LLM-as-judge (`judge.ts`) that compares the
actual output against expected + alternates with semantic equivalence,
plus exact-match short-circuits.

### Modes

```bash
GROQ_API_KEY=… npx tsx tests/benchmarks/transform-blank/run.ts \
  --mode <mode> --parallel 8 [--category <cat>] [--case <id>]
```

| Mode | Description |
|---|---|
| `extract-apply-verify` | Production 3-pass (with skip-conservative) |
| `extract-apply` | 2-pass (no VERIFY) |
| `rewrite` | 1-pass single prompt (legacy, ~46% accuracy) |
| `single-call` | Combine all 3 prompts into one (~19% accuracy) |
| `extract-apply-verify-skip-easy` | Original "skip on literal swap" rule (deprecated) |
| `minimal-extract` | Use minimal EXTRACT prompt (Experiment 2 winner) |
| `minimal-apply` / `minimal-verify` / `minimal-all` | Ablation variants |
| `skip-never` / `skip-conservative` / `skip-current` / `skip-aggressive` / `skip-always` | Skip-VERIFY rule variants (Experiment 4) |

### Parallelism

The benchmark runner has `--parallel N` for concurrent case execution
via worker pool. Per-case output stays sequential because workers write
to original-index slots; printed after all workers finish.

Groq's free tier hits a 250k TPM rate limit if you fan out 5 variants
× 8 cases × 3 LLM calls simultaneously. For multi-mode comparisons,
run modes sequentially (one process at a time) with `parallel=8`
internally. ~40s wall per mode.

---

## Lessons learned

A condensed set of insights from the experiment log. Each is backed
by an experiment in `EXPERIMENTS.md`.

1. **Narrow jobs >> wide jobs.** The 3-pass split outperforms
   single-call by ~70 percentage points. Even with the same model and
   total token budget, splitting "is this a transform / what's the
   instruction / apply it / check it" into separate prompts gets
   dramatically better results than asking one prompt to do all four.

2. **Sequential composition for multi-step transforms.** Asking ONE
   APPLY call to "pluralize AND make past tense" hurts. Splitting
   into two sequential calls (EXTRACT pipe-joins, APPLY runs N times)
   is the same insight at one level deeper.

3. **Minimal prompts win at classification, verbose prompts win at
   execution.** EXTRACT got 7 percentage points better when stripped
   to one semantic question. APPLY got 2 percentage points worse and
   200ms slower when stripped. The difference: classification benefits
   from openness; execution benefits from explicit rules.

4. **Reserve reasoning headroom in max_tokens budgets.** When using
   `reasoning_effort: 'low'`, a too-tight max_tokens truncates the
   model mid-output (it ran out of budget partway through emitting).
   FLOOR=768 is the safe minimum for short outputs, even if the
   actual output is 50 tokens.

5. **Single-line field parsers should use `[ \t]*` not `\s*`.** `\s*`
   matches newlines, which lets a lazy `.*?` accidentally capture the
   next field's label as the current field's value. Use horizontal-
   whitespace-only.

6. **Skip-rules need semantic gates, not structural ones.** A rule
   like "skip VERIFY when output length is ±15% of input" misses the
   point — even short single-line outputs can have agreement bugs.
   The right axis is "is the instruction MECHANICALLY unambiguous"
   (literal swap, deterministic spelling change).

7. **VERIFY as defect catcher, not stylist.** Without an explicit
   "default to OK, only repair NAMED defects" rule, VERIFY was
   over-editing valid drafts (replacing "charged" with "cast a spell at"
   on a knight→wizard swap). The defect-catcher framing is the most
   important sentence in the VERIFY prompt.

8. **Always-claim + LLM-as-classifier beats heuristic gating.** We
   tried a regex/keyword heuristic in `supports()` to avoid extra
   LLM calls. It was brittle (missed "full caps", "fullcaps",
   `make me a website` was wrongly classified). Always claiming +
   letting EXTRACT decide via NONE bail is cleaner — the cost is
   one extra ~400ms call per non-transform `_`.

9. **Soft-fail Groq parse errors and rate limits.** One bad response
   shouldn't kill a batch run or a user session. Catch in the client,
   return empty, let the caller's parser treat it as a bail.

10. **Document each design decision with the experiment that justifies
    it.** When the next person (or future-you) asks "why didn't we
    just do X?", the answer should be `tests/benchmarks/transform-blank/EXPERIMENTS.md,
    Experiment N`.

---

## Known limits

- **Multi-paragraph >200 words untested.** The longest cases in the
  benchmark are ~150 words. Latency may exceed 2s on long inputs;
  EXTRACT's max_tokens scales but reasoning could still bottleneck.
- **Subjective register shifts are at the model's edge.** "Make it
  more confident", "make it sincere", "make it more dramatic" — the
  model often produces minimal-effort outputs (just appending "!" or
  "Oh,"). Pass rate hovers at 30-60% on tone-shift tasks, mostly due
  to APPLY weakness, not pipeline design.
- **Conditional with paragraph-specific scope.** "X but only in the
  first paragraph" works ~70% of the time. The model needs to reason
  about paragraph boundaries while applying the edit, which is at the
  edge of its one-shot capacity.
- **Context-referring "match the style of X".** 50-70% pass rate.
  Open-ended style transfer is genuinely hard.
- **No streaming.** The rewrite arrives all at once after ~1.4s.
- **No multi-span linked highlighting.** The runtime treats the whole
  rewrite as one block replacement. A future enhancement would diff
  the rewrite against the original and highlight individual word
  changes as linked spans.

---

## Future directions

Experiments not yet tried (with hypothesized impact):

| Idea | Hypothesis | Where to add |
|---|---|---|
| Smaller model for VERIFY only | Haiku-class could halve VERIFY latency at small accuracy cost | New mode `extract-apply-verify-haiku` |
| Streaming partial APPLY | Show rewrite as it generates instead of waiting; perceived latency cut even if total is the same | Runtime change in `resolver.ts` |
| JSON-output APPLY | Forcing structured output reduces truncation/garbage on long outputs | New prompt + parser variant |
| Parallel APPLY for composed | Trade accuracy for latency on "X and Y" — let both transforms run concurrently and merge | Anti-pattern; the sequential composition was the WIN |
| Linked-spans cycling | Diff rewrite against original; highlight each changed word as a separately-cycleable span | Big runtime change in `dyn-defs.ts` |
| Prompt-cache warmup | First call has cold prompt cache; subsequent should be faster | Groq client change |

When picking the next direction, run the new variant via a
`--mode <name>` flag in `run.ts` rather than mutating the default —
that way the comparison is reproducible and the prior result stays
benchmarkable.

---

*Last updated: May 2026. Authoritative for the production pipeline at
commit `0580880` and beyond.*
