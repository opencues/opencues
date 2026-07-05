---
last_updated: 2026-04-22
---

# Deterministic Relocate

When the user types text *outside* a cycled word — prefixing the
sentence, inserting in the middle, deleting from the start — the
cycled word's index shifts. Without intervention, the runtime would
look at the new text, see no `DynDef` matches at the old index, and
silently drop the cycle progress.

Deterministic relocate fixes that. On every text-change pulse, each
`DynDef` is re-anchored to the position where its content currently
lives — but ONLY when that position is unambiguous. If two equally
good landing spots exist, the def is dropped. The user types a
disambiguation, the next pulse relocates cleanly.

This page describes the mechanism. The companion features are
[Per-Word Clearing](per-word-clearing.md) (which decides what to
do when a word's *text* changes) and the
[Resolver Skip Filter](resolver-skip-filter.md) (which prevents
cycled tracks from being LLM-overwritten).

---

## The problem it solves

```
User types  "the attorney filed today"
User cycles word 1 once  → "the lawyer filed today"
            DynDef[1] = { originalWord: "attorney",
                          alternatives: ["attorney","lawyer","counsel","barrister"],
                          currentIndex: 1 }

User prepends "Yesterday "  → "Yesterday the lawyer filed today"

Without relocate:
  text-change pulse runs pruneStale.
  DynDef at index 1: text[1] is now "the", not "lawyer". No match.
  → Drop DynDef[1].
  User's cycle progress is gone. Pressing Up/Down on "lawyer" does
  nothing until the LLM re-resolves it (now from scratch — the
  attorney→lawyer track is lost).

With relocate:
  pruneStale finds "lawyer" at exactly one position (index 2).
  → Decision: move DynDef[1] to index 2. Apply.
  User keeps cycling attorney/lawyer/counsel/barrister.
```

The conservative twist: when the def's content matches **multiple**
new positions (e.g. the user typed `"the lawyer the lawyer filed
today"`), relocate refuses to guess. The def is dropped. We'd
rather force the user to re-cycle than silently re-anchor a def to
the wrong word.

---

## The three-pass algorithm

`DynDefs.pruneStale(words)` runs every text-change pulse. Three
passes, no mutation until pass 3:

**Pass 1 — classify.** For each existing `DynDef[i]`, decide one of:

- `keep` — `_defMatchesAt(def, i, words)` returns true. The def's
  word(s) still live where they were.
- `move { to: j }` — content matches at exactly one different
  index `j` (`_findUniqueMatch` returns `j`).
- `drop` — no match, or ambiguous match (`_findUniqueMatch`
  returns `null` because the count is 0 or ≥2).

Decisions are recorded; nothing is mutated yet.

**Pass 2 — resolve collisions.** Two collision rules downgrade
`move` to `drop`:

- **Two moves to same target.** If `defA` wants `→ 5` and `defB`
  also wants `→ 5`, both drop. We don't pick a winner.
- **Move target occupied by a `keep`.** If `defA` wants `→ 5` and
  `decisions[5]` is `keep`, `defA` drops. We don't overwrite a
  def that's already correctly anchored.

**Pass 3 — apply.** Two sub-steps:

1. Delete every entry that isn't `keep` (clears slots so incoming
   moves can land).
2. Re-insert every `move` at its target index.

Why three passes instead of one: collision detection has to see
**all** decisions before any mutation. Single-pass mutation would
also break iteration order — a def moved to a higher index could
be re-evaluated under its new index and double-act.

---

## What counts as a "match"?

`_defMatchesAt(def, i, words)` is content-aware:

- For a single-word def: `words[i] === def.originalWord` OR
  `words[i] === def.alternatives[def.currentIndex].split(/\s+/)[0]`
  (the latter handles defs the user has cycled into a different alt).
- For a multi-word static-alt span: every word from `i` through
  `i + spanLength - 1` must match the corresponding word of the
  current alternative.

`_findUniqueMatch(def, words)` walks the new word array and counts
positions where `_defMatchesAt` would return true. Returns the
matching index when the count is exactly 1; `null` otherwise.

---

## Trade-offs

**Why "drop on ambiguity" rather than "pick the closest"?** Picking
the closest seems intuitive but bites in edge cases — if the user
duplicated the word as part of a refactor, "closest" is still the
wrong answer half the time. Forcing a re-cycle is annoying *once*;
silently anchoring to the wrong word is annoying *every time the
user looks at the cycled position and finds something different*.

**Why deterministic, not probabilistic?** Probabilistic relocate
would have to make decisions involving stale state (LLM cache,
previous edits, cursor position…) that the runtime doesn't keep
around. Deterministic = the only inputs are the def, the new
words array, and the matching rule. That's testable and
inspectable.

**Why three phases?** The naive single-pass version had two latent
bugs:

1. *Iteration-order hazards.* A def relocated from index 1 to index
   3 would be re-classified under index 3 in the same loop and
   potentially re-relocated again.
2. *Silent collisions.* Two defs both relocating to index 5 would
   race — last-write-wins, which is non-obvious from the code.

Three phases makes both impossible by construction.

---

## Code reference

- `packages/opencues-runtime/src/state/dyn-defs.ts:222` —
  `pruneStale` (the three-phase algorithm)
- `packages/opencues-runtime/src/state/dyn-defs.ts:275` —
  `_defMatchesAt` (the matching predicate)
- `packages/opencues-runtime/src/state/dyn-defs.ts:292` —
  `_findUniqueMatch` (the disambiguator)
- Scenario tests: `cycling.scenarios.test.ts` covers
  - relocate single-word, single-cycle through prefix edit
  - relocate with downstream defs shifting alongside
  - ambiguity drops (two equally good targets)
  - collision avoidance (move target already a `keep`)
  - relocate doesn't fire when no unique match exists

Architecture-level walkthrough lives at
`docs/architecture/spans-and-cycling.md` § "Deterministic relocate
— RESOLVED".

---

## Portability

### Standard (`@opencues/core`)

- The library has no concept of "previous text" — every resolve
  call is independent. Tracking what changed across calls is the
  runtime's job.
- The library returns alternatives keyed by the *current* word
  index in the input. It doesn't know whether the same word has
  moved across calls.

### Integration responsibilities (`@opencues/runtime`)

- Maintain `DynDefs` (or equivalent index → WordDef map) across
  text edits.
- On every text change, call `DynDefs.pruneStale(currentWords)` to
  reconcile def positions before any other downstream logic
  (rendering, LLM dispatch, cycling).
- Do NOT mutate `DynDefs` mid-pulse from other code paths between
  the edit event and `pruneStale`; the three-phase algorithm
  assumes the snapshot it takes in phase 1 is consistent with the
  state it mutates in phase 3.
- Multi-word static-alt spans are reconciled the same way — the
  matching predicate is span-aware.
