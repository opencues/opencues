---
last_updated: 2026-05-23
---

# Blank sources — family + substitute mechanics

> **Read this before:** adding a new `CueSource` subclass, touching the
> resolver's substitute dispatch (`packages/opencues-runtime/src/modules/resolver.ts`),
> or changing how a source maps from an `_` trigger to a buffer change.

OpenCues has a small family of source classes — every word-cue, blank,
sentence-cue, agent-task, config-intent classification routes through
one of them. This doc inventories the family, the two substitute
mechanisms the runtime uses to apply a source's result, and the
decision table for picking the right mechanism when adding a new
source.

The duplication bug class fixed in May 2026 was caused by mixing the
mechanisms — TransformBlank trusted an LLM-emitted span as its splice
boundary; the LLM occasionally emitted a narrow span with a wide
rewrite; the concat-tail in the splice produced duplicated content.
The fix was to align the mechanism to the data: whole-buffer LLM
output → three-way merge (no splice geometry to get wrong).

---

## The family

Every source implements `CueSource` from `@opencues/core` and emits
`CueResult[]` from `resolve(context)`. Resolver dispatches based on
result shape + a small metadata vocabulary.

| Source | Trigger | LLM output | Substitute mechanism |
|---|---|---|---|
| **`BlankSource`** (`blank-source.ts`) | `<keyword> _` matches a folder under `blanks/` | None — runs a script / sync stepValues / built-in JS impl | Deterministic splice via `blank-fill.ts`. Slot bounds come from the parser (keyword + `_` positions), not from LLM. |
| **`FluidBlankSource`** (`fluid-blank-source.ts`) | unbound `_` (no `BlankSource` match) | Short answer (e.g. "Paris") | Deterministic splice via `blank-fill.ts`. `blankReplace` mode (`keep`/`wipe`/`wipe-all`/`auto`) picks the splice range from the slot, not the LLM. |
| **`TransformBlankSource`** (`transform-blank-source.ts`) | imperative phrase next to `_` (e.g. "make past tense _") | A target-only rewrite (3-pass) OR an LLM-emitted SPAN + slice REWRITE (fused, June 2026) | **One path.** Deterministic splice via `metadata.transformTarget` (= SPAN for fused, target text for 3-pass). Anything in the buffer outside the SPAN range is preserved verbatim. |
| **`SentenceCueSource`** (`sentence-cue-source.ts`) | one cue per sentence at `scope: sentence` | Sentence alternatives | Passive — registers a DynDef; cycling swaps the sentence via the existing word-cue cycle path. Never touches the buffer until the user presses Ctrl+Alt+Up. |
| **`ConfigIntentSource`** (`config-intent-source.ts`) | unbound `_` interpreted as a settings change ("make it louder _") | Setting + value classification | Selector-satellite shaped result with `clearOnEdit: true`; substitute wipes the summon words via `spanStart=0, spanEnd=text.length` and hands off to standard cycling. |
| **`ConfigSource`** (`config-source.ts`) | highlighted word matches the source's `match:` / `keywords:` (LLM word-cue) | Word alternatives | Per-word substitution via DynDef set; no buffer-wide rewrite. |
| **`LocalCueSource`** (`local-cue-source.ts`) | highlighted word matches a static tip | Static alternatives from `CUES.md`'s `## Tips` | Per-word substitution via DynDef set; no LLM call. |
| **`RoutedWordSourceGroup`** (`routed-word-source-group.ts`) | wraps every `ConfigSource` | (dispatches) | Not a substitute mechanism — routes each highlighted word to exactly one child source by priority + `match:` / `keywords:`. See `docs/features/word-cue-routing.md`. |

`AgentRewrite` lives in `opencues-runtime` (not a `CueSource`) and is
the **only** remaining consumer of `threeWayMerge`; see
[`agent-task.md`](agent-task.md). The merge primitive stays load-
bearing there because AgentRewrite is a background rewriter that may
run for seconds while the user keeps typing; three-way merge protects
in-flight user edits from being clobbered. The semantic `_` sources
all run on a single keystroke and don't have that exposure window —
the splice mechanism is sufficient.

> **June 2026 unification.** Previously TransformBlank fused mode
> also routed through `threeWayMerge` (LLM emitted `FULL_REWRITE` =
> whole buffer; runtime diffed against the live buffer). Empirical
> testing showed the merge didn't protect against the LLM dropping
> unrelated prior content from `FULL_REWRITE` — the snapshot vs
> liveText diff only catches in-flight user typing, not LLM
> omissions. The fused path now emits SPAN + slice REWRITE and
> splices, matching FluidBlank + ConfigIntent. One mechanism, one
> mental model, one bug surface.

---

## Two substitute mechanisms

### 1. Deterministic slot splice

Used by `BlankSource`, `FluidBlankSource`, `ConfigIntentSource`'s
satellite handoff, and TransformBlank's 3-pass path.

```ts
newText = liveText.slice(0, slot.start) + answer + liveText.slice(slot.end)
```

The splice range comes from the **runtime parser's** knowledge of
where the keyword / `_` / target sits in the buffer — a position the
parser computed deterministically from the visible text. The LLM (or
script, or stepValues source) only produces the *fill*; it does NOT
declare a span.

Properties:
- **No splice-scope ambiguity.** The slot bounds are exact char
  positions; there's nothing for the LLM to get wrong.
- **No three-way merge needed for trailing user typing.** `liveText`
  IS the buffer at substitute time, and `slice(slot.end)` already
  preserves whatever the user typed past the slot.
- **Bug surface is empty for the duplication class.** No concat-tail
  ever covers content the fill already covered, because the fill is
  short and bounded by the slot.

The race window (user types between resolve and substitute, shifting
positions) is handled by `blank-fill.ts`'s slot-stability checks, not
by the merge primitive.

### 2. Three-way merge (whole-buffer LLM)

Used by `AgentRewrite` only (June 2026 — TransformBlank fused mode
moved to splice; see the table note above).

```ts
const merge = threeWayMerge(snapshot, fullRewrite, liveText);
applyMarkdownAwareSubstitution(adapter, merge.newText);
```

The LLM emits the **complete final buffer**. The runtime diffs
(`snapshot → fullRewrite`) for LLM hunks, diffs (`snapshot → liveText`)
for user hunks, and layers the LLM hunks onto the live buffer with
the AgentRewrite invariants:

1. User content is never silently destroyed (LLM hunks that overlap
   user hunks drop).
2. Paragraph breaks the user typed cannot be collapsed.
3. Trailing whitespace at end-of-buffer survives.
4. No surprise terminal punctuation appended at end-of-buffer.

See `packages/opencues-runtime/src/modules/word-diff.ts` for the
primitive + [`agent-task.md`](agent-task.md) for the AgentRewrite
state machine.

Properties:
- **No splice geometry to compute.** The LLM declares no span; the
  diff IS the geometry.
- **Duplication bug class is structurally impossible.** No
  concat-tail operation exists in the merge layer; worst-case bad
  LLM output is exactly the LLM's bytes, never strictly longer.
- **In-flight user typing during the LLM call is preserved.** The
  merge layers LLM hunks onto `liveText`, not onto `snapshot`.
- **Markdown styling preservation is unchanged.**
  `applyMarkdownAwareSubstitution` strips markdown markers from the
  merged text and emits `markdown.styled` ranges in final-buffer
  coords. The richText injection on the EXTRACT input side (see
  `resolver.ts` rich-text block) is independent of the substitute
  mechanism.

---

## Decision table — picking the mechanism for a new source

| Source emits | Pick |
|---|---|
| A short fill the parser knows where to splice (BlankSource shape) | **Deterministic slot splice.** Wire through `blank-fill.ts`. |
| An LLM-claimed span + a span-scoped rewrite | **Deterministic slot splice.** But ensure the span CANNOT exceed what the LLM saw as input (e.g., 3-pass APPLY receives only the target as input — structurally safe). |
| The whole final buffer | **Three-way merge.** Set `metadata.pipelineMode = 'fused'` (or similar) so the resolver routes correctly. Do NOT emit `metadata.transformTarget` — its presence is the signal to take the splice path. |
| A passive cue (no buffer change until the user cycles) | **No substitute.** Register a DynDef; cycling handles it. See [`spans-and-cycling.md`](spans-and-cycling.md). |

The anti-pattern that broke TransformBlank in 5f24c09 → May 2026: an
LLM emits a span claim AND a wide rewrite, then a deterministic
splice trusts the span and concatenates `originalText[span_end:]`
after the rewrite. If the rewrite already covered the post-span
content, the concat duplicates it.

The structural defence: align the mechanism to the data.
**Whole-buffer rewrite → merge.** **Bounded-span rewrite → splice
ONLY if the LLM's input was that exact bounded span (so it
*structurally* can't produce content outside it).**

---

## Why FluidBlank doesn't need the merge

FluidBlank stays on the deterministic slot splice because:

1. The LLM in FluidBlank produces a short answer ("Paris"), not a
   buffer. There's no span-vs-buffer scope ambiguity.
2. The slot bounds (`target.start`, `target.end`) come from the
   parser's known keyword position. The LLM has no input into them.
3. `blankReplace` modes (`keep` / `wipe` / `wipe-all` / `auto`)
   determine the splice range from the slot + a deterministic
   heuristic; none of them concat-tail content the answer covered.

The replace-mode work for FluidBlank already covered the "what does
the splice replace?" question — see [`blank-replace-modes.md`](blank-replace-modes.md).

---

## When a future source would want the merge

If a future blank source decides to emit a whole-buffer rewrite
(e.g., a "rewrite the surrounding paragraph" blank, or a
multi-pass-with-user-editing-in-the-middle source), reach for
`threeWayMerge` and route through the same path TransformBlank
fused uses. The merge invariants cover the cases (user-edits
overlap, paragraph break preservation, trailing whitespace survival,
no surprise punctuation) you'd otherwise have to re-implement.

Don't introduce a third substitute mechanism without a strong reason.
The two we have today cover every source in the codebase, and any
new mechanism adds a per-source bug surface the existing merge
primitive already pays for.

---

## Tests pinning this behaviour

- `packages/opencues-runtime/src/modules/transform-blank.scenarios.test.ts`
  — 24 scenario tests covering both substitute paths (3-pass splice
  + fused whole-buffer merge). The "TransformBlank fused / whole-buffer
  — duplication-bug structural fix" describe block (4 tests) pins
  the new merge contract: long-body has no duplication, exact LLM
  rewrite lands, pathological duplicated LLM output never produces a
  concat-induced doubling, in-flight user typing past the trigger
  survives.
- `packages/opencues-runtime/src/modules/word-diff.ts` + companion
  `word-diff.test.ts` / `word-diff.scenarios.test.ts` /
  `word-diff.properties.test.ts` — 600+ tests on the merge primitive
  itself (the same one AgentRewrite uses; see [`agent-task.md`](agent-task.md)).
- `packages/opencues-runtime/src/modules/blank-fill.ts` +
  `blank-fill.test.ts` — pins the deterministic slot splice path for
  BlankSource + FluidBlankSource. Covers each `blankReplace` mode
  plus the legacy flag paths.
- `tests/benchmarks/transform-blank/` — `--mode fused-full` validates
  the LLM contract end-to-end across 5 providers (groq, cerebras,
  claude, gemini, openai). Production routes through this mode on
  every provider except groq, which uses 3-pass.
- `tests/agentic/scenarios/08-transform-blank-pipeline.json` — pins
  the resolver's dispatch ordering (one `transform-blank.started`
  per `_` trigger, not two — the May 2026 double-fire regression
  guard).

---

## Per-call model override — affects FluidBlank + TransformBlank dispatch only

Both `FluidBlankSource` and `TransformBlankSource` accept an optional
`apiKeys: Readonly<Record<string, string | undefined>>` in their
constructor config (June 2026). The map is keyed by `envKeyName`
(`ANTHROPIC_API_KEY`, `CEREBRAS_API_KEY`, …) — same convention
`resolveLLM` uses at `llm-provider.ts:1817`. build-sources passes the
runtime resolver's full apiKeys map through as a pass-through.

When the buffer carries a `with <model>` token (the per-call override
syntax), the source detects it at the top of `getCues`, resolves the
override to `(provider, model, apiKey)` via
`packages/opencues-core/src/model-aliases.ts`, and dispatches THAT
call through the override target. The class's configured
(`this.provider`, `this.model`, `this.apiKey`) stays untouched. Next
`_` keystroke without `with X` goes back to the configured target.

**For new sources that issue LLM calls**: think about whether you want
the override to apply. The current contract:

| Source | Override fires? | Why |
|---|---|---|
| FluidBlank | Yes | User-opt-in via `_`; lookup answers are short and bounded |
| TransformBlank | Yes | Same trust class as FluidBlank |
| ConfigIntent | Cedes synchronously | Override syntax overlaps with PROVIDER-routing phrasing — cede prevents misclassification |
| SentenceCue | No | Background prose-bearing; widening would let CUES.md prompt content reach providers it shouldn't |
| Word-cues | No | Same reason; routed per-word, no clean trigger boundary |
| Auditors / agent-rewrite | No | Background tick; user didn't explicitly type `_` to consent |

Full design + tests: [`docs/architecture/model-override.md`](model-override.md).

---

## Related docs

- [`transform-blank.md`](transform-blank.md) — TransformBlank pipeline
  internals (3-pass + fused) + prompt design + EXPERIMENTS history.
- [`agent-task.md`](agent-task.md) — AgentRewrite + the three-way
  merge invariants in detail.
- [`blank-replace-modes.md`](blank-replace-modes.md) — `blankReplace`
  field for BlankSource / FluidBlankSource.
- [`spans-and-cycling.md`](spans-and-cycling.md) — the DynDef
  cycling layer that passive cues use.
- [`model-override.md`](model-override.md) — per-call `with <model>`
  dispatch redirect for FluidBlank + TransformBlank.
- `docs/features/word-cue-routing.md` — per-word dispatch via
  `RoutedWordSourceGroup`.
