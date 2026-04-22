---
last_updated: 2026-04-22
---

# Resolver Skip Filter

Before each LLM round-trip, the Resolver replaces words it already
"owns" with empty strings, so they're filtered out by every
`CueSource` and never sent to the model. This serves two purposes:

1. **Lower LLM bill.** Words that already have valid alternatives
   don't need to be re-asked.
2. **No alt-track drift.** Once the user cycles `attorney → lawyer`,
   the Resolver must not treat `lawyer` as a fresh word and ask the
   LLM what `lawyer`'s synonyms are — the answer would silently
   replace the original alt set, drifting from the user's chosen
   track.

This page describes the four conditions that fire the skip. The
opposite case (when *should* the Resolver re-resolve a word) is
covered by [Per-Word Clearing](per-word-clearing.md).

---

## How It Works

`CueResolver.resolveAndApply` (in `@opencues/runtime`) walks every
word in the live text and decides whether to send it. For each word
at index `i`:

| # | Condition | Action |
|---|---|---|
| 1 | The word IS `_` (blank) | **Always re-resolve.** Blank context can change between resolves; the answer depends on it. |
| 2 | `i` falls inside an active `SpanFillState` range (a blank-fill spanning multiple words) | **Skip.** Cycling owns these positions; the LLM would compete with the user's selection. |
| 3 | `findSpanContaining(i)` returns a multi-word static-alt span | **Skip.** Both the origin position and every inner position are owned by the cycled span. |
| 4 | A `DynDef` already exists at `i` AND `existing.originalWord === text[i]` OR `existing.alternatives[currentIndex].split(/\s+/)[0] === text[i]` | **Skip.** Either the word is unchanged since resolution, or the user has cycled to one of the alternatives — in both cases cycling owns the position. |

Words that pass all four checks are kept; everything else is replaced
with `''` in the `cleanWords` array passed to
`RoutedWordSourceGroup.resolve`. Empty strings are filtered out
upstream, so they never reach an LLM.

---

## Why filter #4 matters: alt-track drift

Without condition #4, a cycle followed by any text edit triggers a
silent track swap:

```
User types  "the attorney filed today"
Resolver    DynDef[1] = { originalWord: "attorney",
                          alternatives: ["attorney","lawyer","counsel","barrister"],
                          currentIndex: 0 }

User cycles word 1 once → "the lawyer filed today"
            DynDef[1].currentIndex = 1   (still pointing at "attorney"-track alts)

User types " quickly"   → "the lawyer filed today quickly"
            ↑ text-change pulse re-runs Resolver

Without filter #4:
  Resolver sees text[1] = "lawyer", checks DynDef[1].originalWord ("attorney")
  → no match → sends "lawyer" to the LLM
  → LLM returns ["client","customer","person"] (a "lawyer" track, not an
    "attorney" track)
  → DynDef[1] gets overwritten — user is now cycling client/customer/person.
  Cycle position appears unchanged but the track silently swapped.

With filter #4:
  Resolver sees text[1] = "lawyer", checks DynDef[1].alternatives[1] = "lawyer"
  → match on currentAlt's first word → skip.
  DynDef[1] unchanged. User cycles in the original attorney/lawyer/counsel/barrister
  track regardless of how much surrounding text they edit.
```

The "first word of `currentAlt`" detail is what makes this also work
for multi-word alternatives ("Sundar Pichai", "Hacker News"): the
first word lands in the same text position, so checking that one is
sufficient — the rest is governed by the multi-word span machinery
(filter #3).

---

## Code reference

- `packages/opencues-runtime/src/modules/resolver.ts:158` —
  `resolveAndApply` builds `cleanWords` with the four conditions
- Empty strings are filtered out by `RoutedWordSourceGroup.resolve`
  in `@opencues/core/src/sources/routed-word-source-group.ts` (every
  child `ConfigSource` ignores blank entries too)
- Tests pinning each condition: `resolver.test.ts` —
  - "does NOT send already-resolved words to the LLM"
  - "skips a word that has been CYCLED to one of the def's alternatives"
  - "skips both inner positions of a multi-word static-alt span"

The architecture-level walkthrough lives at
`docs/architecture/spans-and-cycling.md` § "Resolver loop" and
§ "Why filter #4 matters: alt-track drift".

---

## Portability

### Standard (`@opencues/core`)

- The resolver is purely functional — it answers "what should the
  alternatives for this word be?" given a text + word array.
- Empty-string words are universally treated as "skip"; the
  `RoutedWordSourceGroup` and every individual `ConfigSource`
  filter them out before LLM dispatch.
- The library has no concept of which words "belong to cycling" —
  that state lives in the runtime.

### Integration responsibilities (`@opencues/runtime`)

- Maintain `DynDefs` (or an equivalent index → WordDef map) so the
  filter has somewhere to look up "is this word already owned?"
- Maintain `SpanFillState` for active blank-fills.
- Apply the four-condition filter on every resolve. Don't re-roll
  this from scratch — use `Resolver.resolveAndApply`.
- Don't bypass the filter from per-host code paths; if you find
  yourself wanting "this one word, please re-ask the LLM", you
  almost certainly want to first clear the relevant DynDef
  (treat the word as unowned), not to bypass the filter.
