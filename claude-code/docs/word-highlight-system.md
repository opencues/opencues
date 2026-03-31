---
last_updated: 2026-03-27
---

# Word Highlight Navigation System

This document explains the word highlight feature implementation, including the technical challenges solved and quirks to be aware of for future maintenance or reimplementation.

## Feature Overview

**Purpose**: Navigate between words (or numbers only) in Claude Code's input box using keyboard shortcuts and visually highlight the selected token.

**Four Navigation Modes** (configured via `highlightMode`):

| Mode | Behavior | Example |
|------|----------|---------|
| `'numbers'` | Only jump between numeric tokens | `"abc 1 test 3"` → 3 → 1 (skips abc, test) |
| `'words'` | Jump between all words | `"abc 1 test 3"` → 3 → test → 1 → abc |
| `'gender'` | Only jump between boy/girl (root words) | `"The boy said he"` → only "boy" selectable |
| `'both'` | Jump between numbers AND boy/girl | `"The boy has 3 cats"` → 3 → boy (both selectable) |

**Gender mode** flips linked word groups on Up/Down:
- If "boy" selected: flips boy→girl, he→she, him→her, his→her, man→woman, he's→she's
- Down restores ALL words to original gender (stored in `originalGender` state field)
- Case is preserved character-by-character (He→She, HIM→HER)

**Number Pattern**: `/^-?\d+(\.\d+)?$/` matches:
- Integers: `42`, `0`, `123`
- Decimals: `3.14`, `0.5` (requires digits after decimal)
- Negatives: `-5`, `-3.14`
- Note: `"2."` does NOT match (prevents edge case bugs with trailing decimals)

**Keyboard Shortcuts**:
- `Ctrl+Alt+Left`: Move highlight to the left (toward start of text)
- `Ctrl+Alt+Right`: Move highlight to the right (toward end of text)
- `Ctrl+Alt+Up`: Increment highlighted number by 1
- `Ctrl+Alt+Down`: Decrement highlighted number (stops at original value)
- `Escape`: Clear highlight
- Any typing: Clear highlight

**Number Increment/Decrement**:
When a number is highlighted, Up/Down keys modify the actual text:
- **Up**: Increments by 1 (no upper limit)
- **Down**: Decrements by 1, but never below the `originalNumber`

The `originalNumber` is captured on the **first Up or Down press**, NOT when highlighting. This means it stores the pre-edit value.

Each number tracks its own floor independently via the `originalNumbers` map keyed by word index. This means you can navigate to a different number, edit it, and come back - the original floor is preserved.

Example: Highlight "0", press Up 4 times → 1 → 2 → 3 → 4. Press Down 6 times → 3 → 2 → 1 → 0 → 0 → 0 (floors at 0, which was the value before any edits). Navigate to another number "5", press Up → 6. Navigate back to the "4" (which is now showing 4), press Down → 3 → 2 → 1 → 0 (still floors at 0).

**Token Indexing**: Right-to-left (rightmost token = index 0)

**Visual**: Highlighted token appears in bold white text

---

## Architecture Overview

The system consists of six injected patches:

| Patch | Location | Purpose |
|-------|----------|---------|
| Key Handler | `VA()` switch statement | Detect Ctrl+Alt+Left/Right/Up/Down key properties |
| Raw Sequence | Default case nested switch | Fallback for `\x1B[1;7D/C/A/B` raw sequences |
| Clear on Escape | Escape case handler | Clear highlight state on Escape |
| Clear on Typing | Input handler function | Clear highlight on text changes, strip invisible chars |
| Rendering | `renderedValue` wrapper | Apply white color to highlighted word |
| Status Line Trigger | INK component | Expose `_triggerStatusLineRefresh` for status line updates |

**State Storage** (globalThis):
- `_hlState`: `{active: boolean, index: number|null, wordIndex: number|null, text: string, originalNumbers: object}`
- `_hlText`: Current input text (stripped of invisible chars)
- `_parentValue`: Raw parent value for toggle detection

**State Fields**:
- `active`: Whether highlight is currently active
- `index`: Index into filtered array (numbers in 'numbers' mode, all words in 'words' mode)
- `wordIndex`: Actual index into all-words array (for rendering)
- `text`: Stored text when highlight was activated
- `originalNumbers`: Map of `wordIndex -> originalNumber` for tracking each number's floor independently

---

## State Management

### In-Memory Storage via globalThis

All state is stored in `globalThis` (the JavaScript global object):

```javascript
globalThis._hlState      // {active: bool, index: number|null, wordIndex: number|null, text: string, originalNumbers: {}}
globalThis._hlText       // Current text (stripped of invisible chars)
globalThis._parentValue  // Raw parent value for toggle detection
```

**Characteristics**:
- **No persistence**: State is lost on Claude Code restart
- **No serialization**: Pure JS objects, no JSON parsing overhead
- **Shared scope**: globalThis is accessible from all injected code
- **No React integration**: Bypasses React's state management entirely

### Why globalThis Instead of React State?

We can't use React state because:
1. We're injecting into minified code - no access to `useState`/`useReducer`
2. The key handler (VA) runs in a different scope than the input handler
3. We need to pass data between patches (parent value → key handler)

---

## Efficiency Analysis

### Per-Keystroke Overhead

On **every keystroke** (not just navigation), this code runs:

```javascript
// 1. Store parent value (string reference)
globalThis._parentValue = A;

// 2. Check for invisible chars (O(n) indexOf × 2)
if (R.text.indexOf("\u200B") >= 0 || R.text.indexOf("\u200C") >= 0) {
  // Strip and create new InputZone
}

// 3. Clear-on-typing detection (O(n) × 2 regex replaces)
var _hlText = A.replace(/[\u200B\u200C]/g, "");
```

**Cost**: ~4-6 × O(n) string operations per keystroke

### Per-Render Overhead

**When highlight inactive** - O(1) early exit:
```javascript
if (!globalThis._hlState || !globalThis._hlState.active) return _rv;
```

**When highlight active** - Full ANSI-aware processing:
- Strip ANSI codes: O(n)
- Split into words: O(n)
- Find word position: O(words)
- Character walk with ANSI detection: O(n × m)

### Efficiency Summary

| Operation | Frequency | Complexity | Objects Created |
|-----------|-----------|------------|-----------------|
| Any keystroke | Every input | O(n) × 4-6 | 0-1 InputZone |
| Navigation | Ctrl+Alt+Arrow | O(n) × 4 | 1 InputZone |
| Render (inactive) | Every render | **O(1)** | None |
| Render (active) | Every render | O(n × m) | Strings |

### Memory Footprint

**Persistent**: ~100 bytes + 2 string references
**Per-render (temporary)**: O(n) for output string, GC'd immediately

### Verdict

**Typical use** (< 5KB input): Imperceptible overhead
**Edge cases** (> 50KB input): May lag when highlight active

The implementation trades efficiency for correctness - the toggle mechanism was necessary to reliably trigger React re-renders.

---

## The Core Challenge: Triggering React Re-renders

### The Problem

Claude Code's input system uses React with optimizations that prevent unnecessary re-renders. When the user presses our navigation keys, we need to:

1. Update highlight state (`globalThis._hlState`)
2. Trigger a visual refresh so the new highlight appears

Simply updating state isn't enough because the rendering only happens when React re-renders the component.

### How Claude Code's Input Refresh Works

The input handler `BA()` processes keystrokes:

```javascript
function BA(AA, wA) {
  let zA = VA(wA)(KA);  // Call key handler, get new InputZone

  if (zA) {
    if (!R.equals(zA)) {                    // Equality check
      if (R.text !== zA.text) K(zA.text);  // onChange - triggers re-render
      k(zA.offset);                         // onOffsetChange
    }
  }
}
```

**Key insight**: `K()` (onChange callback) is ONLY called when **text changes**. The `k()` callback alone doesn't trigger a full re-render.

### Failed Approaches

1. **Returning unchanged R**: `R.equals(R)` is TRUE → no callbacks → no refresh

2. **Calling k(offset) directly**: Only onOffsetChange fires. React deprioritizes offset-only changes → ~500ms lag

3. **Toggling offset**: Even if equals() returns FALSE, K() still isn't called because text hasn't changed

4. **insert(" ").backspace()**: After inserting and deleting, text is unchanged, so K() isn't called

---

## Solution: Invisible Character Toggle

### The Mechanism

We force text changes using TWO invisible Unicode characters that toggle:
- `\u200B` (zero-width space)
- `\u200C` (zero-width non-joiner)

Each navigation produces a **different** text value, ensuring `K()` is always called.

### Why Two Characters?

If we only used one character:
1. First nav: `"hello"` → `"hello\u200B"` ✓ (different)
2. Second nav: Strip to `"hello"` → insert → `"hello\u200B"`
3. But parent already has `"hello\u200B"`! → Same value → No re-render

By toggling between two characters:
1. First nav: `"hello"` → `"hello\u200B"` ✓
2. Second nav: Parent has B → insert C → `"hello\u200C"` ✓ (different!)
3. Third nav: Parent has C → insert B → `"hello\u200B"` ✓ (different!)

### Parent-Based Toggle

The key handler doesn't check what R has - it checks what the **PARENT** has (stored in `globalThis._parentValue`), then inserts the **opposite**:

```javascript
var _parentHasB = globalThis._parentValue.indexOf("\u200B") >= 0;
var _parentHasC = globalThis._parentValue.indexOf("\u200C") >= 0;

if (_parentHasB) return fromText(R.text + "\u200C", G, R.offset);
else if (_parentHasC) return fromText(R.text + "\u200B", G, R.offset);
else return fromText(R.text + "\u200B", G, R.offset);
```

---

## Quirk #1: The "Cursor Wall" Bug

### The Problem

Early implementation used `R.insert("\u200B")` which inserts at the **cursor position**. This caused a "cursor wall" - after highlighting, the cursor couldn't move past the position where it was when highlight was activated.

### Root Cause

When inserting at cursor position:
1. User positions cursor at position 6
2. Highlight inserts invisible char at position 6
3. Text becomes `"hello \u200Bworld"` with cursor at 7
4. Even after stripping, something about the insertion/stripping cycle at that position interfered with cursor movement

### The Fix

**Append at END** instead of inserting at cursor:

```javascript
// BAD - inserts at cursor position
return R.insert("\u200B");

// GOOD - appends at end, preserves cursor position
return i5.fromText(R.text + "\u200B", G, R.offset);
```

The invisible char is always at the END of text, never in the middle where the cursor navigates.

---

## Quirk #2: R Stripping Location

### The Problem

Invisible chars must be stripped from the InputZone `R` before processing. But the stripping code must be **outside** any IIFE because we need to reassign `R`, which is `let`-bound in the outer scope.

### Correct Implementation

```javascript
// OUTSIDE IIFE - can reassign R
globalThis._parentValue = A;
if (R.text.indexOf("\u200B") >= 0 || R.text.indexOf("\u200C") >= 0) {
  var _zwsClean = R.text.replace(/[\u200B\u200C]/g, "");
  var _beforeC = R.text.slice(0, R.offset);
  var _zwsCount = (_beforeC.match(/[\u200B\u200C]/g) || []).length;
  R = i5.fromText(_zwsClean, G, R.offset - _zwsCount);
}

// IIFE for variable isolation (clear-on-typing detection)
(function(){
  // This code can't reassign R
})();
```

### Cursor Position Adjustment

When stripping, we must adjust cursor position:
- Count invisible chars **before** the cursor
- Subtract that count from the offset
- This ensures cursor stays at the correct logical position

---

## Quirk #3: Clear-on-Typing Detection

### The Challenge

We insert invisible chars, but we don't want this to trigger "clear on typing". We need to distinguish:
- Navigation (our invisible char insert) → Don't clear
- Real user typing → Clear highlight

### The Solution

Compare text **without** invisible chars:

```javascript
var _hlText = A.replace(/[\u200B\u200C]/g, "");
var _oldText = (globalThis._hlText || "").replace(/[\u200B\u200C]/g, "");

if (_hlText !== _oldText) {
  // Real user typing - clear highlight
  globalThis._hlState = {active: false, index: null, text: ""};
}
```

---

## Quirk #4: Key Handler Scope

### The Problem

The key handler (injected into `VA()`) doesn't have direct access to:
- `valueParam` (A) - the parent value
- `inputZoneClass` (i5) - needed for fromText()
- `configVar` (G) - needed for fromText()

### The Solution

1. **Parent value**: Stored in `globalThis._parentValue` by clear-on-typing code (runs before key handler)

2. **InputZone class and config**: Found via regex pattern matching:
   ```javascript
   const fromTextPattern = /([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/;
   // Captures: R = i5.fromText(A, G, T)
   // inputZoneClass = capture[2] (i5)
   // configVar = capture[4] (G)
   ```

---

## Quirk #5: Raw Sequence Fallback

### The Problem

Some terminals don't set `meta`/`option` properties on key objects for Ctrl+Alt combinations. Instead, they send raw escape sequences.

### The Solution

Inject handlers for raw sequences in the nested switch inside the default case:
- `\x1B[1;7D` = Ctrl+Alt+Left (modifier 7)
- `\x1B[1;7C` = Ctrl+Alt+Right (modifier 7)
- `\x1B[1;7A` = Ctrl+Alt+Up (modifier 7)
- `\x1B[1;7B` = Ctrl+Alt+Down (modifier 7)

Both the property-based handler and raw sequence handler must be present for each key.

---

## Visual Rendering

### ANSI-Aware Processing

The rendering wraps `renderedValue` with an IIFE that:

1. Gets the rendered output (may include cursor inverse)
2. Strips ANSI codes to find word positions in clean text
3. Finds all numbers and calculates their character ranges
4. Walks through the original string preserving ANSI codes
5. Applies dark gray to numbers (when `numberDimming` is enabled)
6. Applies bold white to characters in the highlighted word range (overrides dimming)
7. Skips inverse regions (cursor position) to avoid conflicts

```javascript
// Simplified logic
var _clean = _rv.replace(/\x1b\[[0-9;]*m/g, '');
var _words = _clean.split(/\s+/).filter(w => w);
var _numPat = /^-?\d+(\.\d+)?$/;
var _numRanges = [];  // {start, end} for each number

// Find all numbers and their positions
for each word: if _numPat.test(word) → add to _numRanges

// Walk through, track inverse mode, apply colors
// Priority: highlight > number dimming > original
```

### Number Dimming

When `numberDimming` is enabled (default: true), all numbers in the input appear in dark gray. This makes numbers visually distinct from regular text.

**Behavior:**
- All tokens matching `/^-?\d+(\.\d+)?$/` are dimmed (integers, decimals, negatives)
- Highlighted numbers appear in bold white (highlight overrides dimming)
- Cursor position (inverse mode) is preserved - dimming doesn't apply to cursor character

**Implementation: Raw ANSI Codes with Reset Prefix**

The final implementation uses raw ANSI codes with a **reset prefix** to ensure clean styling:

```javascript
var _out='',_cp=0,_i=0,_inv=false,_pending='';
while(_i<_rv.length){
  var _am=_rv.slice(_i).match(/^\\x1b\\[[0-9;]*m/);
  if(_am){
    if(_am[0]==='\\x1b[7m')_inv=true;
    if(_am[0]==='\\x1b[27m'||_am[0]==='\\x1b[0m')_inv=false;
    _pending+=_am[0];  // Buffer ANSI codes
    _i+=_am[0].length;continue;
  }
  var _ch=_rv[_i];
  // ... determine _inHl and _inNum ...

  if(_inv){
    _out+=_pending+_ch;           // Cursor: pass through all
  }else if(_inHl){
    _out+='\\x1b[0m\\x1b[1;97m'+_ch+'\\x1b[0m';  // Reset + Highlight + Reset
  }else if(_inNum){
    _out+='\\x1b[0m\\x1b[90m'+_ch+'\\x1b[0m';  // Reset + Dim + Reset
  }else{
    _out+=_pending+_ch;           // Normal: pass through all
  }
  _pending='';
  _cp++;_i++;
}
```

**Double Cursor Bug Fix (Critical):**

Each color code starts with `\x1b[0m` (reset) BEFORE applying the color. This fixes a visual bug where moving the cursor through dimmed numbers would show a "ghost cursor" (darker double cursor to the right of the real cursor).

**Root cause:** When the cursor exits a character, the inverse-off code (`\x1b[27m`) gets captured in `_pending`. For the next number, we discard `_pending` and apply dim code - but without resetting first, the inverse mode was never turned off. The next character inherited both inverse AND dim styling, appearing as a darker duplicate cursor.

**Solution:** Prepend `\x1b[0m` to clear any previous styling:
- Dim: `\x1b[0m\x1b[90m` + char + `\x1b[0m`
- Highlight: `\x1b[0m\x1b[1;97m` + char + `\x1b[0m`

**ANSI Codes Used:**
- `\x1b[90m` - Dark gray foreground (ANSI color 90)
- `\x1b[1;97m` - Bold + bright white foreground
- `\x1b[0m` - Reset all attributes
- `\x1b[7m` / `\x1b[27m` - Inverse on/off (cursor detection)

**Why This Works (and Other Approaches Failed):**

| Approach | Problem |
|----------|---------|
| `chalk.dim()` on top of existing ANSI | ANSI stacking - colors compound unpredictably |
| Reset (`\x1b[0m`) before each character | Stripped cursor inverse codes, made cursor invisible |
| Reset only on transitions | Different base ANSI states caused inconsistent grays |
| **Discard base ANSI for colored chars** | ✓ Fresh colors every time, consistent results |

The key insight: **For characters we're coloring, don't pass through the base ANSI codes at all.** This ensures:
1. Dimmed numbers always get exactly `\x1b[90m` (dark gray)
2. Highlighted numbers always get exactly `\x1b[1;97m` (bold white)
3. No base styling interferes with our colors
4. Cursor characters still work because we pass through their ANSI codes unchanged

---

## Configuration Options

```typescript
interface WordHighlightConfig {
  enableWordHighlight?: boolean;           // Master toggle (default: true)
  highlightColor?: "white" | "cyan" | "yellow" | "inverse" | "underline";
  highlightIndexFromLeft?: boolean;        // default: false (right-to-left)
  highlightWrap?: boolean;                 // default: false (stop at boundary)
  highlightClearOnEscape?: boolean;        // default: true
  highlightMode?: "words" | "numbers";     // default: "numbers"
                                           // 'numbers' = only numeric tokens (/^-?\d+(\.\d+)?$/)
                                           // 'words' = all whitespace-separated words
  highlightExportEnabled?: boolean;        // default: true
  highlightExportPath?: string;            // PID-based at runtime: /tmp/claude-highlight-state-{PID}.json
  numberDimming?: boolean;                 // default: true - dim all numbers in input (dark gray)
}
```

---

## State Export

When enabled, writes **synchronously** to `/tmp/claude-highlight-state-{PID}.json` (PID-based for multi-instance support):

```json
{
  "active": true,
  "highlightedWordIndex": 0,
  "highlightedWord": "42",
  "wordCount": 3,
  "originalNumber": 42,
  "timestamp": 1705500000000
}
```

**Fields**:
- `active`: Whether highlight is active
- `highlightedWordIndex`: Position in all-words array
- `highlightedWord`: The current word/number text
- `wordCount`: Total words in input
- `originalNumber`: The number value when first highlighted (for increment/decrement floor)
- `timestamp`: Unix timestamp in milliseconds

**Important notes**:
- Uses `writeFileSync` (not async) so the file is ready before the status line command runs
- Path includes `process.pid` to avoid interference between multiple Claude Code instances
- Status line script must walk process tree to find correct PID (see "Multi-Instance Support" in status-line-integration.md)

---

## Status Line Integration

The word highlight feature integrates with Claude Code's status line to display highlighted word info in the footer.

### The Challenge

Claude Code's status line only refreshes on specific events:
- New assistant messages
- Permission mode changes
- VIM mode changes
- Initial mount

It does **NOT** refresh on:
- Input text changes
- Cursor position changes
- Custom state changes (like word highlight)

### The Solution: Expose & Call the vh6 Trigger

**Step 1: Expose the debounced trigger**

Claude Code's INK component creates a debounced function `O` that calls the status line hook:
```javascript
O = Wn(() => X(A), 300)  // 300ms debounce
```

We patch this to store `O` in globalThis:
```javascript
O = Wn(() => X(A), 300); globalThis._triggerStatusLineRefresh = O;
```

**Step 2: Call the trigger from key handlers**

After updating highlight state, call the trigger:
```javascript
if (globalThis._triggerStatusLineRefresh) globalThis._triggerStatusLineRefresh();
```

### Implementation

**Patch function**: `writeStatusLineTriggerExport()` in `wordHighlight.ts`

```typescript
export const writeStatusLineTriggerExport = (oldFile: string): string | null => {
  // Pattern is UNIQUE in cli.js (only one =Wn( assignment)
  const pattern = /(\w+)=Wn\(\(\)=>(\w+)\(([A-Z])\),300\)/;
  const match = oldFile.match(pattern);
  if (!match) return null;

  const debounceVar = match[1]; // O
  return oldFile.replace(pattern, `${match[0]};globalThis._triggerStatusLineRefresh=${debounceVar}`);
};
```

**Key handler integration**: Each key handler calls the trigger after state update.

### Status Line Script

Create `~/.claude/highlight-statusline.sh`:

```bash
#!/bin/bash
# Status line script - PS1 style + word highlight info

# Find Claude Code's PID by walking up the process tree
# CRITICAL: Claude Code's cmdline is "claude", NOT "node cli.js"
CLAUDE_PID=""
WALK_PID=$$
while [ "$WALK_PID" != "1" ] && [ -n "$WALK_PID" ]; do
  CMDLINE=$(cat /proc/$WALK_PID/cmdline 2>/dev/null | tr '\0' ' ')
  if echo "$CMDLINE" | grep -q "^claude"; then
    CLAUDE_PID=$WALK_PID
    break
  fi
  WALK_PID=$(awk '{print $4}' /proc/$WALK_PID/stat 2>/dev/null)
done
HIGHLIGHT_FILE="/tmp/claude-highlight-state-${CLAUDE_PID:-unknown}.json"

# Color codes using tput (for prefix only)
BOLD=$(tput bold)
GREEN=$(tput setaf 2)
BLUE=$(tput setaf 4)
RESET=$(tput sgr0)

# Build PS1-style prefix
prefix="${BOLD}${GREEN}$(whoami)@$(hostname -s)${RESET}:${BOLD}${BLUE}$(pwd)${RESET}"
printf '%s' "${prefix}"

# Highlight info (when active) - plain text, no color styling
if [ -f "$HIGHLIGHT_FILE" ]; then
  content=$(cat "$HIGHLIGHT_FILE" 2>/dev/null)
  if echo "$content" | grep -q '"active":true'; then
    word=$(echo "$content" | sed -n 's/.*"highlightedWord":"\([^"]*\)".*/\1/p')
    idx=$(echo "$content" | sed -n 's/.*"highlightedWordIndex":\([0-9]*\).*/\1/p')
    total=$(echo "$content" | sed -n 's/.*"wordCount":\([0-9]*\).*/\1/p')
    if [ -n "$word" ]; then
      printf ' | "%s" (%d) %d/%d' "$word" "${#word}" "$((idx+1))" "$total"
    fi
  fi
fi
printf '%s' "${RESET}"
```

**Note**: The highlighted word is displayed in plain text without color styling. We attempted multiple approaches to color the word (raw ANSI, tput, separate printf calls, invisible character anchors) but all suffered from color bleeding issues that proved unsolvable.

### Configuration

In `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/user/.claude/highlight-statusline.sh"
  }
}
```

### Data Flow

```
1. User presses Ctrl+Alt+Arrow
2. Key handler updates globalThis._hlState
3. Key handler writes /tmp/claude-highlight-state-{PID}.json (sync)
4. Key handler calls globalThis._triggerStatusLineRefresh()
5. Debounced vh6 runs after 300ms
6. Status line command walks process tree to find Claude's PID, reads JSON file
7. Status line displays: "word" (5) 2/3
```

### Verification

```bash
# Check trigger is exported
grep -c '_triggerStatusLineRefresh' "$CLI_JS"
# Expected: 10 (1 export + 8 key handler calls + 1 clear-on-typing)

# Check debounce patterns exist
grep -c '=Wn(' "$CLI_JS"
# Expected: ~4 (multiple debounced functions, but 300ms one is for status line)

# Check PID-based export path
grep 'claude-highlight-state' "$CLI_JS"
# Expected: var _hlExportPath="/tmp/claude-highlight-state-"+process.pid+".json";
```

**See also**: `docs/status-line-integration.md` for the complete integration guide.

---

## Verification Commands

```bash
CLI_JS="/home/wilfred/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js"

# Check highlight state references
grep -c '_hlState' "$CLI_JS"
# Expected: 60+ occurrences

# Check originalNumbers map (for per-number floor tracking)
grep -c 'originalNumbers' "$CLI_JS"
# Expected: 21+ occurrences

# Check parent value storage
grep -c '_parentValue' "$CLI_JS"
# Expected: 5 occurrences

# Check append-at-end pattern (not insert at cursor)
grep -o 'fromText(R.text+"' "$CLI_JS" | wc -l
# Expected: 6+ occurrences

# Check NO insert at cursor for invisible chars
grep -c 'R.insert("\\u200' "$CLI_JS"
# Expected: 0

# Check key handler detection
grep -o 'leftArrow.*ctrl.*meta.*option.*alt' "$CLI_JS" | head -1

# Check status line trigger export
grep -c '_triggerStatusLineRefresh' "$CLI_JS"
# Expected: 10+ (1 export + 8 key handler calls + 1 clear-on-typing)

# Check debounce patterns (multiple exist, but 300ms one is for status line)
grep -c '=Wn(' "$CLI_JS"
# Expected: ~4 (multiple debounced functions)

# Check PID-based JSON export path
grep -o 'claude-highlight-state-.*process.pid' "$CLI_JS"
# Expected: claude-highlight-state-"+process.pid
```

---

## Reimplementation Checklist

If reimplementing from scratch:

### Core Word Highlight
1. [ ] Find key dispatcher function (`VA()` with switch statement)
2. [ ] Find input handler function (has `onChange`, `onOffsetChange`, `fromText`)
3. [ ] Find `renderedValue` location
4. [ ] Implement invisible char toggle (TWO chars, check PARENT, insert OPPOSITE)
5. [ ] Append at END (not at cursor) to avoid cursor wall bug
6. [ ] Strip invisible chars from R OUTSIDE IIFE
7. [ ] Store parent value in globalThis for key handler access
8. [ ] Adjust cursor position when stripping (count chars before cursor)
9. [ ] Compare stripped text for clear-on-typing detection
10. [ ] Handle both key properties AND raw escape sequences
11. [ ] ANSI-aware rendering that preserves cursor inverse

### Number Increment/Decrement
12. [ ] Add Ctrl+Alt+Up handler to increment highlighted number
13. [ ] Add Ctrl+Alt+Down handler to decrement (with floor at original)
14. [ ] Use `originalNumbers` map to track floor per wordIndex independently
15. [ ] Capture original on first Up/Down press, NOT on highlight
16. [ ] Find word position in text, replace with new value
17. [ ] Update `globalThis._hlText` after modification to prevent clear-on-typing

### Number Dimming
18. [ ] Use raw ANSI codes, not chalk (for consistent coloring)
19. [ ] Buffer pending ANSI codes until reaching a character
20. [ ] For colored chars (dim/highlight): discard pending ANSI, apply fresh color
21. [ ] For cursor chars (`_inv=true`): pass through pending ANSI + character unchanged
22. [ ] For normal chars: pass through pending ANSI + character
23. [ ] Dim code: `\x1b[0m\x1b[90m` + char + `\x1b[0m` (reset + dark gray + reset)
24. [ ] Highlight code: `\x1b[0m\x1b[1;97m` + char + `\x1b[0m` (reset + bold bright white + reset)
25. [ ] CRITICAL: Reset prefix (`\x1b[0m`) prevents "double cursor" bug from inverse mode leaking

### Status Line Integration
25. [ ] Find debounced vh6 trigger pattern (`=Wn(()=>X(A),300)`)
26. [ ] Expose trigger to globalThis (`globalThis._triggerStatusLineRefresh=O`)
27. [ ] Call trigger from each key handler after state update
28. [ ] Write state file synchronously (writeFileSync, not async)
29. [ ] Create status line script that reads JSON and formats output
30. [ ] Configure settings.json with statusLine.command

---

## Patch Application Order

### Global Order (in index.ts)

Patches are applied in order:

```
... other patches ...
├── cursorStateExport
├── wordHighlight      (highlight navigation)
└── dynamicHighlight   (LLM analysis)
```

### Internal Order (in writeWordHighlight)

The `writeWordHighlight()` function applies its sub-patches in order:

```
1. Key handler         - Ctrl+Alt+Arrow detection via key properties
2. Raw sequence        - Fallback for escape sequences (non-fatal if fails)
3. Clear-on-escape     - Clear highlight on Escape key
4. Clear-on-typing     - Strip invisible chars, detect real typing
5. Visual rendering    - Apply highlight color to word
6. Status line trigger - Expose debounced vh6 for custom refresh calls
```

**Critical**: Clear-on-typing must come **before** rendering because it stores `_parentValue` and strips R, which the key handler and rendering depend on.

---

## Version Compatibility

### Render Function Signatures

The patch handles multiple Claude Code versions:

| Version | Signature | Pattern |
|---------|-----------|---------|
| v2.0.x | `R.render(K, X, V)` | 3 parameters |
| v2.1.x | `R.render(_, O, Z, s)` | 4 parameters |

---

## Unimplemented Config Options

These options are defined in `WordHighlightConfig` but **not yet implemented**:

| Option | Intended Purpose | Current Behavior |
|--------|------------------|------------------|
| `highlightAutoScroll` | Scroll to keep highlighted word visible | Ignored |
| `highlightClearOnNavigation` | Clear on regular arrow keys | Ignored |
| `highlightWordPattern` | Custom word splitting pattern | Hardcoded to `/\s+/` |

---

## Enabled Features

### State Export (Re-enabled)

The JSON export functionality writes **synchronously** on every keystroke:

```typescript
// In writeWordHighlightClearOnTyping:
const exportCode = cfg.highlightExportEnabled ? `
var _hlWords=_hlText.split(/\\s+/).filter(function(w){return w});
var _hlExport={active:..., highlightedWordIndex:..., highlightedWord:..., wordCount:..., timestamp:...};
try{require("fs").writeFileSync("${exportPath}",JSON.stringify(_hlExport));}catch(_e){}
` : '';
```

**Key design decisions**:
- Uses `writeFileSync` (sync) instead of `fs.promises.writeFile` (async)
- Sync write ensures file is ready before status line command runs
- Wrapped in try/catch to avoid breaking input on write errors

---

## Code Quality Notes

### Dead Code

The `indexExpr` variable is defined but unused:
```typescript
const indexExpr = cfg.highlightIndexFromLeft
  ? '_hlW[globalThis._hlState.index]'
  : '_hlW[_hlW.length-1-globalThis._hlState.index]';
```
This was likely intended for a "get highlighted word" feature.

### Header Documentation Sync

The header comment in `wordHighlight.ts` may reference outdated approaches (e.g., `R.insert()` instead of `fromText()`). The canonical documentation is in `docs/word-highlight-system.md`.

---

## Differences from Original tweakcc

This word highlight feature is **not part of the original tweakcc**. It was added as a custom extension. Key differences from tweakcc's standard patches:

| Aspect | tweakcc Standard | Word Highlight |
|--------|------------------|----------------|
| Pattern complexity | Simple string replacement | Multi-location injection |
| State management | Minimal globalThis usage | Heavy globalThis usage |
| React integration | Passive (render-time) | Active (forces re-renders) |
| Dependencies | Self-contained | Depends on execution order |

### Pattern Matching Differences

tweakcc's original patches typically:
1. Find a single pattern
2. Replace with modified code
3. No cross-patch dependencies

Word highlight requires:
1. Five separate injection points
2. Shared state via globalThis
3. Specific application order
4. Parent value passing between patches

---

## Known Limitations

1. **Minified names change per version**: Patterns use `[$\w]+` capture groups
2. **Multi-line text**: Words span all lines, indexed right-to-left across entire input
3. **No word boundary detection**: Uses whitespace split (`/\s+/`), not word boundaries
4. **Escape sequence fallback**: Modifier 7 assumed for Ctrl+Alt (may vary by terminal)
5. **No undo integration**: Highlight state doesn't integrate with Claude Code's undo system
6. **Search window size**: The input handler pattern search uses a 30000-char window (increased from 10000→20000→30000) because the key handler patch injects code into VA(), which is defined inside NV1(), pushing the return statement further away. If patterns fail to match after patches, this limit may need increasing.

---

## Debugging Tips

### Check Patch Application

```bash
# All patches applied?
grep -c '_hlState' "$CLI_JS"        # Expected: 60+
grep -c '_parentValue' "$CLI_JS"    # Expected: 5
grep -c '_zwsClean' "$CLI_JS"       # Expected: 2

# Using correct append pattern?
grep -o 'fromText(R.text+"' "$CLI_JS" | wc -l  # Expected: 6+
grep -c 'R.insert("\\u200' "$CLI_JS"           # Expected: 0
```

### Check Runtime State

In browser console or Node REPL with Claude Code:
```javascript
globalThis._hlState                    // {active: bool, index: num, wordIndex: num, text: str, originalNumbers: {}}
globalThis._hlText                     // Current text (stripped)
globalThis._parentValue                // Parent value (with invisible char)
globalThis._triggerStatusLineRefresh   // Function (the debounced vh6 trigger)
globalThis._hlState.originalNumbers    // Map of wordIndex → original number floor
```

### Manually Trigger Status Line Refresh

```javascript
// Force a status line refresh
if (globalThis._triggerStatusLineRefresh) globalThis._triggerStatusLineRefresh();
```

### Force Clear State

If highlight gets stuck:
```javascript
globalThis._hlState = {active: false, index: null, wordIndex: null, text: "", originalNumbers: {}};
globalThis._hlText = "";
globalThis._parentValue = "";
```

---

*Last updated: February 2026* (added highlightMode toggle, number increment/decrement with Ctrl+Alt+Up/Down, originalNumbers map for per-number floor tracking, numberDimming with raw ANSI codes)
