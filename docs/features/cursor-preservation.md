---
last_updated: 2026-04-06
---

# Cursor Position Preservation

When a word changes length during cycling or number increment/decrement, the cursor position must adjust so the user's editing position does not jump. The system calculates a length delta and applies it conditionally based on where the replacement occurs relative to the cursor.

---

## How It Works

1. **When cycling or incrementing**, the code locates the highlighted word's start position (`_wStart`) by walking the word array and calling `text.indexOf(word, wordPos)` for each word up to the target index
2. **The old word is spliced out** and the new word is spliced in: `text.slice(0, _wStart) + newWord + text.slice(_wEnd)`
3. **The cursor offset is adjusted** based on the replacement position relative to the current offset
4. **A new `InputZone`** is created via `InputZone.fromText(newText, config, newOffset)`, which triggers React's re-render with both the updated text and the corrected cursor position

---

## Offset Calculation

The offset logic is a single conditional:

```
var _lenDiff = _newWord.length - _word.length;
var _newOffset = _wStart < inputZone.offset
    ? inputZone.offset + _lenDiff
    : inputZone.offset;
```

| Condition | Result |
|-----------|--------|
| Replacement is **before** the cursor (`_wStart < offset`) | Offset shifts by `_lenDiff` (positive if word grew, negative if it shrank) |
| Replacement is **at or after** the cursor (`_wStart >= offset`) | Offset unchanged |

This handles all cases:
- **Number increment** (e.g., "9" -> "10"): `_lenDiff = 1`, cursor moves right by 1 if it was after the number
- **Alt cycling** (e.g., "dog" -> "puppy"): `_lenDiff = 2`, cursor moves right by 2 if it was after the word
- **Shorter replacement** (e.g., "puppy" -> "cat"): `_lenDiff = -2`, cursor moves left by 2 if it was after the word
- **Cursor at end of text**: The cursor is always after the replacement, so it tracks correctly as text grows or shrinks

The same logic applies in both the Up (increment/next-alt) and Down (decrement/prev-alt) key handlers, using identical `_lenDiff` / `_newOffset` / `fromText` patterns.

---

## Portability

### Standard (cues-core)

- Returns word indices and replacement text — no cursor logic
- Alternatives include the full replacement string, so the integration can compute length deltas
- Span results include `spanStart`/`spanEnd` to determine the range of text being replaced

### Integration responsibilities

- When text changes (cycling, auto-populate, span replacement), calculate the new cursor offset based on the insertion/deletion position and the length delta
- Handle the "cursor at end" special case so the cursor tracks the growing text
- Adjust for multi-word span replacements where a single word expands to multiple words or vice versa
- Ensure cursor repositioning happens atomically with the text replacement to avoid visual flicker
