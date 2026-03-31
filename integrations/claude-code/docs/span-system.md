---
last_updated: 2026-02-17
---

# Span System for Multi-Word Alternatives

This document covers the span tracking system that enables multi-word alternatives (like "Sundar Pichai") to work correctly with word-index-based navigation.

## The Problem

The word highlight system uses word indices for navigation and cycling:

```
"The CEO of Google is _"
 0   1   2   3      4  5
```

When cycling the underscore to a multi-word alternative:

```
"The CEO of Google is Sundar Pichai"
 0   1   2   3      4  5      6
```

**Without span tracking:**
1. Word count changes (6 → 7)
2. "Sundar" becomes index 5, "Pichai" becomes index 6
3. Re-analysis gives each word its own alternatives
4. Cycling "Sundar" could produce another 2-word alt → 8 words
5. This cascades indefinitely

## The Solution: Span Groups

Track multi-word replacements as a single "span" that cycles together.

### Data Structures

**globalThis._dynSpans** - Maps word indices to span info:
```javascript
globalThis._dynSpans = {
  5: { originalIndex: 5, spanLength: 2 },  // "Sundar" → span starts at 5
  6: { originalIndex: 5, spanLength: 2 }   // "Pichai" → also part of span at 5
}
```

**spanLength on word definition** - Stored in _dynDefs:
```javascript
{
  index: 5,
  word: "Sundar Pichai",
  alts: ["_", "Sundar Pichai", "Larry Page", "Eric Schmidt"],
  spanLength: 2,  // This entry covers 2 words
  currentAltIndex: 1
}
```

### How It Works

#### 1. Cycling to Multi-Word Alt

When cycling from "_" to "Sundar Pichai":

```javascript
// In Up/Down handlers
var _newWordCount = _newWord.split(/\s+/).length;  // 2

if (_newWordCount > 1) {
  // Create span entries for each word position
  _dWord.spanLength = _newWordCount;
  for (var i = 0; i < _newWordCount; i++) {
    globalThis._dynSpans[_spanStart + i] = {
      originalIndex: _spanStart,
      spanLength: _newWordCount
    };
  }
}
```

#### 2. Text Replacement

The cycling code replaces ALL words in the span:

```javascript
// Find end of last span word (not just first word)
var _wEnd = _wStart;
for (var i = 0; i < _spanLen; i++) {
  var idx = _text.indexOf(_allW[_spanStart + i], _wEnd);
  _wEnd = idx + _allW[_spanStart + i].length;
}

// Replace entire span
var _newText = _text.slice(0, _wStart) + _newWord + _text.slice(_wEnd);
```

#### 3. Navigation to Span Word

When navigating to index 6 ("Pichai"):

```javascript
var _span = globalThis._dynSpans && globalThis._dynSpans[_dIdx];
if (_span) {
  _dIdx = _span.originalIndex;  // Redirect to index 5
}
```

This ensures cycling affects the entire span, not just the individual word.

#### 4. Protecting Spans During Re-Analysis

When new text triggers re-analysis, span words are protected:

```javascript
// In merge logic
var _spanInfo = globalThis._dynSpans && globalThis._dynSpans[_newW.index];
if (_spanInfo && _spanInfo.originalIndex !== _newW.index) {
  // This is a non-original span word (e.g., "Pichai" at index 6)
  // Skip it - don't give it individual alternatives
  _newW.alts = null;
  continue;
}

// Preserve spanLength on original entry
if (_oldW && _oldW.spanLength) {
  _newW.spanLength = _oldW.spanLength;
}
```

#### 5. Cycling Back to Single Word

When cycling from "Sundar Pichai" back to "_":

```javascript
if (_newWordCount === 1) {
  // Clear span tracking
  delete _dWord.spanLength;
  for (var i = 0; i < _spanLen; i++) {
    delete globalThis._dynSpans[_spanStart + i];
  }
}
```

## Example Flow

```
Initial: "The CEO of Google is _"
         _dynDefs.words[5] = { word: "_", alts: ["_", "Sundar Pichai", ...] }
         _dynSpans = {}

Cycle Up: "The CEO of Google is Sundar Pichai"
          _dynDefs.words[5] = { word: "Sundar Pichai", alts: [...], spanLength: 2 }
          _dynSpans = { 5: {orig: 5, len: 2}, 6: {orig: 5, len: 2} }

Re-analysis triggers:
          - Index 5 ("Sundar"): Protected, keeps original alts
          - Index 6 ("Pichai"): Skipped (non-original span position)

Navigate to index 6:
          - Redirects to index 5 (original)
          - Cycling replaces "Sundar Pichai" as unit

Cycle Down: "The CEO of Google is Larry Page"
            _dynDefs.words[5] = { word: "Larry Page", alts: [...], spanLength: 2 }
            _dynSpans = { 5: {orig: 5, len: 2}, 6: {orig: 5, len: 2} }

Cycle Down: "The CEO of Google is _"
            _dynDefs.words[5] = { word: "_", alts: [...] }
            _dynSpans = {}  // Cleared
```

## Context Invalidation

When the context around an underscore changes, cached alternatives become stale and must be invalidated.

### The Problem

```
Step 1: "The CEO of Google is _"
        → LLM returns: ["_", "Sundar Pichai", "Larry Page", ...]
        → _dynUnderscoreContext = "The CEO of Google is"

Step 2: Cycle to "Sundar Pichai", then back to "_"
        → Text: "The CEO of Google is _"
        → Alternatives still cached: ["_", "Sundar Pichai", ...]

Step 3: Change "Google" to "Microsoft"
        → Text: "The CEO of Microsoft is _"
        → BUG: Cycling still shows "Sundar Pichai" (wrong CEO!)
```

### The Solution

When underscore context changes, invalidate cached alternatives:

```javascript
var _underscoreContext = _curWords.filter(w => w !== "_").join(" ");
var _prevUnderscoreCtx = globalThis._dynUnderscoreContext || "";
var _contextChanged = _underscoreContext !== _prevUnderscoreCtx && _prevUnderscoreCtx !== "";

if (_contextChanged && globalThis._dynDefs) {
  // Find all underscore positions and clear their alts
  for (var i = 0; i < _curWords.length; i++) {
    if (_curWords[i] === "_") {
      var def = _dynDefs.words.find(d => d.index === i);
      if (def) {
        def.alts = null;           // Clear stale alternatives
        def.currentAltIndex = 0;
      }
      // Also clear span info
      if (globalThis._dynSpans) delete globalThis._dynSpans[i];
    }
  }
  // Trigger re-analysis with new context
  _needsAnalysis = true;
}
```

### Example with Context Change

```
Initial: "The CEO of Google is _"
         Context: "The CEO of Google is"
         Alts: ["_", "Sundar Pichai", "Larry Page", "Eric Schmidt"]

Change "Google" → "Microsoft":
         New context: "The CEO of Microsoft is"
         Context changed! → Clear alts, trigger re-analysis

After re-analysis:
         Alts: ["_", "Satya Nadella", "Bill Gates", "Steve Ballmer"]
```

### What Triggers Context Invalidation

| Change | Triggers Invalidation? |
|--------|------------------------|
| "Google" → "Microsoft" | ✅ Yes - context words changed |
| "CEO" → "founder" | ✅ Yes - context words changed |
| "is _" → "is _ today" | ✅ Yes - context words changed |
| Cycling underscore | ❌ No - only underscore changed |
| Adding space after underscore | ❌ No - context same |

## Rendering Behavior

Span words are rendered together as a unit for both dimming and highlighting.

### Span-Aware Dimming

All words in a span are dimmed together (gray) when not highlighted:

```javascript
var _spanInfo = globalThis._dynSpans && globalThis._dynSpans[_wi];
var _isInSpan = !!_spanInfo;
var _isInHighlightedSpan = _spanInfo && _spanInfo.originalIndex === _hlWordIdx;

// Dim if: (has alts OR is in span) AND not highlighted AND not in highlighted span
if ((_dynDef || _isInSpan) && _wi !== _hlWordIdx && !_isInHighlightedSpan) {
  _dimRanges.push({start: _wStart, end: _wStart + _w.length});
}
```

| Word | _isInSpan | Highlighted | Rendered |
|------|-----------|-------------|----------|
| "Sundar" (idx 5) | ✅ | ❌ | Dimmed (gray) |
| "Pichai" (idx 6) | ✅ | ❌ | Dimmed (gray) |
| "Sundar" (idx 5) | ✅ | ✅ (idx=5) | Highlighted (white) |
| "Pichai" (idx 6) | ✅ | ✅ (idx=5) | Highlighted (white) |

### Span-Aware Highlighting

When navigating to a span, ALL words in the span are highlighted white:

```javascript
// Calculate span length from definition
var _hlSpanLen = (_dynHlDef && _dynHlDef.spanLength) ? _dynHlDef.spanLength : 1;

// Check if word index is within the highlighted span range
var _isInHlSpan = (_wi >= _hlWordIdx && _wi < _hlWordIdx + _hlSpanLen);

if (_isInHlSpan && globalThis._dynDefs) {
  _hlRanges.push({start: _wStart, end: _wStart + _w.length});
}
```

### Span-Aware Navigation

Span originals are navigable even when the current word isn't directly in alts:

```javascript
var _spanInfo = globalThis._dynSpans && globalThis._dynSpans[i];
var _isNonOrigSpan = _spanInfo && _spanInfo.originalIndex !== i;
var _isSpanOriginal = _spanInfo && _spanInfo.originalIndex === i;

// Navigable if:
// - Matches base condition (number/gender) OR
// - Has dynamic alt (word in alts) OR
// - Is a span original (e.g., "Jeff" when alt is "Jeff Bezos")
// AND not a non-original span position (skip "Bezos")
if (((condition) || _hasDynAlt || _isSpanOriginal) && !_isNonOrigSpan) {
  _targetIdx.push(i);
}
```

**Why this matters**: When "Jeff Bezos" is displayed as two words, "Jeff" isn't directly in the alts array (which contains "Jeff Bezos"). Without `_isSpanOriginal`, "Jeff" wouldn't be navigable.

| Word | originalIndex | Navigable? | Reason |
|------|---------------|------------|--------|
| "Jeff" (idx 5) | 5 | ✅ Yes | Is span original |
| "Bezos" (idx 6) | 5 | ❌ No | Non-original span position |

## Edge Cases

### Variable-Length Cycling

When cycling between alternatives of different lengths:

| From | To | Action |
|------|-----|--------|
| "_" (1 word) | "Sundar Pichai" (2 words) | Create span |
| "Sundar Pichai" (2) | "Larry Page" (2) | Update span (same length) |
| "Larry Page" (2) | "_" (1) | Clear span |
| "Tim Cook" (2) | "Satya Nadella" (2) | Update span |

### Text Editing During Span

If user manually edits text while a span exists:
- Per-word clearing logic may invalidate the span
- Safe approach: Clear spans on any manual text change

### Multiple Spans

Multiple independent spans can exist:

```
"The _ of _ is _"
     5    7    9

After cycling all to multi-word:
_dynSpans = {
  5: {orig: 5, len: 2}, 6: {orig: 5, len: 2},   // "Sundar Pichai"
  8: {orig: 7, len: 2}, 9: {orig: 7, len: 2},   // "New York"  (indices shifted!)
  11: {orig: 9, len: 3}, 12: {orig: 9, len: 3}, 13: {orig: 9, len: 3}  // "San Francisco Bay"
}
```

**Note**: Index shifting when earlier spans change length is complex. Current implementation handles single spans well; multiple spans may have edge cases.

## Files

| File | Purpose |
|------|---------|
| `dynamicHighlight.ts` | Span creation/clearing in cycle handlers |
| `dynamicHighlight.ts` | Span protection in merge logic |
| `dynamicHighlight.ts` | Span-aware navigation (`_isSpanOriginal`, `_isNonOrigSpan`) |
| `dynamicHighlight.ts` | Span-aware dimming (`_isInSpan`, `_isInHighlightedSpan`) |
| `wordHighlight.ts` | Span-aware highlighting (`_hlSpanLen`, `_isInHlSpan`) |

## Complete Walkthrough Example

Here's a full example showing spans, context invalidation, and cycling:

### Step 1: Initial Input
```
User types: "The CEO of Google is _"

Text:        The  CEO  of  Google  is  _
Index:        0    1   2     3     4   5

_dynDefs.words[5] = {
  index: 5,
  word: "_",
  alts: ["_", "Sundar Pichai", "Larry Page", "Eric Schmidt"],
  currentAltIndex: 0
}
_dynSpans = {}
_dynUnderscoreContext = "The CEO of Google is"
```

### Step 2: Cycle to Multi-Word Alt
```
User presses Ctrl+Alt+Up → cycles to "Sundar Pichai"

Text:        The  CEO  of  Google  is  Sundar  Pichai
Index:        0    1   2     3     4     5       6

_dynDefs.words[5] = {
  index: 5,
  word: "Sundar Pichai",
  alts: ["_", "Sundar Pichai", "Larry Page", ...],
  currentAltIndex: 1,
  spanLength: 2          // NEW: tracks multi-word
}
_dynSpans = {
  5: { originalIndex: 5, spanLength: 2 },
  6: { originalIndex: 5, spanLength: 2 }
}
```

### Step 3: Re-Analysis Triggers (Adding More Text)
```
User types more: "The CEO of Google is Sundar Pichai and"

Re-analysis runs, but span is PROTECTED:
- Index 5 ("Sundar"): Has span, is original → preserve alts
- Index 6 ("Pichai"): Has span, NOT original → skip (no alts)
- Index 7 ("and"): No span → gets new alts from LLM
```

### Step 4: Navigate to Second Span Word
```
User navigates to index 6 ("Pichai")

_hlState.wordIndex = 6
_span = _dynSpans[6] = { originalIndex: 5, ... }
_dIdx = 5  // Redirected to original!

Cycling now affects the ENTIRE span (both "Sundar" and "Pichai")
```

### Step 5: Cycle to Different Alt
```
User presses Ctrl+Alt+Up → cycles to "Larry Page"

Before: "The CEO of Google is Sundar Pichai and"
After:  "The CEO of Google is Larry Page and"

Both words replaced as unit!
```

### Step 6: Cycle Back to Underscore
```
User presses Ctrl+Alt+Down twice → back to "_"

Text:        The  CEO  of  Google  is  _  and
Index:        0    1   2     3     4   5   6

_dynDefs.words[5] = {
  word: "_",
  alts: ["_", "Sundar Pichai", "Larry Page", ...],
  currentAltIndex: 0
  // spanLength removed
}
_dynSpans = {}  // Cleared!
```

### Step 7: Change Context
```
User changes "Google" to "Microsoft"

Text:        The  CEO  of  Microsoft  is  _  and

Context check:
  _underscoreContext = "The CEO of Microsoft is and"
  _prevUnderscoreCtx = "The CEO of Google is"
  DIFFERENT! → Invalidate underscore alts

_dynDefs.words[5].alts = null  // Cleared!
_needsAnalysis = true          // Trigger re-analysis
```

### Step 8: New Alternatives
```
After re-analysis completes:

_dynDefs.words[5] = {
  word: "_",
  alts: ["_", "Satya Nadella", "Bill Gates", "Steve Ballmer"],
  currentAltIndex: 0
}
_dynUnderscoreContext = "The CEO of Microsoft is and"

Now cycling shows Microsoft CEOs, not Google CEOs!
```

## Summary

| Feature | Purpose |
|---------|---------|
| **spanLength** | Track how many words a single alt occupies |
| **_dynSpans** | Map word indices to their span's original index |
| **Span protection** | Prevent re-analysis from splitting multi-word alts |
| **Context tracking** | Remember what context was used for underscore |
| **Context invalidation** | Clear stale alts when context changes |

## Related Documentation

- `docs/blank-system.md` - Fill-in-the-blank overview
- `docs/per-word-clearing.md` - How alternatives are preserved/invalidated
- `CLAUDE.md` - Feature 4: Dynamic Highlight

---

*Last updated: February 2026*
