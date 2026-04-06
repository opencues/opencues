---
last_updated: 2026-04-06
---

# Per-Word Clearing

When the user edits text, alternatives are preserved intelligently rather than discarding everything. Only the specific word positions that changed are invalidated, so unedited words keep their alternatives and remain navigable.

---

## How It Works

1. **On every text change** (`_hlText !== _oldText`), the `writeDynamicClearOnChange` code runs before any highlight or analysis logic
2. **Both old and new text** are split into word arrays (`_oldW`, `_newW`)
3. **For each position** up to `Math.min(oldLength, newLength)`, the old and new words are compared
4. **If a word changed and is in alts** — `_def.alts.indexOf(newWord) >= 0` — the `WordDef` is updated: `word` is set to the new word and `currentAltIndex` is set to the matching position. The word remains navigable (valid cycle)
5. **If a word changed and is not in alts** — `alts` is set to `null` and `currentAltIndex` is reset to 0. Any span data for that position is also deleted. The word becomes non-navigable until re-analyzed
6. **Removed words** — if `newLength < oldLength`, all `WordDef` entries at indices beyond the new length have their `alts` set to `null`
7. **`_wordCount`** is updated to the new word count after every pass

---

## Stale Detection

Stale detection also applies when LLM results return after a delay. The merge logic in `_dynTriggerAnalysis` checks each incoming result against the current text:

| Check | Action |
|-------|--------|
| `result.word !== _curTextWords[result.index]` | Skip — word changed during the LLM call |
| `result.index >= _curTextWords.length` | Skip — word was deleted |
| Old alt is a strict prefix of the current word | Skip old alt during merge (stale partial from mid-typing) |
| `_resolverGeneration` mismatch | Discard entire response (config was reloaded mid-flight) |
| Old entry has `source === "tips"` | Skip — tip-sourced entries are curated and not overwritten by LLM results |

**Merge behavior** for non-stale results: new alts go first, then valid old alts are appended (deduplicated). `currentAltIndex` is set to the current word's position in the merged alts list.

**Typing recovery:** "dog" -> "do" -> "dog" works because clearing sets `alts` to `null` but the auto-submit trigger re-analyzes the changed word. If the user types the word back before re-analysis completes, the eager tips lookup resolves it instantly from `_localCueMap`.

---

## Portability

### Standard (cues-core)

- Results are keyed by word index — the library has no built-in persistence across edits
- Each call to the resolver is independent; it does not track previous results
- Targeted-index support lets the caller request analysis for only the words that changed

### Integration responsibilities

- Maintain a `WordDef` array (or equivalent) that persists across text edits and maps word indices to their current text and alternatives
- On each edit, diff the old and new word arrays to determine which words changed, were added, or were removed
- Mark edited words as non-navigable when their current text does not match any known alternative
- Restore navigability immediately when the user types the word back to a value that matches an existing alternative
- Preserve the alternatives array for edited words so recovery is instant (no re-fetch needed)
- Trigger re-analysis only for words that genuinely need fresh alternatives (changed text, no local match)
