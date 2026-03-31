---
last_updated: 2026-03-27
---

# Status Line Integration Guide

This document explains how to integrate custom features with Claude Code's status line.

## Overview

Claude Code's status line is a command-based footer that runs a user-configured shell command. However, it only refreshes on specific events by default.

**Default refresh triggers:**
- New assistant messages
- Permission mode changes
- VIM mode changes
- Initial mount

**NOT triggered by:**
- Input text changes
- Cursor position changes
- Custom state changes (like word highlight)

This document explains how to make the status line refresh on custom events.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ INK Component (status line lives here)                          │
│ ├── X = useCallback(async () => { await vh6(...) })            │
│ ├── O = Wn(() => X(A), 300)  ← debounced trigger               │
│ ├── useEffect → calls O() when messages/mode/vim change        │
│ └── statusLineText state → rendered in UI                       │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                              │ globalThis._triggerStatusLineRefresh = O
                              │
┌─────────────────────────────────────────────────────────────────┐
│ Input Component (custom features live here)                     │
│ ├── Key handler (VA) → detects custom keys                     │
│ ├── Custom state in globalThis                                  │
│ └── Calls globalThis._triggerStatusLineRefresh()               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Status Line Command (external shell script)                     │
│ ├── Receives JSON input via stdin (session metadata)            │
│ ├── Reads custom state from files (e.g., /tmp/*.json)          │
│ └── Outputs formatted text with ANSI colors                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 1: Expose the Status Line Trigger

### The Pattern

Claude Code creates a debounced function that calls the status line hook (vh6):

```javascript
O = Wn(() => X(A), 300)
```

Where:
- `O` = debounced function (variable name changes per version)
- `Wn` = debounce wrapper (300ms)
- `X` = async callback that calls vh6
- `A` = messages array

### How to Find the Pattern

```bash
CLI_JS="/path/to/cli.js"

# Find the exact pattern (should return 1 match)
grep -o '=Wn(()=>[A-Za-z]*([A-Z]),300)' "$CLI_JS"

# Count Wn patterns (there may be multiple, but the 300ms one is for status line)
grep -c '=Wn(' "$CLI_JS"
# Expected: ~4 (multiple debounced functions exist)

# Get surrounding context (to understand the structure)
grep -o '.{20}=Wn(()=>[A-Za-z]*([A-Z]),300).{20}' "$CLI_JS"
```

### The Patch

Find this unique pattern and store `O` in globalThis:

```typescript
export const writeStatusLineTriggerExport = (oldFile: string): string | null => {
  // Pattern is UNIQUE in cli.js (only one =Wn( assignment)
  const pattern = /(\w+)=Wn\(\(\)=>(\w+)\(([A-Z])\),300\)/;
  const match = oldFile.match(pattern);

  if (!match || match.index === undefined) {
    console.error('patch: statusLineTrigger: failed to find debounced vh6 pattern');
    return null;
  }

  const debounceVar = match[1]; // O
  const originalCode = match[0];
  const replacement = `${originalCode};globalThis._triggerStatusLineRefresh=${debounceVar}`;

  return oldFile.replace(pattern, replacement);
};
```

### Result in cli.js

Before:
```javascript
O=Wn(()=>X(A),300);xd.useEffect(...)
```

After:
```javascript
O=Wn(()=>X(A),300);globalThis._triggerStatusLineRefresh=O;xd.useEffect(...)
```

---

## Step 2: Call the Trigger from Custom Code

In your custom key handler or event code:

```javascript
// After updating your custom state
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
```

**Important notes:**
- Always check if the function exists before calling
- The 300ms debounce is built-in, so rapid calls are batched
- The trigger calls the status line command asynchronously

### Example: Word Highlight Key Handler

```javascript
case(key.leftArrow && key.ctrl && key.alt): return () => {
  // Update highlight state
  globalThis._hlState = {active: true, index: newIndex, text: currentText};

  // Write state to file for status line to read
  require("fs").writeFileSync("/tmp/state.json", JSON.stringify(state));

  // Trigger status line refresh
  if(globalThis._triggerStatusLineRefresh) globalThis._triggerStatusLineRefresh();

  // Return modified input (invisible char toggle for React re-render)
  return InputZone.fromText(text + "\u200B", config, offset);
};
```

---

## Step 3: Create the Status Line Script

### Basic Structure

```bash
#!/bin/bash
# ~/.claude/my-statusline.sh

STATE_FILE="/tmp/my-state.json"

# Default output (always shown)
printf '\033[01;32m%s@%s\033[00m:\033[01;34m%s\033[00m' \
  "$(whoami)" "$(hostname -s)" "$(pwd)"

# Custom state output (conditional)
if [ -f "$STATE_FILE" ]; then
  content=$(cat "$STATE_FILE" 2>/dev/null)

  if echo "$content" | grep -q '"active":true'; then
    # Extract data without jq (jq may not be in PATH)
    value=$(echo "$content" | sed -n 's/.*"myValue":"\([^"]*\)".*/\1/p')

    if [ -n "$value" ]; then
      printf ' | \033[01;33m%s\033[00m' "$value"
    fi
  fi
fi
```

### Key Points

1. **Use full paths** - Claude Code may not have your shell's PATH
2. **Avoid jq** - Use grep/sed for JSON parsing (more portable)
3. **Use printf** - More reliable than echo for ANSI codes
4. **Write sync, read async** - Write state files synchronously so they're ready when status line runs

### ANSI Color Codes

| Code | Color |
|------|-------|
| `\033[01;30m` | Bold black (gray) |
| `\033[01;31m` | Bold red |
| `\033[01;32m` | Bold green |
| `\033[01;33m` | Bold yellow |
| `\033[01;34m` | Bold blue |
| `\033[01;35m` | Bold magenta |
| `\033[01;36m` | Bold cyan |
| `\033[01;37m` | Bold white |
| `\033[00m` | Reset |

---

## Step 4: Configure Settings

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/full/path/to/my-statusline.sh"
  }
}
```

**Important:** Use full absolute path, not `~` or relative paths.

---

## Complete Example: Word Highlight Integration

### 1. Patch (wordHighlight.ts)

```typescript
// Export status line trigger
export const writeStatusLineTriggerExport = (oldFile: string): string | null => {
  const pattern = /(\w+)=Wn\(\(\)=>(\w+)\(([A-Z])\),300\)/;
  const match = oldFile.match(pattern);
  if (!match) return null;

  const debounceVar = match[1];
  return oldFile.replace(pattern, `${match[0]};globalThis._triggerStatusLineRefresh=${debounceVar}`);
};

// In key handler, after state update:
// if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
```

### 2. State Export (in input handler)

```javascript
// Write state synchronously so it's ready for status line
// Path includes process.pid to avoid interference between multiple instances
var _hlExportPath = "/tmp/claude-highlight-state-" + process.pid + ".json";
var state = {
  active: globalThis._hlState?.active || false,
  highlightedWordIndex: idx,
  highlightedWord: words[idx] || null,
  wordCount: words.length,
  timestamp: Date.now()
};
try { require("fs").writeFileSync(_hlExportPath, JSON.stringify(state)); } catch(e) {}
```

### 3. Status Line Script (~/.claude/highlight-statusline.sh)

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

# Color codes using tput (for prefix only - word highlight is plain text)
BOLD=$(tput bold)
GREEN=$(tput setaf 2)
BLUE=$(tput setaf 4)
RESET=$(tput sgr0)

# Build PS1-style prefix (green user@host, blue directory)
prefix="${BOLD}${GREEN}$(whoami)@$(hostname -s)${RESET}:${BOLD}${BLUE}$(pwd)${RESET}"

# Output prefix
printf '%s' "${prefix}"

# Check for word highlight info
if [ -f "$HIGHLIGHT_FILE" ]; then
  content=$(cat "$HIGHLIGHT_FILE" 2>/dev/null)

  if echo "$content" | grep -q '"active":true'; then
    word=$(echo "$content" | sed -n 's/.*"highlightedWord":"\([^"]*\)".*/\1/p')
    idx=$(echo "$content" | sed -n 's/.*"highlightedWordIndex":\([0-9]*\).*/\1/p')
    total=$(echo "$content" | sed -n 's/.*"wordCount":\([0-9]*\).*/\1/p')

    if [ -n "$word" ]; then
      chars=${#word}
      pos=$((idx + 1))
      # Plain text - no color styling (color bleeding issues were unsolvable)
      printf ' | "%s" (%d) %d/%d' "$word" "$chars" "$pos" "$total"
    fi
  fi
fi

# Final reset
printf '%s' "${RESET}"
```

**Note**: We intentionally use plain text for the highlighted word display because ANSI color codes caused color bleeding issues that proved unsolvable in the status line context.

### 4. Settings (~/.claude/settings.json)

```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/user/.claude/highlight-statusline.sh"
  }
}
```

---

## Multi-Instance Support

When running multiple Claude Code instances, each needs its own state file to avoid interference.

### The Problem

If all instances write to `/tmp/state.json`, the status line shows data from whichever instance wrote last - not the current instance.

### Solution: PID-Based File Paths

**In the patch (Node.js side):**
```javascript
var exportPath = "/tmp/claude-highlight-state-" + process.pid + ".json";
require("fs").writeFileSync(exportPath, JSON.stringify(state));
```

**In the status line script (Bash side):**
```bash
# Walk up process tree to find Claude Code's PID
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
```

### CRITICAL: Process Name Gotcha

**Claude Code's cmdline is just `claude`, NOT `node /path/to/cli.js`.**

This is because Claude Code is installed as a binary wrapper. When looking for the Claude Code process in the process tree:

| Pattern | Works? | Notes |
|---------|--------|-------|
| `grep -q "node.*cli.js"` | ❌ NO | Binary doesn't show this |
| `grep -q "^claude"` | ✅ YES | Actual cmdline |
| `grep -q "anthropic"` | ❌ NO | Not in cmdline |

**Verification:**
```bash
# Find Claude Code's actual process and cmdline
for pid in /proc/[0-9]*; do
  cmdline=$(cat $pid/cmdline 2>/dev/null | tr '\0' ' ')
  if echo "$cmdline" | grep -q "^claude"; then
    echo "PID $(basename $pid): $cmdline"
  fi
done
```

### Why Not Use $PPID?

The status line script is spawned through intermediate processes:
```
Claude Code (PID 12345) → spawnSync → /bin/sh → bash script
```

So `$PPID` in the script is the `/bin/sh` PID, not the Claude Code PID. You must walk up the tree.

---

## Troubleshooting

### Status line not showing at all

1. Check script is executable: `chmod +x ~/.claude/my-statusline.sh`
2. Check script runs manually: `~/.claude/my-statusline.sh`
3. Check settings.json has correct path (full absolute path)
4. Restart Claude Code

### Status line not refreshing on custom events

1. Verify trigger is exported: `grep '_triggerStatusLineRefresh' cli.js`
2. Verify trigger is called: Add console.log in key handler
3. Check state file is written: `cat /tmp/my-state.json`
4. Remember: 300ms debounce means rapid calls are batched

### Script output looks wrong

1. Check for Windows line endings: `sed -i 's/\r$//' script.sh`
2. Test script manually with sample data
3. Use `printf` instead of `echo` for ANSI codes

### JSON parsing issues

1. Avoid `jq` - it may not be in Claude Code's PATH
2. Use `grep`/`sed` for simple extraction
3. Always quote variables and handle empty values

---

## Version Compatibility

**Two patterns are supported** (the code tries both):

1. **Old pattern** (pre-v2.1.69): `O=Wn(()=>X(A),300)` — debounced function via `Wn`
2. **New pattern** (v2.1.69+): `useCallback`-based with `clearTimeout`/`setTimeout(300)`

The code in `wordHighlight.ts` → `writeStatusLineTriggerExport()` tries the old `Wn` pattern first, then falls back to the `useCallback` pattern.

- Variable names (`O`, `X`, `A`) change each version
- The regex uses capture groups to handle this
- If the debounce time (300) changes, update the pattern

### Verification Commands

```bash
# Check the 300ms debounce pattern exists (status line trigger)
grep -o '=Wn(()=>[A-Za-z]*([A-Z]),300)' /path/to/cli.js
# Should output the pattern like: =Wn(()=>X(A),300)

# Check trigger is exported
grep -c '_triggerStatusLineRefresh' /path/to/cli.js
# Should output: 10 (1 export + 8 key handlers + 1 clear-on-typing)

# Check PID-based export path
grep 'claude-highlight-state' /path/to/cli.js
# Should output: var _hlExportPath="/tmp/claude-highlight-state-"+process.pid+".json";
```

---

*Last updated: March 2026*
