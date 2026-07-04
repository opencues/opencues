---
last_updated: 2026-07-04
---

# Per-Word Clearing

When the user edits text, alternatives are preserved intelligently rather than discarding everything. Only the specific word positions affected by an edit lose their `DynDef`; unedited words keep their alternatives and remain navigable.

---

## How It Works

This is now the same mechanism [Deterministic Relocate](deterministic-relocate.md) describes — `DynDefs.pruneStale()` (`packages/opencues-runtime/src/state/dyn-defs.ts`), called from `Navigation.onTextChange` on every text change. Per-word clearing is really the "drop" outcome of that three-pass algorithm, not a separate mechanism:

1. **Classify each existing `DynDef`** against the current word array: does the word (or, for multi-word alternatives, the word sequence) at its stored index still match? If yes → **keep**, untouched.
2. **If not, look for a unique relocation** — does the def's current alternative appear at exactly one OTHER position in the buffer? If yes → **move** (this is what makes a cycled word survive a prefix insert elsewhere in the buffer; see deterministic-relocate.md for the collision rules).
3. **Otherwise → drop.** The def is deleted. The word at that position becomes non-navigable until something re-establishes a def for it (a fresh LLM resolve, or an instant local-tip match if the word happens to match a loaded `CUE.md`'s `## Tips`).

So editing "dog" to "do" drops dog's `DynDef` (no relocation match, "do" isn't one of dog's alternatives) — "do" is non-navigable until re-analyzed. Typing "dog" back doesn't instantly restore the OLD def (it was deleted, not cached) — it either waits for the next LLM resolve, or resolves immediately if "dog" is a local tip match (a `LocalCueSource` hit doesn't need history — it matches by word content, not by a preserved position).

---

## Stale LLM Result Handling

A separate concern from pruning: what happens when an LLM response for an OLDER version of the text arrives after the user kept typing. The `Resolver` (see [Auto-Submit](auto-submit.md)) tags every dispatch with a monotonic generation counter; a response whose generation no longer matches the resolver's current generation is discarded outright rather than merged — this handles the "user kept typing during the LLM round-trip, then a config reload happened" case at the coarsest level. Tip-sourced entries (`source: 'tips'`) are also never overwritten by LLM results, regardless of generation.

---

## Portability

### Standard (opencues-core)

- Results are keyed by word index — the library has no built-in persistence across edits
- Each call to the resolver is independent; it does not track previous results
- Targeted-index support lets the caller request analysis for only the words that changed

### Integration responsibilities

- Supply `HostAdapter.onTextChange` — the shared runtime's `Navigation`/`DynDefs` handle keep/move/drop for you
- If implementing outside the shared runtime: on each edit, classify each tracked def as keep (still matches its position), relocate (matches uniquely elsewhere), or drop (no match) — see [Deterministic Relocate](deterministic-relocate.md) for the exact three-pass algorithm and its collision-resolution rules
- Don't try to "restore" a dropped def from a cache — the design intentionally re-resolves (or falls through to an instant local-tip match) rather than keeping stale alternatives around
- Trigger re-analysis only for words that genuinely need fresh alternatives (dropped, no local match)
