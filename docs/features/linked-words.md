---
last_updated: 2026-04-06
---

# Linked Words

Linked words are words that must change together when any one of them cycles. When the user cycles "boy" to "girl", the pronoun "his" simultaneously becomes "her". The LLM detects these semantic relationships and returns them as index arrays on each word definition.

---

## How It Works

1. **LLM detection**: The linked words prompt analyses the input and returns `linked` index arrays on each `CueResult` — e.g., word 0 ("boy") gets `linked: [3]` and word 3 ("his") gets `linked: [0]`
2. **Storage**: `linked` arrays are stored on the `WordDef` objects in `globalThis._dynDefs.words`
3. **Cycling trigger**: When the user presses Up/Down on a highlighted word, `_cycleAlt` checks `_dWord.linked`
4. **Propagation**: All linked words are updated to the same `currentAltIndex` and their text is replaced in a single pass

Detected relationship types include:
- **Gender agreement**: "The boy loves his dog" -- boy links to his
- **Number agreement**: "The cats chase their toys" -- cats links to their and toys
- **Verb agreement**: "She runs" -- she links to runs
- **Possession**: "John loves his car" -- John links to his

---

## CueResult Contract

The `CueResult` interface in `types.ts` defines the linked field:

```typescript
linked?: number[];
```

On `WordDef` (the runtime representation), this becomes:

```typescript
linked?: number[] | null;
```

Each entry is a zero-based word index into the whitespace-split word array. The relationship is symmetric: if word A lists B in its `linked` array, word B lists A in its `linked` array. The resolver merges `linked` arrays from multiple sources.

When building `WordDef` objects from `CueResult`, the integration stores `linked` directly:

```javascript
var _wdef = { index: _r.wordIndex, word: _r.word, alts: ..., linked: _r.linked || null, ... };
```

---

## Cycling Behaviour

The linked-word cycling logic lives in `_cycleAlt` inside `@opencues/runtime`. After the primary word is cycled to `_nextAlt`:

1. **Guard**: Check `_dWord.linked && _dWord.linked.length > 0`
2. **Iterate**: For each linked index `_lIdx`:
   - Skip if out of bounds (`_lIdx < 0 || _lIdx >= _allW.length`)
   - Find the linked word's definition (`_lDef`) in `_dWords`
   - Skip if the linked word has no alt at `_nextAlt` (`_lDef.alts.length <= _nextAlt`)
3. **Update index**: Set `_lDef.currentAltIndex = _nextAlt` (same position as the primary word)
4. **Get new text**: `_lNew = _lDef.alts[_nextAlt]`
5. **Replace in text**: Locate `_lOld` (the current text at `_lIdx`) by scanning forward through word positions using `_updW` (a map of already-updated indices), then splice `_lNew` into `_newText`
6. **Track**: Record `_updW[_lIdx] = _lNew` so subsequent linked replacements use correct positions

All linked replacements happen in the same pass before the text is committed to `globalThis._hlText` and `globalThis._hlState.text`. The user sees a single atomic update.

---

## Portability

### Standard (opencues-core)

- `CueResult.linked` array on each word contains indices of all co-dependent words
- The resolver merges `linked` arrays from multiple sources (e.g., LLM-detected gender + number agreement)
- Linked relationships are symmetric: if word A links to B, word B links to A
- The linked words prompt is a standard opencues-core prompt that detects semantic relationships automatically

### Integration responsibilities

- When cycling any word, check its `linked` array and update ALL linked words' `currentAltIndex` to match
- Replace the text of every linked word simultaneously so the user sees a single coordinated change
- Apply the highlighted visual state to all linked words when any one of them is focused
- Ensure linked word updates are atomic: partial updates (some words changed, others not) must not be visible to the user
