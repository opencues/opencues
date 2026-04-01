---
last_updated: 2026-04-01
---

# Cycling — Claude Code

Implements features 2, 5, 9, 10 from `docs/features.md`: Word Cycling, Linked Words, Multi-Word Spans, Per-Word Clearing.

**Patch files:** `patches/wordHighlight.ts` (numbers, gender), `patches/dynamicHighlight.ts` (LLM alts, action words, spans, clearing)

## Cycling Priority

When Up/Down is pressed on a highlighted word, checked in order:

1. **Action word** → spawn external script, return (word not modified)
2. **Gender root** (boy/girl) → hardcoded linked group flip, skip LLM alts
3. **Dynamic alts** → cycle through `alts` array
4. **Number** → increment/decrement
5. **Fall through** → no action

Implemented in the shared `_cycleAlt(dir)` function in `dynamicHighlight.ts`.

## Number Increment/Decrement

- **Up**: increments by 1 (no limit)
- **Down**: decrements by 1, floors at original value
- `originalNumbers` map (keyed by word index) stores each number's floor
- Floor captured on first Up/Down press, not when highlighting
- Navigating away and back preserves the floor

## Gender Flip

- **Up** flips only the selected root's linked group:
  - boy → girl, he → she, him → her, his → her, man → woman, he's → she's
- **Down** restores ALL words to original gender (stored in `originalGender`)
- Case preserved character-by-character (He→She, HIM→HER)
- Linked groups hardcoded in `wordHighlight.ts`:
  - Male: `['boy','he','him','his','man',"he's"]`
  - Female: `['girl','she','her','woman',"she's"]`
- Gender roots always skip dynamic alt cycling to ensure linked words change together

## Dynamic Alt Cycling

When a word has LLM or tips alternatives:

- `currentAltIndex` tracks position in cycle
- Up: `(currentAltIndex + 1) % alts.length`
- Down: `(currentAltIndex - 1 + alts.length) % alts.length`
- Original word is always `alts[0]`
- Linked words cycle to the same index simultaneously

The export JSON (`/tmp/claude-highlight-state-{PID}.json`) is also written directly inside `_cycleAlt` to ensure `currentAltIndex` is fresh for the status line.

## Linked Words

Words with `linked` arrays cycle together:

```json
{"index": 1, "word": "boy", "alts": ["boy", "girl", "child"], "linked": [3]}
{"index": 3, "word": "he", "alts": ["he", "she", "they"], "linked": [1]}
```

Cycling "boy" to "girl" also cycles "he" to "she" (same `currentAltIndex`).

Two sources of linked words:
- **Hardcoded** gender groups in `wordHighlight.ts` (always available)
- **LLM-detected** links via linked words prompt (stored in `_dynDefs.words[i].linked`)

## Multi-Word Spans

When an alternative is multiple words (e.g., `_` → "Sundar Pichai"):

- `_dynSpans` map tracks which word positions belong to a span
- All span words cycle as a unit
- Navigation to any span word redirects to the original index
- Non-original span positions skipped during navigation
- Dimming and highlighting apply to all span words
- Re-analysis protects span words from individual alternatives
- Cycling back to a single word clears span tracking

Span tracking updated in `_cycleAlt` after each replacement.

## Per-Word Clearing

When text changes, alternatives are preserved intelligently:

| Edit | Behaviour |
|------|-----------|
| Word changes to value IN alts | Update `currentAltIndex` |
| Word changes to value NOT in alts | Clear alts for that word |
| Word count increases | Existing alts preserved, new words analysed |
| Word count decreases | Removed positions have alts cleared |
| Word typed back to original | Alts restored (never deleted during same-count edits) |

Navigation and rendering also check `alts.indexOf(word) >= 0` — a word is only navigable/dimmed if it currently matches an entry in its alts array.

## Related

- `navigation.md` — how to get to a word
- `alternatives.md` — how alternatives are generated
- `config.md` — all config options
