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
| **`TransformBlankSource`** (`transform-blank-source.ts`) | imperative phrase next to `_` (e.g. "make past tense _") | The whole final buffer (`FULL_REWRITE`) from a single fused LLM call | **One path.** Always `threeWayMerge` against the live buffer. |
| **`SentenceCueSource`** (`sentence-cue-source.ts`) | one cue per sentence at `scope: sentence` | Sentence alternatives | Passive — registers a DynDef; cycling swaps the sentence via the existing word-cue cycle path. Never touches the buffer until the user presses Ctrl+Alt+Up. |
| **`ConfigIntentSource`** (`config-intent-source.ts`) | unbound `_` interpreted as a settings change ("make it louder _") | Setting + value classification | Selector-satellite shaped result with `clearOnEdit: true`; substitute wipes the summon phrase via `spanStart=summonPhraseStart(text), spanEnd=text.length` (the last sentence terminator / line break before `_`, or 0 if none) so prior user content before the settings command is preserved, then hands off to standard cycling. |
| **`ConfigSource`** (`config-source.ts`) | highlighted word matches the source's `match:` / `keywords:` (LLM word-cue) | Word alternatives | Per-word substitution via DynDef set; no buffer-wide rewrite. |
| **`LocalCueSource`** (`local-cue-source.ts`) | highlighted word matches a static tip | Static alternatives from `CUES.md`'s `## Tips` | Per-word substitution via DynDef set; no LLM call. |
| **`RoutedWordSourceGroup`** (`routed-word-source-group.ts`) | wraps every `ConfigSource` | (dispatches) | Not a substitute mechanism — routes each highlighted word to exactly one child source by priority + `match:` / `keywords:`. See `docs/features/word-cue-routing.md`. |

`AgentRewrite` lives in `opencues-runtime` (not a `CueSource`) and
also routes through `threeWayMerge`; see
[`agent-task.md`](agent-task.md). Its merge primitive is the same
one TransformBlank-fused reuses.

**Keyword-window coordination (BlankIntent + the cede checks).**
`BlankSource`, `FluidBlankSource`, `TransformBlankSource`, and
`ConfigIntentSource` all decide "is this `_` mine?" using the SAME
keyword-window predicate (`keywordInWindow()` in
`@opencues/core/keyword-window.ts`) — so a keyword that claims a `_`
for `BlankSource` is the same keyword the other three cede on. When
`blank-intent-mode: on`, the window switches from per-blank proximity
to same-line scope across all five sites (the fifth is
`BlankFill.matchKeyword` in the runtime), and an LLM gate decides
INVOKE vs CEDE for the script fire. See
[`blank-intent.md`](blank-intent.md).

---

## Two substitute mechanisms

### 1. Deterministic slot splice

Used by `BlankSource`, `FluidBlankSource`, and `ConfigIntentSource`'s
satellite handoff. (TransformBlank used a splice path in its retired
3-pass mode; it now always takes the three-way-merge path below.)

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

Used by `TransformBlankSource` (its single fused call) + `AgentRewrite`.

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
  coords. The richText injection on the fused call's input side (see
  `resolver.ts` rich-text block) is independent of the substitute
  mechanism.

---

## Decision table — picking the mechanism for a new source

| Source emits | Pick |
|---|---|
| A short fill the parser knows where to splice (BlankSource shape) | **Deterministic slot splice.** Wire through `blank-fill.ts`. |
| An LLM-claimed span + a span-scoped rewrite | **Deterministic slot splice.** But ensure the span CANNOT exceed what the LLM saw as input — pass the LLM only the bounded target as input so the splice range is structurally safe. (TransformBlank's retired 3-pass APPLY worked this way; the splice path remains available for a future bounded-span source, but TransformBlank no longer uses it — it emits the whole buffer and merges.) |
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
  — scenario tests covering the runtime substitute paths. The
  "TransformBlank fused / whole-buffer — duplication-bug structural
  fix" describe block (4 tests) pins the merge contract TransformBlank
  uses today: long-body has no duplication, exact LLM rewrite lands,
  pathological duplicated LLM output never produces a concat-induced
  doubling, in-flight user typing past the trigger survives. The
  "surgical splice" describe blocks pin the runtime's bounded-span
  splice mechanism, which remains available for a future bounded-span
  source even though TransformBlank no longer emits `transformTarget`.
- `packages/opencues-runtime/src/modules/word-diff.ts` + companion
  `word-diff.test.ts` / `word-diff.scenarios.test.ts` /
  `word-diff.properties.test.ts` — 600+ tests on the merge primitive
  itself (the same one AgentRewrite uses; see [`agent-task.md`](agent-task.md)).
- `packages/opencues-runtime/src/modules/blank-fill.ts` +
  `blank-fill.test.ts` — pins the deterministic slot splice path for
  BlankSource + FluidBlankSource. Covers each `blankReplace` mode
  plus the legacy flag paths.
- `tests/benchmarks/transform-blank/` — `prod.ts` validates the LLM
  contract end-to-end (`--provider cerebras|groq`). The single fused
  pipeline runs on every provider; the old groq-only 3-pass path was
  retired June 2026 (see `EXPERIMENTS.md § Experiment 10`).
- `tests/agentic/scenarios/08-transform-blank-pipeline.json` — pins
  the resolver's dispatch ordering (one `transform-blank.started`
  per `_` trigger, not two — the May 2026 double-fire regression
  guard).

---

## Related docs

- [`transform-blank.md`](transform-blank.md) — TransformBlank pipeline
  internals (single fused call) + prompt design + EXPERIMENTS history.
- [`agent-task.md`](agent-task.md) — AgentRewrite + the three-way
  merge invariants in detail.
- [`blank-replace-modes.md`](blank-replace-modes.md) — `blankReplace`
  field for BlankSource / FluidBlankSource.
- [`spans-and-cycling.md`](spans-and-cycling.md) — the DynDef
  cycling layer that passive cues use.
- [`blank-intent.md`](blank-intent.md) — the optional LLM invocation
  gate for keyword script-blanks + the shared keyword-window predicate
  the four claim/cede sites route through.
- `docs/features/word-cue-routing.md` — per-word dispatch via
  `RoutedWordSourceGroup`.
