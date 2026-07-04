# Transform-Blank — Implementation Reference

This is the canonical reference for the **transform-blank** system: the
LLM-driven pipeline that catches imperative instructions placed next to
`_` and rewrites the surrounding text. It's a cornerstone mechanic for
OpenCues — alongside `BlankSource` (keyword-bound blanks) and
`FluidBlankSource` (free-form lookup blanks), `TransformBlankSource`
makes `_` a *universal interaction handle* rather than just a slot to
fill.

If you're touching the prompt, debugging an edge case, or porting the
source to a different host — start here.

Companion docs:
- **`docs/features/transform-blank.md`** — user-facing reference
  (what to type, expected behaviour, settings)
- **`tests/benchmarks/transform-blank/EXPERIMENTS.md`** — experiment log
  with all the alternative-architecture tests we ran and their results
- **`docs/architecture/spans-and-cycling.md`** — how the runtime
  handles the substitution + cycling once the rewrite arrives
- **`docs/architecture/blank-sources.md`** — the family of `CueSource`
  classes and the two substitute mechanisms (slot-splice vs
  three-way-merge) the resolver picks between

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
You type:   the boy ran fast change boy to girl _
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
  93  TransformBlankSource ← imperative instructions
  92  FluidBlankSource     ← free-form lookups
  80  spelling cue         ← misspelled words on plain text (defaults/cues/spelling.md, ConfigSource)
```

When the user types `_`, all sources whose `supports()` returns true
race in parallel. The highest-priority result wins via the resolver's
priority-merge step.

`TransformBlankSource.supports()` always returns `true` for any input
containing `_` (after ceding to keyword-bound `BlankSource`). The
**fused LLM call is the authoritative classifier**. If the input isn't
actually a transform-shaped imperative, the call returns
`VERDICT: NONE` and the source bails with empty results, letting
`FluidBlankSource` (priority 92) take the slot.

This was a deliberate architectural choice. We initially used a
keyword/regex heuristic in `supports()` to avoid the extra LLM call on
non-transform inputs, but it was brittle ("full caps all words" didn't
match any obvious imperative verb). The cost of one fused call per
non-transform `_` is acceptable for the cleanliness gain.

### The shape — body first, instruction last

```
<TARGET> <INSTRUCTION> _
e.g.  the boy ran fast change boy to girl _
```

This is the only shape live typing can produce: `_` triggers the
moment you press it, so anything you'd type *after* `_` would never
reach the source. The body has to be in the buffer before `_` lands.

The inverted shape `<INSTRUCTION> _ <TARGET>` exists as a parser
target — the fused prompt is trained on both layouts (plus a
SANDWICHED `<TARGET-PT1> <INSTRUCTION> _ <TARGET-PT2>` layout) so a
pasted snippet, a synthetic bench case, or text you constructed by
editing *back* into the middle of the buffer all still classify
correctly. But that's a paste-or-edit path, not a typing path.
Examples in user-facing docs should use `<TARGET> <INSTRUCTION> _`
exclusively.

---

## Pipeline — single fused call

```
INPUT → FUSED → SUBSTITUTE (three-way merge)
        LLM     code
        ~600ms  ~10ms
```

TransformBlank makes **one** LLM call per blank, on every provider. The
call runs `FUSED_SYSTEM` (a module-scope constant in
`transform-blank-source.ts`), which classifies, extracts the
instruction + target, and produces the rewrite in a single prompt.
`runFusedAndBuild` is the method that issues the call and builds the
`CueResult`.

### The contract

The fused call emits three labelled lines (`FULL_REWRITE` may span
multiple lines):

```
VERDICT: TRANSFORM | NONE | TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW
INSTRUCTION: <the imperative phrase OR task prompt, _ removed; or empty>
FULL_REWRITE: <the ENTIRE final buffer with the instruction applied AND
               the instruction phrase + _ removed. Contains ONLY what the
               user should see. Empty when VERDICT is NONE / TASK_*>
```

> A fourth field, `TARGET:` (≈ the whole buffer echoed back), was emitted
> until June 2026 but was **debug-only** — the resolver merges
> `FULL_REWRITE` against `originalText`, never the LLM's TARGET. It was
> dropped from the output to save tokens: a real ~8% latency win on
> providers without speculative decoding (gemini, groq, …), neutral on
> cerebras (predicted outputs already accepted the echo at input-rate),
> flat accuracy across all three. `TARGET` survives only as a *concept*
> in the rules (it's how the prompt explains what gets edited). See
> EXPERIMENTS.md § Experiment 13. The parser stays tolerant of a stray
> TARGET line for back-compat.

The verdicts split into three branches:

- **`TRANSFORM`** — the imperative path. `FULL_REWRITE` is the entire
  rewritten buffer. If `TARGET` is empty, the **generative branch**
  fired — the input was *only* an instruction (`write a poem _`,
  `compose an email _`, `give me 5 startup ideas _`) and `FULL_REWRITE`
  holds the generated content.
- **`TASK_ARM` / `TASK_ADD` / `TASK_STOP` / `TASK_SHOW`** — the
  agent-task path. `FULL_REWRITE` is empty; the result routes to the
  runtime's agent state machine via `metadata.taskAction` +
  `metadata.taskPayload`. See `docs/architecture/agent-task.md`.
- **`NONE`** — the source bails and `FluidBlankSource` (priority 92)
  takes the slot. **Exception:** a `NONE` on a **long buffer** (>
  `FUSED_NONE_RETRY_FLOOR`, 400 chars) is *not trusted* and the source
  **cedes** (returns `null`) so a later resolve can take a fresh look,
  rather than letting a budget-pressure misfire silently drop the edit.
  Rationale: the fused call emits the entire `FULL_REWRITE` in one
  shot, and cerebras `gpt-oss-120b` intermittently returns
  `VERDICT: NONE` under that output/reasoning-budget pressure even when
  there *is* a trailing imperative (a chained `make it all make sense
  structurally _` on a ~1.3k-char buffer silently did nothing). Short
  NONEs (bare lookups like `capital of france _`) cede unchanged.

### The whole-buffer FULL_REWRITE → three-way-merge

`FULL_REWRITE` is the **entire** rewritten buffer, not a rewritten
slice. The LLM owns the whole buffer; the runtime diffs
`alternatives[0]` (original) against `alternatives[1]` (rewrite) and
**three-way-merges** the change into the live text (`threeWayMerge` in
`packages/opencues-runtime/src/modules/word-diff.ts`). The merge drops
any LLM hunk that overlaps a user edit made during the async call, so
typing while the call is in flight is never clobbered.

This is the structural fix for the May 2026 long-body duplication bug:
the earlier design had the LLM emit a narrow `REWRITE` of just the
TARGET, then the resolver spliced it back using an LLM-claimed span —
when the claimed span and the concat-tail disagreed, the body
duplicated. The fused result deliberately emits *no* splice geometry
(`INSTRUCTION` / `TARGET` ride along as `transformInstruction` /
`transformTargetDebug` metadata for debug + event payloads only, NOT as
substitution bounds), so the resolver always routes transform-blank
through the merge path. See `docs/architecture/blank-sources.md` for
the full merge-vs-splice decision table.

### Why one call (and why there used to be three)

A `groq`-only 3-pass pipeline (EXTRACT → APPLY → VERIFY, plus a P1.5
deictic-resolver sub-pass and cursor-sentinel injection) used to exist
alongside the fused path, picked per-provider by
`pickTransformBlankMode`. It was retired June 2026: on the matured
`FUSED_SYSTEM` prompt, groq fused benched at parity with 3-pass
(~1.6pp, inside run-to-run variance), ~35% faster (615ms vs 984ms, one
call vs three), and a single prompt eliminated an entire two-path
*drift* class — behaviour rules added to one encoding silently missing
from the other. See `EXPERIMENTS.md, Experiment 10` for the head-to-head
data and the retirement rationale.

### The fused prompt's APPLY rules ARE load-bearing

The same insight that justified the old 3-pass APPLY's verbose rules
holds for the fused prompt: stripping APPLY to minimal rules *dropped*
accuracy AND raised latency (the model thinks harder without explicit
guidance — Experiment 2). The fused prompt's APPLY rules therefore
carry real semantic load and should NOT be pruned. The notable ones:

- **Apply to ALL applicable spans**, not just the first; preserve
  everything not targeted (other words, punctuation, casing).
- **Concept-swap propagation** — when the instruction names a CATEGORY
  (pet, vehicle, profession, era), update dependent verbs/sounds/
  objects to match (cats meow not bark; cars use seatbelts not helmets).
- **Composed instructions** ("X and Y") — pipe-join in `INSTRUCTION`
  (`make past tense | remove pronouns`) and apply BOTH simultaneously;
  the result must be grammatical under both constraints. Don't split a
  single edit (`change boy to girl`, `make it formal`).
- **Preserve structure** — `\n\n` paragraph breaks round-trip verbatim;
  multi-paragraph in → multi-paragraph out.
- **Markdown styling** — `make X bold` / `italicize Y` / etc. decorate
  the named span IN PLACE with `**`/`*`/`~~`/`` ` `` markers (stripped
  before the buffer is written; visual style rendered via the host's
  `markdown.styled` event). The named span may sit in a sentence
  *before* the instruction, across a period or line break — find it,
  don't bail.
- **Fill placeholder vs add/append** — when the instruction supplies a
  VALUE for a named field (`add recipient name Karen`) and the body
  already contains a matching placeholder (`[Recipient Name]`,
  `{{name}}`, `___`, a `Label:` line), REPLACE that placeholder in
  place; otherwise an ADD/APPEND instruction over existing body
  preserves the body verbatim and appends the new content on a new
  paragraph. The presence of body text is decisive: instruction + body
  → append; instruction alone → generative.
- **Generative output uses real line breaks** — poems break each line,
  lists put each item on its own line, emails blank-line between
  paragraphs. Never ` / ` or a literal `\n`; emit the actual newline
  (the rewrite is written to the buffer verbatim — see Lesson 5).

The prompt's example block is the load-bearing part for the APPLY rules
(unlike classification, where examples can hurt — Experiment 2). When a
concrete production failure shows the model needs a new example, add
it; otherwise resist, because each addition risks pushing the model
back into exclusionary pattern-matching mode.

### Identity + blank-context catalog blocks

When `identity-context-mode` and/or `blank-context-mode` are on, the
runtime appends two catalog blocks to the fused system prompt:

- **Identity catalog** (`buildUserCatalogBlock`) — the user's own
  personal data from `~/.cues/IDENTITY.md`, so a `draft an email _`
  rewrite can personalise the sender without re-typing.
- **Blank-context catalog** (`buildBlankContextBlock`) — ambient
  blank values (stocks/weather/crypto/…) the rewrite can fold in.

Both default OFF and are structural no-ops when off. In `safe` mode the
identity catalog sends only token names + descriptions; a runtime
post-processor (`resolveSentinels`) substitutes real values AFTER the
LLM responds, so PII never reaches the provider. See
`docs/architecture/identity-context.md`.

> **Cerebras prompt-cache note:** `FUSED_SYSTEM` and the two catalog
> blocks are stable session-level context and go in the **system**
> message so cerebras caches them as a prefix (~99.5% hit rate). The
> per-call user INPUT stays in the user message. Don't move per-call
> binding into the system prompt — see `docs/architecture/cerebras.md`.

### Claim-and-bail — protecting the slot from FluidBlank "vandalism"

If the fused call classified the input as `TRANSFORM` but couldn't
produce a rewrite (empty `FULL_REWRITE`, unparseable output), the source
**claims** the `_` slot before returning, by setting
`CueSourceResult.consumedBlankSlots: [blankIdx]` on the empty result.

The resolver forwards consumed-slot indices into the
`CueContext.consumedBlankSlots` field of every downstream source.
`FluidBlankSource.getCues` checks early: if its slot is in that list, it
bails with `reason: 'consumed-upstream'` and the buffer is left
unchanged.

Why this matters: without the claim, a `TRANSFORM` verdict + a failed
rewrite would let FluidBlank fall through and substitute the user's
instruction as a *question* — "make this shorter _" becomes "Paris"
because FluidBlank read the imperative as a lookup phrase. The user gave
an instruction; we failed to apply it; substituting an unrelated answer
is worse than leaving the buffer alone.

Rule: **if TransformBlank tries a slot, FluidBlank never does.** The
only paths that LEGITIMATELY hand off to FluidBlank:
- The verdict was `NONE` on a short buffer (input wasn't classified as
  imperative — "capital of france _", "atomic number of oxygen _").
- TransformBlank short-circuited before the LLM call (no `_`,
  partial-detector flagged still-typing) — empty result without claim.

Pinned by `packages/opencues-core/src/resolver.test.ts` (consumed-slots
forwarding) and the TransformBlank tests covering the TRANSFORM +
empty-rewrite case.

### Parser quirks

The output is line-based, parsed by regex. Two non-obvious bug fixes
are baked in:

1. **`[ \t]*` not `\s*`** for single-line fields (VERDICT,
   INSTRUCTION). `\s*` matches the newline AND the next line's label, so
   a lazy `.*?` extends across lines and captures the next field's label
   as the current field's value (trace showed
   `verdict=NONE, instruction="TARGET:"` — pure noise). Use
   horizontal-whitespace-only.
2. **`FULL_REWRITE` drops the `m` flag** because it can span multiple
   paragraphs. With `m`, `$` matches at end of each line and lazy
   `[\s\S]*?` stops at the first newline, truncating multi-paragraph
   rewrites to one line.

### Dynamic max_tokens

The call computes its own `max_tokens` budget from the input length
(`budgetForOutput`):

```
budget = max(FLOOR=768, ceil(input_chars / 3) + REASONING_HEADROOM=400)
```

- **FLOOR=768** reserves room for BOTH `reasoning_effort: 'low'`
  reasoning tokens AND the structured output. An earlier FLOOR=128
  truncated long-text cases mid-output and dropped accuracy 85% → 50%.
  Lesson: with `reasoning_effort`, the safe floor is bigger than the
  output alone would suggest.
- **`input_chars / 3`** estimates output tokens (`FULL_REWRITE` echoes
  most of the input back).
- **CEILING=4096** caps multi-paragraph rewrites.

### Output parsing — label-based, not strict JSON

The fused call emits three labelled lines
(`VERDICT:` / `INSTRUCTION:` / `FULL_REWRITE:`, the last spanning
multiple lines) and `parseFused` extracts them with tolerant regexes. It deliberately does NOT use a JSON-schema constrained-decoding
mode: `FULL_REWRITE` is the entire rewritten buffer (arbitrary newlines,
markdown, dense scripts), which doesn't schematize cleanly, and the
label format with a permissive parser handles a missing prefix or
preamble leakage gracefully. (The retired 3-pass path DID use Groq's
strict JSON mode for its small `{verdict, instruction, target}` EXTRACT
schema — that went away with the pipeline. The `useStrictJson` gate
still exists in `@opencues/core` for other sources, but TransformBlank
no longer calls it.)

---

## Runtime integration

### File layout

```
packages/opencues-core/src/sources/transform-blank-source.ts
  ↳ TransformBlankSource (CueSource)
  ↳ FUSED_SYSTEM prompt (single inlined constant)
  ↳ runFusedAndBuild (the one LLM call + result builder)
  ↳ Parser
  ↳ Dynamic max_tokens (budgetForOutput)
  ↳ Identity / blank-context catalog block builders + sentinel resolver

packages/opencues-core/src/sources/build-sources.ts
  ↳ enableTransformBlank flag (option to buildSourcesFromConfig)
  ↳ Constructs TransformBlankSource at priority 93

packages/opencues-runtime/src/modules/resolver.ts
  ↳ Reads OPENCUES.md `transform-blank-mode` setting
  ↳ Passes adapter.log → source's `log` callback (debug-mode trace)
  ↳ Three-way-merge substitute branch on `r.source === 'transform-blank'`
  ↳ Builds WordDef with alternatives = [originalText, rewrittenText, ...variants]
```

### CueResult shape

```ts
{
  wordIndex: blankIdx,
  word: '_',
  alternatives: [originalFullText, rewrittenText, ...priorVariants],
  source: 'transform-blank',
  priority: 93,
  spanStart: 0,
  spanEnd: context.text.length,    // entire input region
  metadata: {
    transformInstruction:  <pipe-joined or single>,   // CoT scaffolding, debug only
    transformTargetDebug:  <the model's TARGET line>,  // debug only — NOT splice geometry
    verifyVerdict:         'SKIPPED',                  // no verify pass exists
    pipelineMode:          'fused',
    taskAction:            <'arm' | 'add' | 'stop' | 'show'>,  // TASK_* branches
    taskPayload:           <task-action-specific data>,
  },
}
```

`alternatives[0]` is the original input (so cycling Down restores it).
`alternatives[1]` is the fresh rewrite. `alternatives[2..N]` are prior
cached variants from the variant pool (Up-arrow walks them). The
metadata carries `transformTargetDebug`, deliberately **not**
`transformTarget` — its absence is the signal the resolver uses to take
the whole-buffer merge path rather than a surgical splice (see
Substitution below).

### Substitution

In `packages/opencues-runtime/src/modules/resolver.ts`, the
transform-blank branch:

1. Race-guard: compare ZWS-stripped `liveText` against `originalText`.
   If they differ, another module touched the text — skip with a
   "skipping — live text changed since resolve" log. (ZWS is stripped
   because CC's loading-spinner pushText flips a zero-width char every
   frame; those toggles aren't user edits.)
2. TASK routing: if `metadata.taskAction` is set, route to
   `handleTaskCommand` (AgentTaskState) instead of substituting.
3. Because the source emits no `transformTarget`, take the
   **whole-buffer path**: `threeWayMerge(originalText, rewrittenText,
   liveText)` produces the merged buffer (dropping any LLM hunk
   overlapping a concurrent user edit).
4. Build a WordDef keyed at the merged text's first changed word, with
   `currentIndex=1` (showing the rewrite) and
   `blankName='transform-blank'` (locks against re-resolution by
   subsequent LLM passes — same mechanism FluidBlank uses).
5. Call `adapter.pushText(mergedText, newCursor)` — atomic
   text-and-cursor update. Falls back to `setText` + `setCursorOffset`
   + `forceRender` for hosts without pushText.
6. Emit `transform-blank.completed` AFTER the setText commits (so
   observers never read the buffer mid-loading-animation).

> The resolver still contains a surgical-splice branch (gated on
> `transformTarget` being present), used by FluidBlank's WIPE mode and
> ConfigIntent. TransformBlank never sets that field, so it always takes
> the merge path; the splice branch is effectively inert for
> transform-blank.

### asTypedText reconstruction — TransformBlank defs are SKIPPED

`reconstructAsTyped` (in `state/dyn-defs.ts`) walks the visible buffer
and substitutes each agent-edited word with its `originalWord` to
produce the "as the user typed it" view. TransformBlank-typed defs
**must be skipped** in this reconstruction.

Why: TransformBlank's `originalWord` is the FULL prior visible body
(body + the prior trigger phrase), not a single agent-edited word.
Re-injecting it bleeds the prior instruction phrase into the fused
input on the NEXT transform — the call then sees two instructions and
two `_`s, dropping the body or composing both into one pipe-instruction.

Bug shape (live-reproduced May 2026): user does "add emojis where
appropriate _" → success. Then types "remove emojis _" → the second
call sees `<no-emoji body> add emojis where appropriate _ remove
emojis _` as INPUT, returns `INSTRUCTION: Add emojis where
appropriate / TARGET: remove emojis`, body collapses to a 17-char
rewrite. Repro at
`tests/benchmarks/transform-blank/archive/repro-astyped-contamination.ts`.

The skip lives at `dyn-defs.ts` in `reconstructAsTypedWithMap`, gated on
`def.blankName === 'transform-blank'`. The cycle-Down revert path
doesn't go through asTyped, so this skip is safe.

**Rule for new blank types:** if a new blank's `originalWord` can be
multi-word or contain a trigger phrase, add it to the skip list (or
extend the predicate). Single-token / `_`-only originalWords
(fluid-blank, task-show, agent-task, user blanks) are safe to revert
and need no skip.

### Cycling

Cycling is delegated to the runtime's existing `WordDef`/`DynDefs`
machinery. With `currentIndex=1` (showing the fresh rewrite), cycling
Down sets `currentIndex=0` and replaces the span with `alternatives[0]`
(the original input including the instruction phrase). Cycling Up walks
through `alternatives[2..N]` — prior cached variants from the variant
pool (identical-buffer triggers cycle through cached rewrites rather
than re-calling the LLM).

The `blankName='transform-blank'` field prevents the resolver from
re-firing on the rewrite text — same lock that prevents FluidBlank's
answer from being clobbered by RoutedWordSourceGroup synonyms.

---

## Configuration

### OPENCUES.md settings

```yaml
transform-blank-mode: on    # required to enable TransformBlankSource
debug-mode: on              # surfaces per-stage logs (recommended)
```

Hot-reload picks up changes — no restart needed. Defaults to
`transform-blank-mode: off` (opt-in), laid out by
`opencues seed-configs`. The selector/satellite UI also surfaces it via
the matching `settings:` block entry — typing `config _` and cycling
toggles it without editing the file.

### Tunables (in source code)

```ts
// transform-blank-source.ts

budgetForOutput(expectedChars, multiplier)
  FLOOR              = 768   // reasoning + output headroom
  REASONING_HEADROOM = 400   // covers reasoning_effort: 'low'
  CEILING            = 4096  // caps multi-paragraph rewrites

FUSED_NONE_RETRY_FLOOR = 400  // long-buffer NONE → cede, don't trust
```

Don't ship tunables to users via OPENCUES.md — the right values are
determined by benchmarks, not preference.

---

## Debugging

### Debug log trace

With `debug-mode: on`, the source emits a structured trace:

```
TransformBlank: starting (textLen=42, blankIdx=4)
TransformBlank: identity-context: injected (mode=safe, 3 fields)
TransformBlank FUSED (351ms, max_tokens=820): verdict=TRANSFORM, instruction="change boy to girl"
TransformBlank: substituting "the boy ran fast change boy to girl _" → "the girl ran fast" (origLen=42, rewriteLen=18, defAt=0)
```

The log function is wired in `resolver.ts:rebuildResolver` as
`(msg) => this.adapter.log('debug', msg)`, gated by `debug-mode`.

### Diagnosing common failures

| Symptom in trace | Likely cause | Fix |
|---|---|---|
| `verdict=NONE` (short buffer) | Real NONE — input isn't a transform | None needed (FluidBlank takes over) |
| `verdict=NONE on a long buffer … ceding` | Fused budget-pressure misfire (cerebras gpt-oss-120b) | Auto-handled — source cedes; a later resolve re-classifies. If the rewrite still never lands, raise `FUSED_NONE_RETRY_FLOOR` or the output budget |
| `verdict=NONE, instruction="TARGET:"` | Parser bug (regex swallowing newlines) | Should be fixed; if recurring see commit ac7f79d |
| `verdict=TRANSFORM`, body collapsed to a short rewrite | asTyped contamination (prior trigger bled into input) | Confirm the transform-blank asTyped skip is intact (`dyn-defs.ts`) |
| `empty rewrite — ceding` | Model parsed input but produced no result | Check provider dashboard for TPM cap / truncation |
| `skipping — live text changed since resolve` | Race with another module; rare | None — substitution skipped to avoid clobbering |
| Long latency (>5s) per call | Model in deep reasoning loop | Check if `reasoning_effort` / `max-thinking` changed |

---

## The benchmark suite

`tests/benchmarks/transform-blank/` has the empirical foundation for
every design decision in this document. **`prod.ts` drives the
production source** (`TransformBlankSource` from `@opencues/core`) —
there is no bench-local copy of the prompt. Edit `FUSED_SYSTEM` in
`transform-blank-source.ts` and this measures it:

```bash
CEREBRAS_API_KEY=… GROQ_API_KEY=… \
  npx tsx tests/benchmarks/transform-blank/prod.ts --provider cerebras --parallel 8
```

Per-case judgment uses an LLM-as-judge (`judge.ts`, pinned to Groq
gpt-oss-120b regardless of the provider under test) with exact-match
short-circuits.

> The old comparative harness (`run.ts` with `extract-apply`,
> `single-call`, `minimal-*`, `skip-*` modes, each carrying its own copy
> of the prompts) is retired to `archive/`. The mode-comparison findings
> remain in `EXPERIMENTS.md`.

---

## Lessons learned

A condensed set of insights from the experiment log. Each is backed by
an experiment in `EXPERIMENTS.md`.

1. **Always-claim + LLM-as-classifier beats heuristic gating.** A
   regex/keyword heuristic in `supports()` was brittle (missed "full
   caps", `make me a website` was wrongly classified). Always claiming +
   letting the fused call decide via NONE bail is cleaner — the cost is
   one extra LLM call per non-transform `_`. (Experiment 1.)

2. **Single-line field parsers should use `[ \t]*` not `\s*`.** `\s*`
   matches newlines, which lets a lazy `.*?` accidentally capture the
   next field's label as the current field's value. Use
   horizontal-whitespace-only.

3. **Reserve reasoning headroom in max_tokens budgets.** With
   `reasoning_effort: 'low'`, a too-tight budget truncates the model
   mid-output. FLOOR=768 is the safe minimum for short outputs even if
   the actual output is 50 tokens. (Experiment 1/2.)

4. **The fused prompt's APPLY rules are load-bearing — execution
   benefits from explicit rules.** Stripping them dropped accuracy AND
   raised latency (the model thinks harder without guidance).
   Classification, by contrast, benefits from openness — keep the
   NONE-decision minimal and the APPLY rules verbose. (Experiment 2.)

5. **Match the runtime's real I/O exactly — examples leak their
   formatting into the buffer.** The rewrite is written back verbatim
   (the parser only `.trim()`s), so whatever line-separator an example
   teaches is what the user sees. A `FUSED_SYSTEM` poem example using
   ` / ` made the model emit literal slashes (PR #190); literal `\n` in
   examples risks visible backslash-n. Multi-line examples use **real
   newlines** — never ` / ` or literal `\n`/`\\n`. With a single prompt
   there's no second encoding to keep in sync; the only rule is "the
   prompt's I/O must match what the buffer receives." (Experiment 9.)

6. **Soft-fail provider parse errors and rate limits.** One bad
   response shouldn't kill a batch run or a user session. Catch in the
   client, return empty, let the caller treat it as a bail.

7. **Document each design decision with the experiment that justifies
   it.** When the next person (or future-you) asks "why didn't we just
   do X?", the answer should be `EXPERIMENTS.md, Experiment N`.

> **Historical (no longer load-bearing):** the experiment log also
> records lessons about the retired 3-pass split — sequential
> composition for "X and Y", VERIFY-as-defect-catcher, smart
> skip-VERIFY, the P1.5 deictic resolver. They explain why the 3-pass
> design once outperformed a *crude* single call; Experiment 10 then
> showed the matured fused prompt reaches parity with one call. They're
> kept in `EXPERIMENTS.md` for context but no longer describe shipping
> code.

---

## Known limits

- **Multi-paragraph >200 words untested.** The longest bench cases are
  ~150 words. Latency may exceed 2s on long inputs.
- **Subjective register shifts are at the model's edge.** "Make it more
  confident", "make it sincere" — the model often produces minimal
  outputs (appending "!" or "Oh,"). 30-60% on tone-shift tasks.
- **Conditional with paragraph-specific scope.** "X but only in the
  first paragraph" works ~70%.
- **Context-referring "match the style of X".** 50-70% — open-ended
  style transfer is genuinely hard.
- **No streaming.** The rewrite arrives all at once.
- **No multi-span linked highlighting.** The runtime three-way-merges
  the whole rewrite; it doesn't highlight individual word changes as
  separately-cycleable linked spans.

### Fix-forward gaps — status after Experiments 11-12

These four capabilities lived **only** in the retired 3-pass `P2_APPLY`
(+ the P1.5 deictic resolver + cursor-sentinel injection), and were
initially assumed lost with the 3-pass retirement (Experiment 10). A
follow-up benchmark (`EXPERIMENTS.md, Experiment 11`) found the "gaps"
were mostly theoretical — a capable model already handles most of this
class through the whole-buffer `FULL_REWRITE` with no explicit rule.
**As of Experiment 12, all four are addressed:**

- **Heading / list-ification** — "make it a heading" (→ `# `), "turn
  into a list" (→ `- `). Genuinely broken on groq at baseline (emitted
  prose, not bullets); fixed by adding one `STRUCTURE` rule to
  `FUSED_SYSTEM` (Experiment 11). 8/8 gap cases pass on cerebras, no
  regression on the standard suite.
- **Anchored insertion** — "add X after the dear line", "drop X in" (vs
  "drop X" = delete). Never actually broken — cerebras passed this at
  baseline with no rule needed (Experiment 11). No prompt change made
  (adding a rule for behavior the model already has would be opinion
  without benefit).
- **Deictic edits** — "shorten it", "make this line bold", "fix this
  typo". Also passed at baseline with no rule (Experiment 11) — the
  whole-buffer view gives the model enough context to resolve
  "it"/"this" itself.
- **Caret-relative "here" edits** — "add a line break here", "split
  this paragraph here". The one gap that genuinely needed new wiring:
  restored via a `[CURSOR]` sentinel injected into the fused call,
  gated on a positional-cue regex so the marker doesn't distract
  classification on the ~95% of non-positional transforms (Experiment
  12). Verified live on Claude Code with a real cursor position.

**Auto-styling (pick-your-own-spans) remains a separate, genuinely
unimplemented feature** — see [Markdown Styling](../features/markdown-styling.md).
"add bolding where appropriate" / "highlight key terms" require the
model to choose which spans deserve styling; the `MARKDOWN STYLING`
rule only fires for a *named* span ("make wilfred bold") and was never
benchmarked as part of Experiments 11-12 (not `finalText`-scorable —
markers are stripped to a `markdown.styled` event before the bench
observes the result).

---

*Last updated: 2026-06-23. Authoritative for the single fused pipeline
(3-pass retired per `EXPERIMENTS.md, Experiment 10`), the generative
branch, and the TASK_* verdicts that route into the agent-task state
machine.*
