# Sentence Cues — architecture reference

Canonical doc for the `sentence-cues-mode` feature + the `scope:
sentence` per-cue declaration. User-facing summary:
[`docs/features/sentence-cues.md`](../features/sentence-cues.md).

This doc covers: the sentence-scope source class shape, the
**one-call-per-sentence** dispatch model (concurrency-capped) and why it
replaced batching, the segmentation strategy + known limitations, the
resolver substitution branch + word-cue suppression contract (design
decision 4a: sentence wins outright), multi-sentence handling (the v1
one-per-resolve cap is now lifted), priority placement vs other sources,
and what the bench validates.

Read this before touching:

- `packages/opencues-core/src/sources/sentence-cue-source.ts`
- the sentence-cue substitution branch in
  `packages/opencues-runtime/src/modules/resolver.ts`
- the `SINGLE_SENTENCE_FORMAT_SPEC` constant
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
70  word cues (typical)      per-word synonyms (spelling, formal connectors, ...)
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
2. **One LLM call PER SENTENCE**, fired through a concurrency cap
   (`SENTENCE_CUE_CONCURRENCY`, default 5, via `mapWithConcurrency`).
   Each call sends the STABLE `promptText` + `SINGLE_SENTENCE_FORMAT_SPEC`
   as the system message and just `SENTENCE: <one sentence>` as the user
   message.
3. Parse each response with `parseSingleSentenceAlts()` — read the
   `ALT:` lines (leading-whitespace tolerant); `ALT: NONE` → ceded.
4. **No matching step.** The call was scoped to a known sentence, so its
   alts attach directly to that sentence's span — there is nothing to
   align or mis-align.
5. For each non-ceded sentence with ≥1 alt, emit a `CueResult` with:
   - `wordIndex` = sentence's first word index
   - `alternatives` = `[originalSentence, ...rewrites]`
   - `spanStart` / `spanEnd` = char range of the sentence (from
     segmentation — never from the model, so a result can't point at
     chars the model invented)
   - `source` = `sentence-cue:<cue-name>`
   - `priority` = configured priority
   - `metadata.sentenceCue.{cueName, altCount}`

### Why per-sentence, not one batched call

The original design batched all N sentences into one call and matched a
labelled block back to each source span. That made the model
**intermittently drop a sentence** (~1/3 of runs on a 4-sentence CJK
buffer, usually the longest) — silently, no cede — and needed echo +
numbered-slot + text-matching + retry scaffolding just to re-align the
response. A single-sentence call can't drop "one of N". Measured: per-
sentence is **100% coverage** vs ~66% batched, at the **same wall-clock**
(calls run in parallel). Prefix caching is *not* the reason it's cheap —
the per-sentence system prompt is only ~256 cacheable tokens, so
`cached_tokens` saves negligible latency here (verified directly: genuine
cold ≈ warm ≈ ~300–700ms/call); the speed is parallelism + fast
generation. Principle: **never overload one call with N independent
jobs.** See [[feedback_never_overload_llm]] equivalent in CLAUDE.md.

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

**Strategy** (regex `[\s\S]+?(?:[.!?]+(?=\s|$)|[。！？．]+|$)/g`):

- Matches sentence content non-greedily up to a real terminator: ASCII
  `.!?` followed by whitespace/EOF, OR a CJK/fullwidth `。！？．`, OR EOF.
- The content run is `[\s\S]+?` (any char) — NOT a non-terminator class —
  so a mid-token ASCII period ("WCAG 2.1", "gpt-5.4", an IP/URL) is kept
  as content instead of dropping the text before it.
- CJK terminators split directly (no trailing space needed); the CJK
  comma `、` is deliberately not a terminator.
- **Zero-width chars** (ZWSP U+200B, ZWNJ U+200C — Claude Code's render-
  kick) are trimmed at span edges and a zero-width-only span is skipped,
  so a trailing `‌` is never segmented as a phantom sentence.
- A sentence that starts MID-WORD (spaceless CJK — the prior `。` has no
  following space) anchors to its CONTAINING word, not word 0.

**Known v1 limitations** (documented, not blocking):

- **Abbreviations split mid-token** when the period is followed by a
  space ("Mr. Jones"). Recoverable — the per-sentence call emits
  `ALT: NONE` for the fragment, so the effect is "no cue on the fragment".
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

## Multi-sentence handling (the v1 cap is LIFTED)

Every sentence-cue in a resolve pass now registers — the old "one
sentence-cue per resolve" cap was removed (June 2026). It existed to
avoid a word/char shift cascade when multiple sentences SPLICED in one
pass, but sentence-cue registration is **passive** (the def lands at
`currentIndex:0` against the unmodified buffer; nothing splices until the
user cycles), so there is no cascade to guard against. Resolver-side
details (per-sentence word-cue suppression, same-whitespace-word CJK
collisions re-homed to a synthetic DynDef key, the DimRender dedicated
pass) live in [docs/architecture/spans-and-cycling.md] and the resolver
source.

Cycling a length-changing sentence DOES shift downstream char spans; the
runtime handles that via `DynDefs.shiftCharSpansAfter` (see the cycling
module), not by capping registration.

---

## Per-cue prompt + format-spec composition

User authors write the INTENT in CUE.md body. The framework appends
the per-sentence OUTPUT FORMAT spec automatically and sends it as the
STABLE system message (one sentence per call — see the getCues flow
above):

```ts
const system = hasFormatSpec(promptText)
  ? promptText.trimEnd()
  : `${promptText.trimEnd()}\n\n${SINGLE_SENTENCE_FORMAT_SPEC}`;
```

`hasFormatSpec()` detects whether the user already included `ALT:`
markers in their prompt — if so, the framework trusts the user's output
spec verbatim (used for advanced cues that need a different output shape).

The `SINGLE_SENTENCE_FORMAT_SPEC` constant carries:

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
| `packages/opencues-core/src/sources/sentence-cue-source.test.ts` | Segmenter offsets (single + multi-sentence + EOF tolerance + trailing zero-width/ZWNJ trim + mid-word CJK anchor), per-sentence ALT parser (`parseSingleSentenceAlts`: alts + cede + dedup + leading-indent tolerance), `mapWithConcurrency` (order + in-flight cap), `estimateSentenceCueBudget`, source class (cede on `_`, prose detection, priority defaults, emit shape with alternatives[0]=original, one-call-per-sentence with mixed cede, every-sentence-emitted, span-from-segmentation, stable-system-prompt split, LLM-error bail) |
| `packages/opencues-runtime/src/modules/resolver.test.ts` (`Resolver sentence-cue substitution` describe) | Splice happens, DynDef registered with correct alternatives + **currentIndex=0** (passive — buffer shows the original sentence; cycling Up advances to 1) + blankName, race guard fires on mid-flight edits, word-cues inside sentence span are suppressed, word-cues OUTSIDE the span survive, and (per the `'registers EVERY sentence-cue in one resolve pass (v1 one-per-resolve cap lifted, June 2026)'` test) **multiple sentence-cue DynDefs now coexist in one resolve pass** — the earlier v1 one-cue-per-resolve cap was lifted |
| `tests/benchmarks/sentence-cues/` (bench, not unit) | Recall ≥ 80% AND precision ≥ 95% on the 30-case suite across 5 providers (`groq`, `cerebras`, `gemini-flash-lite`, `claude-haiku`, `openai-nano`) |
| `packages/opencues-runtime/src/modules/feature-registry-alignment.test.ts` | `sentenceCuesMode` is registered AND categorized as settings-map-only (consumed by `resolver.ts:enableSentenceCues`, no `OpenCuesState` typed slot) |

---

## Related architecture docs

- [`feature-registry.md`](feature-registry.md) — adding `sentence-cues-mode` was one-line in FEATURES; the gate flows automatically.
- [`spans-and-cycling.md`](spans-and-cycling.md) — DynDef alternatives + cycling primitives the sentence-cue branch reuses.
- [`fluid-config.md`](fluid-config.md) — sibling capability with a similar bench/source/resolver pattern.

---

*Last updated: 2026-05-18.*
