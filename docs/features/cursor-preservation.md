---
last_updated: 2026-07-04
---

# Cursor Position Preservation

When a word changes length during cycling, the cursor position must adjust so the user's editing position does not jump. Every cycling path (`Cycling` module, `packages/opencues-runtime/src/modules/cycling.ts`) computes the replacement's exact character range from the live buffer, then applies the same three-way cursor rule.

---

## How It Works

1. **Compute the replacement range** from the live word positions (`splitWords(event.text)`), not from a cached span — spans on a `DynDef` can drift across multi-word cycles, so recomputing from the live buffer every time is the single source of truth.
2. **Splice**: `before = text.slice(0, rangeStart)`, `after = text.slice(rangeEnd)`, `newText = before + nextWord + after`.
3. **Adjust the cursor** per the three-way rule below.
4. **Commit**: `adapter.setText(newText)` then `adapter.setCursorOffset(clampedCursor)` — the host applies both.

---

## Offset Calculation

Every cycling path (list-blank, blank-step, static-alts) uses the same three-way conditional, not a two-way one:

```ts
const lenDiff = nextWord.length - (rangeEnd - rangeStart);
const newCursor = cursorOffset <= rangeStart
  ? cursorOffset                        // cursor before the word: unchanged
  : cursorOffset >= rangeEnd
    ? cursorOffset + lenDiff             // cursor after the word: shifts by the delta
    : rangeStart + nextWord.length;      // cursor INSIDE the word: snaps to its new end
const clampedCursor = Math.max(0, Math.min(newCursor, newText.length));
```

| Condition | Result |
|-----------|--------|
| Cursor **before** the replaced range (`cursor <= rangeStart`) | Unchanged |
| Cursor **after** the replaced range (`cursor >= rangeEnd`) | Shifts by `lenDiff` (positive if the word grew, negative if it shrank) |
| Cursor **inside** the replaced range | Snaps to the end of the new word — there's no meaningful "same relative position" once the old word is gone |

This covers:
- **Step increment** (e.g., "9" → "10"): `lenDiff = 1`.
- **Alt cycling** (e.g., "dog" → "puppy"): `lenDiff = 2`.
- **Shorter replacement** (e.g., "puppy" → "cat"): `lenDiff = -2`.
- **Cursor at end of text**: always past `rangeEnd`, so it tracks correctly as text grows or shrinks.

Every downstream span-bound `DynDef` (e.g. a later sentence-cue in a multi-paragraph buffer) also gets its cached char offsets shifted by `lenDiff` when the splice happens (`DynDefs.shiftCharSpansAfter`) — without this, a def that starts after the replaced range would point at stale characters and mis-splice on its own next cycle.

---

## Portability

### Standard (opencues-core)

- Returns word indices and replacement text — no cursor logic
- Alternatives include the full replacement string, so the integration can compute length deltas
- Span results include `spanStart`/`spanEnd` to determine the range of text being replaced

### Integration responsibilities

- Supply `setText` + `setCursorOffset` on the `HostAdapter` — the shared runtime's `Cycling` module computes the offset and calls both
- If implementing cycling outside the shared runtime, recompute the replacement range from the LIVE buffer on every cycle (not a cached span) and apply the three-way cursor rule above
- Adjust for multi-word span replacements where a single word expands to multiple words or vice versa
- Ensure cursor repositioning happens atomically with the text replacement to avoid visual flicker
