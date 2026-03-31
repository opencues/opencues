---
last_updated: 2026-02-12
---

# Per-Word Alternative Clearing System

This document explains how the dynamic highlight system intelligently preserves word alternatives when the user edits text.

## Overview

When the user edits text after getting LLM alternatives, the system uses **word-level invalidation** to preserve as many alternatives as possible:

- **Word in alts** → update currentAltIndex (valid cycle)
- **Word NOT in alts** → clear alts, reset index (handles mid-sentence insertion/deletion)
- **Word count decreased** → clear alts for removed positions only
- **Word count increased** → preserve existing alts, auto-submit fetches new ones

## Scenarios

### Scenario 1: Valid Cycle (Word IN alternatives)

**Example:**
- Text: "The brave boy"
- Word "brave" has alts: `["brave", "courageous", "timid", "bold"]`
- User cycles with Up/Down to "courageous"

**Behavior:**
- `_def.alts.indexOf("courageous") >= 0` → TRUE (word is in alts)
- Updates `_def.word = "courageous"`
- Updates `_def.currentAltIndex = 1`
- **Alternatives PRESERVED** ✓

### Scenario 2: Word Changed (Word NOT in alternatives)

**Example:**
- Text: "The brave boy"
- Word "brave" has alts: `["brave", "courageous", "timid", "bold"]`
- User changes "brave" to "big"

**Behavior:**
- `_def.alts.indexOf("big") >= 0` → FALSE (word not in alts)
- **Alts CLEARED** - `_def.alts = null`, `_def.currentAltIndex = 0`
- Span info also cleared for that position
- Auto-submit will re-fetch alts for "big" on next trigger

**Why this matters:**
- Prevents stale alts from persisting when words shift (e.g., inserting a word mid-sentence)
- Without clearing, "the boy ran" → "the big boy ran" would leave ran's alts on "boy"

### Scenario 3: Word Count Increased (Add Words)

**Example:**
- Text: "The brave boy" (3 words)
- User types "The brave boy ran" (4 words)

**Behavior:**
- Word count increased
- Existing words at same positions → **alts PRESERVED** ✓
- New word "ran" → no alts yet (auto-submit will fetch)
- In auto-submit mode: re-analysis triggers immediately (0ms debounce), merges results

### Scenario 4: Word Count Decreased (Remove Words)

**Example:**
- Text: "The brave boy ran" (4 words)
- User deletes "ran" → "The brave boy" (3 words)

**Behavior:**
- Words at positions 0-2 → **alts PRESERVED** ✓
- Position 3 ("ran") → alts cleared (word removed)

### Scenario 4: Text Unchanged (No Action)

**Example:**
- Text: "The brave boy"
- User navigates (Ctrl+Alt+Left/Right) without changing text
- Invisible char toggle happens but actual text unchanged

**Behavior:**
- `_hlText !== _oldText` → FALSE (text stripped of invisible chars is same)
- **No clearing happens** ✓

## Code Location

**File:** `/home/wilfred/tweakcc-source/src/patches/dynamicHighlight.ts`

**Function:** `writeDynamicClearOnChange()`

**Insertion Point:** After `globalThis._hlText=_hlText;` and BEFORE the highlight-active check

## Implementation

```javascript
// Word-level invalidation - runs on EVERY text change
if(_hlText!==_oldText&&globalThis._dynDefs&&globalThis._dynDefs.words){
  var _oldW=_oldText.split(/\s+/).filter(function(w){return w;});
  var _newW=_hlText.split(/\s+/).filter(function(w){return w;});
  var _minLen=Math.min(_oldW.length,_newW.length);

  // Check each position up to min length
  for(var _wi=0;_wi<_minLen;_wi++){
    if(_oldW[_wi]!==_newW[_wi]){
      var _def=globalThis._dynDefs.words.find(function(d){return d.index===_wi;});
      if(_def){
        if(_def.alts&&_def.alts.indexOf(_newW[_wi])>=0){
          // Word is in alts - valid cycle, update index
          _def.word=_newW[_wi];
          _def.currentAltIndex=_def.alts.indexOf(_newW[_wi]);
        }else{
          // Word NOT in alts - clear alts
          // Handles mid-sentence insertion/deletion where indices shift
          _def.word=_newW[_wi];
          _def.alts=null;
          _def.currentAltIndex=0;
          if(globalThis._dynSpans)delete globalThis._dynSpans[_wi];
        }
      }
    }
  }

  // Handle removed words (invalidate defs beyond new length)
  if(_newW.length<_oldW.length){
    for(var _ri=_newW.length;_ri<_oldW.length;_ri++){
      var _rdef=globalThis._dynDefs.words.find(function(d){return d.index===_ri;});
      if(_rdef){_rdef.alts=null;}
    }
  }

  // Track word count for debugging
  globalThis._dynDefs._wordCount=_newW.length;
}
```

**Navigation also checks word is in alts:**
```javascript
// Word must be IN alts array to be navigable
var _hasDynAlt=globalThis._dynDefs&&globalThis._dynDefs.words&&
  globalThis._dynDefs.words.find(function(d){
    return d.index===i && d.alts && d.alts.length>1 && d.alts.indexOf(w)>=0;
  });
```

## Key Design Decisions

### 1. Runs Unconditionally (Not Inside Highlight-Active Check)

The per-word clearing runs BEFORE the `if(globalThis._hlState&&globalThis._hlState.active)` check. This ensures alternatives are cleared even when:
- User edits text without first navigating
- User types immediately after getting LLM result

### 2. Uses Tokenization for Word Comparison

Words are compared by splitting on whitespace:
```javascript
var _oldW=_oldText.split(/\s+/).filter(function(w){return w;});
var _newW=_hlText.split(/\s+/).filter(function(w){return w;});
```

This handles multiple spaces and leading/trailing whitespace.

### 3. Index-Based Matching

Words are matched by their index in the split array, which corresponds to the `index` field in `_dynDefs.words`. This is why word count changes require clearing everything - indices would become misaligned.

### 4. Preserves Other Word State

When one word's alternatives are cleared, other words' alternatives remain intact. This allows partial editing without losing all LLM context.

## Interaction with Other Systems

### With Cycling (Up/Down)

When user cycles with Up/Down:
1. Cycling code changes text directly
2. Per-word clearing sees the change
3. New word is IN alts → alternatives preserved
4. `currentAltIndex` updated to reflect new position

### With Navigation (Left/Right)

Navigation doesn't change text content (only invisible char toggle), so per-word clearing doesn't activate.

### With UI Refresh

After per-word clearing runs, if any changes were made, the UI automatically reflects them on next render pass.

## Testing Checklist

### Submit Trigger Mode
- [ ] Type "The brave boy submit" → get alternatives
- [ ] Cycle "brave" with Up → becomes "courageous", alternatives preserved
- [ ] **Recovery test:** delete 'e' → "brav" not navigable → type 'e' → "brave" navigable again!
- [ ] Navigate to "boy" → still has alternatives
- [ ] Add a word "The brave boy ran" → existing alts preserved, "ran" has no alts
- [ ] Type "submit" again → all words get fresh alternatives

### Auto-Submit Mode
- [ ] Type "The" → wait 500ms → (no alternatives for "The")
- [ ] Type "boy" → wait 500ms → "boy" gets alternatives, turns gray
- [ ] Type "said" → wait 500ms → "said" gets alternatives, "boy" alts preserved
- [ ] Edit "boy" to "girl" (if in alts) → alternatives preserved, currentAltIndex updated
- [ ] Edit "boy" to "bo" → not navigable, but alts preserved
- [ ] Type "y" back → "boy" navigable again with same alts

## Key Behavior

| Action | Old Behavior | New Behavior |
|--------|--------------|--------------|
| Word not in alts | Alts DESTROYED | Alts PRESERVED |
| Word count increased | All alts cleared | Existing alts preserved |
| Word count decreased | All alts cleared | Only removed positions cleared |
| Auto-submit result | N/A | Merges with existing alts |
