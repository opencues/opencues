# Sentence Cues — architecture reference

Canonical doc for the `sentence-cues-mode` feature + the `scope:
sentence` per-cue declaration. User-facing summary:
[`docs/features/sentence-cues.md`](../features/sentence-cues.md).

This doc covers: the sentence-scope source class shape, the
segmentation strategy + known limitations, the resolver substitution
branch + word-cue suppression contract (design decision 4a: sentence
wins outright), the v1 one-sentence-cue-per-resolve cap and why,
priority placement vs other sources, and what the bench validates.

Read this before touching:

- `packages/opencues-core/src/sources/sentence-cue-source.ts`
- the sentence-cue substitution branch in
  `packages/opencues-runtime/src/modules/resolver.ts`
- the `SENTENCE_ALT_FORMAT_SPEC` constant
- the FEATURES registry's `sentence-cues-mode` entry
- the `scope: 'words' | 'blanks' | 'sentence' | 'all'` type in
  `packages/opencues-core/src/cues-md.ts`

---

## Where it sits in the source chain

```
95  BlankSource              keyword-bound, explicit match
94  ConfigIntent             semantic `_` → settings change
93  TransformBlank           imperative rewrite via `_`
92  FluidBlank               free-form `_` lookup
85  SentenceCue (default)    whole-sentence alternatives — `scope: sentence` cue
70  word cues (typical)      per-word synonyms (legal, medical, financial, ...)
```

Priority **85 by default** — higher than typical word cues from
`defaults/cues/` (which are usually 60-80). Authors can override per
cue with `priority:` in frontmatter.

Sentence-cue results don't claim `_` slots; they claim multi-word
prose spans. They don't compete with BlankSource / ConfigIntent /
TransformBlank / FluidBlank — those four all gate on `_` presence.
Sentence-cues only fire when the buffer has NO `_` (see `supports()`
in `sentence-cue-source.ts`).

---

## Source class shape

```ts
class SentenceCueSource implements CueSource {
  readonly id;                 // sentence-cue:<cue-name>
  readonly priority;           // sourceConfig.priority ?? 85
  readonly isCycleable = true; // pruned in no-cycling profiles

  constructor(config: {
    httpAdapter, provider, endpoint, apiKey, model,
    sourceConfig,              // SourceConfig from CUES.md / CUE.md
    defaultPriority?,
    log?, onEvent?,
  });

  supports(context: CueContext): boolean;
  async getCues(context: CueContext): Promise<CueSourceResult>;
  private async callLLM(...);
}
```

**`supports()` semantics:**

- Returns `false` when buffer is empty / whitespace-only.
- Returns `false` when buffer contains a `_` (the four `_`-gated
  sources take precedence; sentence cues are prose-time, not
  blank-time).
- Returns `true` otherwise — the segmenter is tolerant enough to
  produce at least one span for any non-empty prose, and per-sentence
  cede happens at the LLM-output level via `ALT: NONE`.

**`getCues()` flow:**

1. Segment the buffer into `SentenceSpan[]` via `segmentSentences()`.
2. One LLM call per buffer: `promptText` + `SENTENCE_ALT_FORMAT_SPEC`
   as system; `INPUT: <buffer>` as user.
3. Parse the output into `SentenceAltBlock[]` via
   `parseSentenceAltOutput()`.
4. Match each block to its sentence span by normalised text
   equality (case-insensitive, whitespace-collapsed, trailing-punct
   stripped).
5. For each non-ceded block with ≥1 alt, emit a `CueResult` with:
   - `wordIndex` = sentence's first word index
   - `alternatives` = `[originalSentence, ...rewrites]`
   - `spanStart` / `spanEnd` = char range of the sentence
   - `source` = `sentence-cue:<cue-name>`
   - `priority` = configured priority
   - `metadata.sentenceCue.{cueName, altCount}`

Blocks with no matching sentence in the buffer are dropped — if the
model hallucinates a sentence that wasn't in the input, the source
has no anchor for the splice and would mis-splice.

---

## Segmentation

```ts
export function segmentSentences(
  buffer: string,
  words: ReadonlyArray<string>,
): SentenceSpan[];
```

Each `SentenceSpan` carries `text`, `start` / `end` char offsets, and
`firstWordIndex` (the word-array index of the first word of the
sentence).

**Strategy** (regex `[^.!?]+(?:[.!?]+(?=\s|$)|$)/g`):

- Matches runs of non-terminators followed by one or more terminators
  AND either whitespace or EOF.
- Preserves the terminator on the sentence it terminates.
- Tolerates EOF without trailing punctuation.

**Known v1 limitations** (documented, not blocking):

- **Abbreviations split mid-token.** "Mr. Jones said hi." splits at
  "Mr." Recoverable failure mode — the LLM typically emits
  `ALT: NONE` for the fragment, so the user-visible effect is "no
  cue on the fragment" rather than "wrong cue".
- **URLs split at each period.** Same recovery — LLM cedes on the
  fragments.
- **Multi-line buffers** are tolerated; newlines INSIDE a sentence
  pass as whitespace.

The segmenter is intentionally simple. A proper sentence segmenter
(e.g. handling abbreviation lists, decimal numbers, etc.) is a v2
followup if the LLM-cede recovery proves insufficient in real use.

---

## Apply path — passive DynDef registration

Sentence-cues are CUES, not agents — the runtime does **NOT** modify
the user's prose when the LLM returns a rewrite. The original sentence
stays in the buffer; the rewrite is held in a DynDef and surfaces only
when the user explicitly cycles. This is the same passive surface
word-cues use.

The runtime resolver's sentence-cue branch (in
`resolver.ts:resolveAndApply`):

1. **Race-guard.** If `liveText.slice(spanStart, spanEnd) !==
   originalSentence`, the user edited the sentence mid-flight — bail.
2. **Managed-span overlap guard.** If `[spanStart, spanEnd)` overlaps
   an active selector/satellite pair (`SelectorSatelliteState.current`)
   OR any `blankName`-locked DynDef with a span (fluid-blank /
   transform-blank / config-intent / a prior sentence-cue), bail. A
   sentence-cue cycling Up across one of those would mid-overwrite
   the managed span. The May 2026 "took part of the satellite selector
   with it" misrender was the motivating incident.
3. **Register a DynDef** at the original sentence's first word index:
   - `originalWord` = original sentence
   - `alternatives` = the full `[original, ...rewrites]` array
   - `currentIndex` = **0** (passive — buffer shows `alternatives[0]`,
     which IS the original sentence)
   - `spanStart` / `spanEnd` = the ORIGINAL char range (no splice
     happened, no recalculation needed)
   - `blankName` = `sentence-cue:<cue-name>` — locks the entry
     against re-resolution and distinguishes it in logs from other
     span-bearing defs (fluid-blank, transform-blank, config-intent)

Cycling Up/Down at this def cycles through `alternatives` via the
existing `applyAltCycle` path — exactly the same primitive word-cues
use. Up at `currentIndex=N` moves to `N+1` and splices the new alt at
the live char range derived from the current alt's word count; Down
to `N-1` reverts. At `currentIndex=0` the buffer matches `alternatives[0]`
(the original sentence) so no splice is needed.

### Why passive (was agent-like in the May 2026 prototype)

Earlier builds of the sentence-cue branch auto-spliced `alternatives[1]`
the moment the LLM returned, registered the DynDef at `currentIndex: 1`,
and relied on cycling Down to restore the original. That was copied
from TransformBlank — but TransformBlank fires only after the user
explicitly types `_` to invoke it. Sentence-cues fire on plain prose
with no user opt-in keystroke, so the auto-splice behaviour was
**agent-like**: prose was rewritten in the background without consent,
and overlapping satellite pairs got mid-overwritten because the
auto-splice didn't check for managed-span overlap. The contract is
now "cue, not agent" — and the agentic harness test in
`tests/agentic/scenarios/` pins it.

---

## Word-cue suppression (design 4a: sentence wins outright)

After a sentence-cue applies, the resolver tracks:

```ts
let sentenceCueApplied: boolean = true;
let sentenceClaimWordStart: number = r.wordIndex;
let sentenceClaimWordEnd: number = r.wordIndex + sentenceWordCount - 1;
```

Subsequent iteration through the priority-sorted result list checks
each non-LLM-blank, non-sentence-cue result:

```ts
if (sentenceCueApplied && !isSentenceCue && !isLlmBlank) {
  if (r.wordIndex >= sentenceClaimWordStart
      && r.wordIndex <= sentenceClaimWordEnd) {
    continue;  // suppress — this word-cue is inside the sentence span
  }
}
```

Word-cue results OUTSIDE the sentence claim flow through normally
and surface as before. The suppression is strictly per-claim — not
"any sentence-cue fires suppresses every word-cue in the buffer".

**Why suppression instead of co-existence:** a sentence-cue rewrites
the entire sentence. Offering individual synonym cues for words INSIDE
that span would mean the user is being asked to cycle TWO competing
things at once (the whole sentence vs an individual word inside it).
Cleaner UX to commit to one rewrite gesture per span.

---

## v1 limitation: one sentence-cue per resolve pass

The resolver caps at one sentence-cue substitution per `resolveAndApply`
pass:

```ts
if (isSentenceCue && sentenceCueApplied) {
  this.adapter.log('debug', `Resolver: skipping additional sentence-cue ...`);
  continue;
}
```

Reason: each splice shifts downstream char and word indices. A
sentence-cue at `spanStart=20` after a prior splice at `[0,15)` that
grew to length 25 now needs to splice at `spanStart=30` instead.
Computing the shift across multiple in-pass splices without
re-segmenting is fragile.

v2 strategies (not implemented):

- **Reverse-order application** — process sentence-cue results in
  descending `spanStart` order so later splices don't shift earlier
  ones. Simplest fix; requires sorting the iteration order.
- **Single batched splice** — compute all replacements up front,
  apply as one multi-region splice with explicit position remapping.
  More complex but symmetric with how SpanFill handles its
  multi-region case.
- **Per-paragraph batching** — segment into paragraphs first, then
  sentences within each. Apply per-paragraph in one go. Smaller
  blast radius per LLM call too.

Multi-sentence buffers today get the first sentence-cued; remaining
sentences pass through unchanged. The bench validates per-sentence
expectations independently, so the test surface is unaffected.

---

## Per-cue prompt + format-spec composition

User authors write the INTENT in CUE.md body. The framework appends
the OUTPUT FORMAT spec automatically:

```ts
const ensuredPrompt = hasFormatSpec(promptText)
  ? promptText.trimEnd()
  : `${promptText.trimEnd()}\n\n${SENTENCE_ALT_FORMAT_SPEC}`;
```

`hasFormatSpec()` detects whether the user already included
`SENTENCE:` / `ALT:` markers in their prompt — if so, the framework
trusts the user's output spec verbatim (used for advanced cues that
need a different output shape).

The `SENTENCE_ALT_FORMAT_SPEC` constant carries:

- The line-delimited block shape (`SENTENCE:` / `ALT:` / `---`).
- The cede contract (`ALT: NONE` for fragments / code / already-meeting-intent).
- The rules per alt (preserve meaning + punctuation; complete sentence;
  ≥1 distinct alt).

Editing the format spec changes the bench's expected output shape
and the parser. **Re-run `tests/benchmarks/sentence-cues/run.ts`
across all providers before shipping.**

---

## Per-feature LLM routing

The runtime threads a `sentenceCues` `FeatureLLMSetting` through
`buildSourcesFromConfig` so authors can override the provider/model
for sentence cues specifically:

```yaml
# OPENCUES.md frontmatter
sentence-cues-provider: cerebras-gpt-oss
sentence-cues-model: gpt-oss-120b
```

Without overrides, sentence cues inherit the global `llm-provider:`
/ `llm-model:` defaults — same as every other LLM-driven source.

---

## Tests pinning this behaviour

| File | Pins |
|---|---|
| `packages/opencues-core/src/sources/sentence-cue-source.test.ts` | Segmenter offsets (single + multi-sentence + EOF tolerance), block parser (alts + cede + dedup), source class (supports cede on `_`, prose detection, priority defaults, emit shape with alternatives[0]=original, multi-sentence with mixed cede, LLM-error bail, hallucinated-sentence drop) |
| `packages/opencues-runtime/src/modules/resolver.test.ts` (`Resolver sentence-cue substitution` describe) | Splice happens, DynDef registered with correct alternatives + currentIndex=1 + blankName, race guard fires on mid-flight edits, word-cues inside sentence span are suppressed, word-cues OUTSIDE the span survive, v1 one-cue-per-resolve cap |
| `tests/benchmarks/sentence-cues/` (bench, not unit) | Recall ≥ 80% AND precision ≥ 95% on the 30-case suite across 5 providers (`groq`, `cerebras`, `gemini-flash-lite`, `claude-haiku`, `openai-nano`) |
| `packages/opencues-runtime/src/modules/feature-registry-alignment.test.ts` | `sentenceCuesMode` is registered AND categorized as settings-map-only (consumed by `resolver.ts:enableSentenceCues`, no `OpenCuesState` typed slot) |

---

## Related architecture docs

- [`feature-registry.md`](feature-registry.md) — adding `sentence-cues-mode` was one-line in FEATURES; the gate flows automatically.
- [`spans-and-cycling.md`](spans-and-cycling.md) — DynDef alternatives + cycling primitives the sentence-cue branch reuses.
- [`fluid-config.md`](fluid-config.md) — sibling capability with a similar bench/source/resolver pattern.

---

*Last updated: 2026-05-18.*
