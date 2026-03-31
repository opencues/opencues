---
last_updated: 2026-02-18
---

# Implementation Notes: Cursor State Export

This document explains the implementation of the cursor state export feature.

---

# Feature 1: Cursor State Export

## Goal
Export cursor position data from Claude Code's input box to a JSON file in real-time, enabling external tools to know where the cursor is.

## Discovery Process

### Step 1: Find the Input Handler
**Search command used:**
```bash
grep -oP 'function \w+\(\{value:\w+,onChange:\w+.{0,200}externalOffset' cli.js
```

**Found in v2.0.67:**
```javascript
function f31({value:A,onChange:Q,...externalOffset:F,onOffsetChange:C...})
```

The function `f31` (varies by version) handles all input state.

### Step 2: Understand the Structure
**Key parameters identified:**
- `value` (A) - The text content
- `externalOffset` (F) - Cursor position from outside
- `onOffsetChange` (C) - Callback when offset changes

**Internal variables:**
- `O` = externalOffset (copied to local var)
- `L` = InputZone.fromText(value, columns, offset)

### Step 3: Find Injection Point
**Search for return statement:**
```bash
grep -oP 'return\{onInput:\w+,renderedValue:' cli.js
```

The return statement is where we inject code (just before it).

---

## Implementation

### File: `/home/wilfred/tweakcc-source/src/patches/cursorStateExport.ts`

**Pattern to find function:**
```typescript
const funcPattern =
  /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{let ([$\w]+)=([$\w]+),([$\w]+)=([$\w]+),([$\w]+)=([$\w]+)\.fromText\(/;
```

**Captured groups:**
| Index | Captures | Example (v2.0.67) |
|-------|----------|-------------------|
| 1 | Function name | `f31` |
| 2 | value param | `A` |
| 3 | onChange param | `Q` |
| 4 | externalOffset param | `F` |
| 5 | onOffsetChange param | `C` |
| 6 | O variable | `O` |
| 7 | O source | `F` |
| 8 | M variable | `M` |
| 9 | M source | `C` |
| 10 | L variable (InputZone) | `L` |
| 11 | InputZone class | `G7` |

**Pattern to find return:**
```typescript
const returnPattern = /return\{onInput:([$\w]+),renderedValue:/;
```

**Injected code (debounced async):**
```javascript
(function(){
  try{
    var _text=A;              // value param (group 2)
    var _offset=O??0;         // offset var (group 6)
    var _words=_text.split(/\s+/);
    var _pos=0;
    var _currentWord="";
    for(var _i=0;_i<_words.length;_i++){
      var _wEnd=_pos+_words[_i].length;
      if(_offset>=_pos&&_offset<=_wEnd){_currentWord=_words[_i];break}
      _pos=_wEnd+1;
    }
    var _data={
      text:_text,
      cursorPosition:_offset,
      currentWord:_currentWord,
      atEnd:_offset>=_text.length,
      textLength:_text.length,
      timestamp:Date.now()
    };
    // Debounced async write - doesn't block UI
    if(globalThis._cwt)clearTimeout(globalThis._cwt);
    globalThis._cwt=setTimeout(function(){
      require("fs").promises.writeFile("/tmp/claude-cursor-state.json",JSON.stringify(_data)).catch(function(){});
    },100);
  }catch(_e){}
})();
```

### Integration in index.ts

```typescript
// Line ~67: Import
import { writeCursorStateExport } from './cursorStateExport';

// Line ~460: Apply patch
if (config.settings.misc?.enableCursorStateExport) {
  const exportPath = config.settings.misc?.cursorStateExportPath || '/tmp/claude-cursor-state.json';
  if ((result = writeCursorStateExport(content, exportPath))) content = result;
}
```

### Configuration in types.ts

```typescript
interface MiscConfig {
  // ... existing fields ...
  enableCursorStateExport?: boolean;
  cursorStateExportPath?: string;
}
```

### Defaults in defaultSettings.ts

```typescript
misc: {
  // ... existing fields ...
  enableCursorStateExport: true,
  cursorStateExportPath: '/tmp/claude-cursor-state.json',
}
```

---

## Output Format

```json
{
  "text": "hello world",
  "cursorPosition": 6,
  "currentWord": "world",
  "atEnd": false,
  "textLength": 11,
  "timestamp": 1705500000000
}
```

---

# Summary: Files Modified

| File | Changes |
|------|---------|
| `src/patches/cursorStateExport.ts` | NEW - Cursor state export patch |
| `src/patches/wordHighlight.ts` | NEW - Word highlight navigation patch |
| `src/patches/dynamicHighlight.ts` | NEW - LLM-based word analysis patch |
| `src/patches/index.ts` | Added imports and patch application |
| `src/types.ts` | Added MiscConfig fields |
| `src/defaultSettings.ts` | Added default values |

---

# Build and Apply Commands

```bash
cd /home/wilfred/tweakcc-source

# Build
npm run build

# Apply (with explicit path for multiple installations)
TWEAKCC_CC_INSTALLATION_PATH="/home/wilfred/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js" \
  node dist/index.mjs --apply
```

---

# Key Learnings

1. **Minified names change** - Use capture groups `([$\w]+)` to match any identifier
2. **Structure is stable** - The code structure (let assignments, return shapes) stays consistent
3. **Multiple checks may exist** - Some features need multiple related patches to work correctly
4. **Index shifting** - When replacing text, re-find subsequent patterns in modified file
5. **IIFE for injection** - Wrap injected code in `(function(){...})()` to avoid variable conflicts
6. **Silent failures** - Wrap in try/catch to prevent breaking Claude Code if something goes wrong

---

# Part 3: The Patching Process In-Depth

This section provides a detailed walkthrough of how to create patches for Claude Code.

## Overview: How tweakcc Patches Work

tweakcc modifies Claude Code's minified `cli.js` file using regex-based pattern matching:

```
┌─────────────────────┐
│  Original cli.js    │
│  (minified JS)      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Pattern Matching   │
│  (regex finds code) │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  String Surgery     │
│  (slice & replace)  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Patched cli.js     │
│  (modified JS)      │
└─────────────────────┘
```

## Step-by-Step: Creating a New Patch

### Phase 1: Discovery (Exploring cli.js)

**1.1 Find the relevant code**

Start by searching for keywords related to your feature:
```bash
# Set up
export CLI_JS="/path/to/cli.js"

# Search for keywords
grep -n "keyword" "$CLI_JS" | head -20
```

**1.2 Extract surrounding context**

Once you find a match, extract context:
```bash
# Get line number from grep, then extract context
sed -n '1950,1960p' "$CLI_JS"
```

**1.3 Identify the pattern structure**

Look for:
- Function definitions: `function XXX(...){`
- Variable assignments: `XXX=...`
- Object literals: `{key:value,...}`
- Return statements: `return{...}`

### Phase 2: Pattern Design

**2.1 Convert literal code to regex**

Example - converting `function f31({value:A,onChange:Q})` to a pattern:

| Literal | Regex | Why |
|---------|-------|-----|
| `function f31` | `function ([$\w]+)` | Function name varies |
| `value:A` | `value:([$\w]+)` | Param name varies |
| `{` | `\{` | Escape special chars |

**2.2 Use capture groups for dynamic parts**

```typescript
// Bad: Hardcodes variable names
const pattern = /function f31\(\{value:A/;

// Good: Captures any valid identifier
const pattern = /function ([$\w]+)\(\{value:([$\w]+)/;
//                        ^^^^^^^^          ^^^^^^^^
//                        group 1           group 2
```

**2.3 Add word boundaries**

```typescript
// Bad: Could match "Xf31" or "f31Y"
const pattern = /function ([$\w]+)/;

// Good: Only matches whole identifiers
const pattern = /\bfunction ([$\w]+)/;
```

**2.4 Handle whitespace flexibility**

Minified code usually has no whitespace, but be safe:
```typescript
// Strict (minified only)
const pattern = /function\s*([$\w]+)/;

// Flexible (handles both)
const pattern = /function\s*([$\w]+)/;
```

### Phase 3: Implementation

**3.1 File structure**

Create a new file in `src/patches/`:
```typescript
// src/patches/myFeature.ts

import { showDiff, getRequireFuncName } from './index';

/**
 * Brief description of what this patch does.
 */
export const writeMyFeature = (
  oldFile: string,
  configParam: string = 'default'
): string | null => {
  // Implementation here
};
```

**3.2 Pattern matching**

```typescript
// Define the pattern
const pattern = /your pattern here/;

// Match against file contents
const match = oldFile.match(pattern);

// Handle failure
if (!match || match.index === undefined) {
  console.error('patch: myFeature: failed to find pattern');
  return null;
}

// Extract captured groups
const varName = match[1];  // First capture group
const funcName = match[2]; // Second capture group
```

**3.3 Building replacement strings**

```typescript
// Use captured variable names in replacement
const newCode = `function ${funcName}(${paramName}){
  // New implementation using captured names
  return ${varName} + "modified";
}`;
```

**3.4 Applying the replacement**

```typescript
// Simple replacement
const newFile =
  oldFile.slice(0, match.index) +     // Everything before
  newCode +                             // New code
  oldFile.slice(match.index + match[0].length);  // Everything after

// Show diff for debugging
showDiff(oldFile, newFile, newCode, match.index, match.index + match[0].length);

return newFile;
```

### Phase 4: Integration

**4.1 Add to index.ts**

```typescript
// Import at top
import { writeMyFeature } from './myFeature';

// In applyCustomization(), add:
if (config.settings.misc?.enableMyFeature) {
  if ((result = writeMyFeature(content, config.settings.misc.myFeatureParam)))
    content = result;
}
```

**4.2 Add types**

```typescript
// src/types.ts
interface MiscConfig {
  // ...existing...
  enableMyFeature?: boolean;
  myFeatureParam?: string;
}
```

**4.3 Add defaults**

```typescript
// src/defaultSettings.ts
misc: {
  // ...existing...
  enableMyFeature: false,
  myFeatureParam: 'default',
}
```

---

# Detailed Walkthrough: cursorStateExport.ts

## What It Does
Injects code into the input handler to write cursor state to a JSON file on every keystroke.

## The Target Function

Original (simplified):
```javascript
function f31({value:A, onChange:Q, externalOffset:F, onOffsetChange:C}) {
  let O = F;           // Cursor offset
  let M = C;           // Offset change callback
  let L = G7.fromText(A, columns, O);  // InputZone instance

  // ... processing ...

  return {
    onInput: handler,
    renderedValue: rendered,
    // ...
  };
}
```

## Pattern Breakdown

```typescript
const funcPattern =
  /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{let ([$\w]+)=([$\w]+),([$\w]+)=([$\w]+),([$\w]+)=([$\w]+)\.fromText\(/;
```

Breaking this down:

| Regex Part | Matches | Captures |
|------------|---------|----------|
| `function ([$\w]+)` | `function f31` | Group 1: `f31` |
| `\(\{value:([$\w]+)` | `({value:A` | Group 2: `A` |
| `,onChange:([$\w]+)` | `,onChange:Q` | Group 3: `Q` |
| `,[^}]+externalOffset:([$\w]+)` | `,...externalOffset:F` | Group 4: `F` |
| `,onOffsetChange:([$\w]+)` | `,onOffsetChange:C` | Group 5: `C` |
| `[^}]+\}\)\{let ([$\w]+)` | `...}){let O` | Group 6: `O` |
| `=([$\w]+)` | `=F` | Group 7: `F` |
| `,([$\w]+)` | `,M` | Group 8: `M` |
| `=([$\w]+)` | `=C` | Group 9: `C` |
| `,([$\w]+)` | `,L` | Group 10: `L` |
| `=([$\w]+)\.fromText\(` | `=G7.fromText(` | Group 11: `G7` |

## Injection Strategy

We inject code **before the return statement**, not inside the function body, because:
1. All variables are computed by then
2. It runs on every render (keystroke)
3. It's a clean injection point

```typescript
// Find the return statement
const returnPattern = /return\{onInput:([$\w]+),renderedValue:/;
const returnMatch = searchSection.match(returnPattern);

// Inject just before it
const newFile =
  oldFile.slice(0, location.startIndex) +  // Up to return
  exportCode +                              // Our code
  oldFile.slice(location.endIndex);         // return onwards
```

## The Injected Code

```javascript
(function(){
  try{
    var _text=A;                   // Use captured value param
    var _offset=O??0;              // Use captured offset var

    // Find current word by walking through words
    var _words=_text.split(/\s+/);
    var _pos=0;
    var _currentWord="";
    for(var _i=0;_i<_words.length;_i++){
      var _wEnd=_pos+_words[_i].length;
      if(_offset>=_pos&&_offset<=_wEnd){
        _currentWord=_words[_i];
        break;
      }
      _pos=_wEnd+1;
    }

    // Prepare data
    var _data={
      text:_text,
      cursorPosition:_offset,
      currentWord:_currentWord,
      atEnd:_offset>=_text.length,
      textLength:_text.length,
      timestamp:Date.now()
    };

    // Debounced async write - doesn't block UI
    if(globalThis._cwt)clearTimeout(globalThis._cwt);
    globalThis._cwt=setTimeout(function(){
      require("fs").promises.writeFile("/tmp/claude-cursor-state.json",JSON.stringify(_data)).catch(function(){});
    },100);
  }catch(_e){}  // Silent failure
})();
```

**Design decisions:**
- IIFE `(function(){...})()` - Creates isolated scope, no variable conflicts
- Underscore prefixes `_text`, `_data` - Avoid shadowing existing variables
- `try/catch` with empty handler - Never crash Claude Code
- **Debounced async write** - 100ms debounce prevents blocking on rapid keystrokes
- `globalThis._cwt` - Timer stored globally to persist between calls
- `fs.promises.writeFile` - Non-blocking, doesn't freeze UI

---

# Testing Patches

## Verification Commands

```bash
# Check if cursor export was added
grep 'claude-cursor-state.json' "$CLI_JS"
# Expected: should find the path

# Check if word highlight was added
grep -c '_hlState' "$CLI_JS"
# Expected: 60+ occurrences

# Check if dynamic highlight was added
grep -c '_dynDefs' "$CLI_JS"
# Expected: 5+ occurrences
```

## Build and Test Cycle

```bash
# 1. Make changes to patch file
vim src/patches/myPatch.ts

# 2. Build
npm run build

# 3. Apply
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply

# 4. Restart Claude Code and test
# (or use `claude --version` to verify it still runs)

# 5. If broken, restore backup
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --restore
```
