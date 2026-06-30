# blank-routing — sentence-aware shaped-blank routing bench

Deterministic A/B benchmark (no LLM) for the segment-boundary change in
`@opencues/core`'s shaped-blank router.

## What it measures

Shaped blanks (`volume 30 _`, `weather oslo _`, …) route by matching an anchored
grammar against the **segment** containing `_`. Originally that segment was the
physical **line** (newline-delimited), so a command written after a sentence
terminator on the same line — `let me check the audio. volume 30 _` — did **not**
fire: "volume" wasn't at the line start. fluid-config already anchored on the
**sentence** (`summonPhraseStart`), so the two routers disagreed and users
(reasonably) read "line" as "sentence".

The change routes both through one shared `segmentStart`: a command claims its
`_` when it leads its **sentence** (last `.`/`!`/`?`+space, CJK `。！？．`, or
newline). This bench scores the OLD (newline-only) vs NEW (sentence-aware)
boundary on the same labeled corpus to prove the change **recovers recall**
without **trading precision**.

## Run

```bash
npx tsx tests/benchmarks/blank-routing/sentence-boundary.ts
```

Exits non-zero if NEW ever scores below OLD on precision OR recall — so it
doubles as a regression gate, not just a report.

## Result (30 labeled cases)

|            | OLD (newline) | NEW (sentence) |
|------------|---------------|----------------|
| precision  | 100.0%        | 100.0%         |
| recall     | 47.1%         | **100.0%**     |

Recall gains land entirely in `sentence-same-line` (0/6 → 6/6),
`cjk-terminator` (0/2 → 2/2), and `decimal-then-cmd` (0/1 → 1/1). Precision
categories (`prose-precision`, `sentence-then-prose`, `connective-prefix`,
`decimal-guard`, `prev-line`) cede clean under both boundaries — decimals
(`3.5`, `gpt-5.4`) don't split, and a connective before the keyword
(`then weather tokyo _`) still cedes because a command must LEAD its sentence.

Re-run after any edit to `segmentStart` (`packages/opencues-core/src/segment.ts`)
or `lineWithBlank` (`blank-shapes.ts`).
