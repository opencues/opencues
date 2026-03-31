---
last_updated: 2026-03-31
---

# Alternative: Multi-Word Alternative Handling

> **STATUS: SUPERSEDED** — Multi-word alternatives are now supported via the span tracking system. See `docs/span-system.md` for the actual implementation. This document is kept as historical context for the design discussion that led to span tracking.

## Current Approach (Historical)

Multi-word alternatives (e.g., "stuffed animal" for "toy") were originally **filtered out** because they break index alignment. The span tracking system now handles this -- see `docs/span-system.md`.

> **HISTORICAL NOTE**: The filter shown below was from the old `llm-analyze.sh` bash script. LLM calls now go through cues-core's CueResolver.

```python
# Historical filter in llm-analyze.sh (no longer used)
elif ' ' not in p:
    alts.append(p)
```

## The Problem

The system uses **word indices** for tracking positions:

```
Text: "The boy gave his toy"
Indices: The(0) boy(1) gave(2) his(3) toy(4)
```

When "toy" is replaced with "stuffed animal":

```
Text: "The boy gave his stuffed animal"
Indices: The(0) boy(1) gave(2) his(3) stuffed(4) animal(5)
```

**Failures:**
1. Word count changes (5 → 6)
2. JSON still references `{index: 4, word: "toy"}` but index 4 is now "stuffed"
3. Linked words after index 4 are off by 1
4. Rendering and navigation have different word counts
5. Highlight applies to wrong positions

## Alternative Solution: Character-Based Positioning

Instead of word indices, track **character positions** (start/end offsets).

### Schema Change

**Current:**
```json
{
  "words": [
    {"index": 4, "word": "toy", "alts": ["toy", "doll", "stuffed animal"], "linked": [3]}
  ]
}
```

**Proposed:**
```json
{
  "words": [
    {
      "start": 18,
      "end": 21,
      "word": "toy",
      "alts": ["toy", "doll", "stuffed animal"],
      "linked": [{"start": 13, "end": 16}]
    }
  ]
}
```

### Implementation Changes

#### 1. [HISTORICAL] LLM Script (`llm-analyze.sh`)

Calculate character positions when building the JSON:

```python
# Build word list with positions
words_with_pos = []
pos = 0
for i, word in enumerate(word_list):
    start = text.find(word, pos)
    end = start + len(word)
    words_with_pos.append({
        'index': i,
        'word': word,
        'start': start,
        'end': end
    })
    pos = end

# In output, use start/end instead of index
result['words'][idx]['start'] = words_with_pos[idx]['start']
result['words'][idx]['end'] = words_with_pos[idx]['end']
```

#### 2. Navigation (`wordHighlight.ts`)

Change `_hlState` to track character range instead of word index:

```javascript
// Current
globalThis._hlState = {
  active: true,
  wordIndex: 4,
  ...
};

// Proposed
globalThis._hlState = {
  active: true,
  charStart: 18,
  charEnd: 21,
  ...
};
```

#### 3. Cycling (`dynamicHighlight.ts`)

When replacing, update ALL position references:

```javascript
// Calculate offset from replacement
var _lenDiff = _newWord.length - _oldWord.length;

// Update current word's end position
_dWord.end = _dWord.start + _newWord.length;

// Shift all words AFTER this one
for (var _wi = 0; _wi < _dWords.length; _wi++) {
  if (_dWords[_wi].start > _dWord.start) {
    _dWords[_wi].start += _lenDiff;
    _dWords[_wi].end += _lenDiff;
  }
}

// Update linked word positions similarly
if (_dWord.linked) {
  for (var _li = 0; _li < _dWord.linked.length; _li++) {
    var _link = _dWord.linked[_li];
    // Recalculate based on new positions...
  }
}
```

#### 4. Rendering (`wordHighlight.ts`)

Use character ranges directly instead of word index lookup:

```javascript
// Current: find word by index, then find its position
var _hlWordIdx = globalThis._hlState.wordIndex;
// ... loop to find position of word at index ...

// Proposed: use stored character positions directly
var _hlStart = globalThis._hlState.charStart;
var _hlEnd = globalThis._hlState.charEnd;
```

#### 5. Position Recalculation on Text Change

When text changes significantly, positions become invalid. Options:

**Option A: Clear definitions (current behavior)**
```javascript
if (_hlText !== _oldText) {
  globalThis._dynDefs = undefined;
}
```

**Option B: Attempt position remapping**
```javascript
if (_hlText !== _oldText) {
  // Try to find each word at its expected position
  for (var w of globalThis._dynDefs.words) {
    var newStart = _hlText.indexOf(w.word, w.start - 5); // fuzzy search
    if (newStart >= 0) {
      w.start = newStart;
      w.end = newStart + w.word.length;
    } else {
      w.invalid = true; // mark for exclusion
    }
  }
}
```

### Complexity Comparison

| Aspect | Index-Based (Current) | Character-Based (Alternative) |
|--------|----------------------|------------------------------|
| Schema | Simple | More complex |
| LLM output | Word indices only | Indices + positions |
| Position tracking | Implicit (via split) | Explicit offsets |
| Multi-word alts | Breaks system | Works correctly |
| Linked word updates | Simple index match | Position shift calculations |
| Text change handling | Clear all | Can attempt remap |
| Implementation effort | Done | Significant refactor |

### Recommendation

The current index-based approach with multi-word filtering is **sufficient** for most use cases:

- LLMs can usually find single-word synonyms
- Simpler code, fewer edge cases
- No position drift bugs

Consider the character-based approach only if:
- Multi-word alternatives are frequently needed
- Users request phrases like "stuffed animal", "ice cream", etc.
- The current filtering causes too many missing alternatives

### Files That Would Need Changes

> **HISTORICAL NOTE**: `llm-analyze.sh` is no longer used; LLM calls go through cues-core.

1. `src/patches/wordHighlight.ts` - Change state structure, rendering logic
2. `src/patches/dynamicHighlight.ts` - Position-aware replacement and shifting
3. `CLAUDE.md` - Update documentation

---

*Created: February 2025*
*Status: Not implemented - documenting for future reference*
