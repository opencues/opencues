---
last_updated: 2026-04-22
---

# Multi-Word Spans

An alternative can be multiple words (e.g., `_` to "Sundar Pichai", "toy" to "stuffed animal"). Since the system tracks words by index, replacing one word with two shifts all subsequent indices. Span tracking solves this by mapping each word of a multi-word replacement back to the original index.

> **Two implementations.** The `globalThis._dynSpans` model described
> below is **Claude Code's local implementation** inside the tweakcc
> patches. The system-wide model used by `@opencues/runtime`
> (Chrome, OpenCode, Codex, and the future CC v3.x adapter) is
> different: spans live inside `DynDefs` (`packages/opencues-runtime/src/state/dyn-defs.ts`),
> N spans can be active concurrently, and stale defs are pruned via
> `pruneStale` with deterministic relocate. See
> `docs/architecture/spans-and-cycling.md` for that canonical reference.
> This page is preserved because the CC v2.x patches still use
> `_dynSpans` and the integration responsibilities at the bottom apply
> to either model.

---

## How It Works (Claude Code v2.x — `_dynSpans`)

1. **Cycle**: The user presses Up/Down on a highlighted word. The new alternative contains a space (e.g., "Sundar Pichai")
2. **Detect**: `_cycleAlt` splits the new alternative on whitespace and counts `_nwc` (new word count)
3. **Update span map**: If `_nwc > 1`, each position from `_spanStart` to `_spanStart + _nwc - 1` is recorded in `globalThis._dynSpans`
4. **Replace text**: The old text range (which may itself be a span) is located by scanning word positions, then the full range from the first span word to the last is replaced with the new alternative
5. **Clear on single**: If the user cycles back to a single-word alternative (`_nwc === 1`), `spanLength` is deleted from the word definition and all span entries for that range are removed from `_dynSpans`

---

## Span Map

All span state lives in `globalThis._dynSpans`, an object keyed by current word index. Each value has:

| Field | Type | Description |
|-------|------|-------------|
| `originalIndex` | number | The word index in the original (pre-replacement) word array where this span begins |
| `spanLength` | number | Total number of words in the current span |

The word definition (`_dWord`) also stores `spanLength` when the word is part of a span.

Example: input is `"The CEO of Google is _"` (indices 0-5). User cycles `_` to "Sundar Pichai":

```
_dynSpans = {
  5: { originalIndex: 5, spanLength: 2 },
  6: { originalIndex: 5, spanLength: 2 }
}
```

Both index 5 ("Sundar") and index 6 ("Pichai") map back to original index 5. The word definition at index 5 has `spanLength: 2`.

When the user cycles to a different multi-word alternative (e.g., "Jeff Bezos"), the old span entries are replaced. When cycling back to a single word (e.g., "Elon"), all span entries for that range are deleted.

---

## Navigation in Spans

The navigation filter in `dynamicHighlight.ts` (the `writeDynamicNavigation` function) handles spans with three checks per word at index `i`:

| Check | Variable | Meaning | Effect |
|-------|----------|---------|--------|
| Non-original span position | `_isNonOrigSpan` | `_spanInfo && _spanInfo.originalIndex !== i` | **Excluded** from `_targetIdx` -- navigation skips this word entirely |
| Span original | `_isSpanOriginal` | `_spanInfo && _spanInfo.originalIndex === i` | **Included** in `_targetIdx` -- this is the entry point for the span |
| In a span (original) | `_isInSpan` | `!!_spanInfo && !_isNonOrigSpan` | **Included** (same as span original for the first word) |

When `_cycleAlt` is invoked on any word index, it checks `_dynSpans` for that index. If a span entry exists, it redirects to `_dIdx = _span.originalIndex` before looking up the word definition. This means pressing Up/Down on any word in a span cycles the entire span.

During text replacement, `_cycleAlt` computes the old text range by joining all words from `_spanStart` to `_spanStart + _spanLen - 1`, locates that range in the text buffer, and replaces it with the new alternative.

Dimming also respects spans: a word at index `_ni` is dimmed if it is in a span (`_isInSpan`) and not part of the currently highlighted span (`_spanInfo.originalIndex !== _hlWordIdx`).

---

## Portability

### Standard (opencues-core)

- Alternatives are returned as plain strings; multi-word alternatives contain spaces
- Word indices in results always refer to the original (pre-replacement) positions
- opencues-core does not track span state -- it only provides the alternatives

### Integration responsibilities

- Maintain a span map (current word index to original index and span length) that updates on every cycle
- Redirect navigation so landing on any non-original span position jumps to the span's original index
- Skip non-original span positions during Left/Right word navigation
- Replace the full span range in the text buffer when cycling (not just a single word)
- Apply dimming and highlighting across all words in an active span
- Protect span words from receiving individual alternatives during re-analysis (check `_spanInfo.originalIndex !== _nw2.index` and null out alts if mismatched)
- Clear span tracking when the user cycles back to a single-word alternative
- **Reconcile span positions on every text change** — when the user types,
  any def whose words appear at a new contiguous position should be RELOCATED
  there (deterministic, only when exactly one match exists). This preserves
  cycle progress through prefix/middle edits. Ambiguous matches drop. See
  `docs/architecture/spans-and-cycling.md` § "Deterministic relocate" for
  the algorithm; `@opencues/runtime` ships a reference implementation in
  `DynDefs.pruneStale`.
