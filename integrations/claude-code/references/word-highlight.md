---
last_updated: 2026-03-27
---

# Word Highlight Navigation — Full Reference

> Extracted from CLAUDE.md. For the summary, see the main CLAUDE.md Feature 2 section.

## Navigation Modes

**Four navigation modes** (configured via `highlightMode`):

| Mode | Behavior | Example |
|------|----------|---------|
| `'numbers'` | Only jump between numeric tokens | `"abc 1 test 3"` → 3 → 1 (skips abc, test) |
| `'words'` | Jump between all words | `"abc 1 test 3"` → 3 → test → 1 → abc |
| `'gender'` | Only jump between boy/girl (root words) | `"The boy said he"` → only "boy" selectable |
| `'both'` | Jump between numbers AND boy/girl | `"The boy has 3 cats"` → 3 → boy (both selectable) |

**Number pattern**: `/^-?\d+(\.\d+)?$/` matches integers, decimals, and negatives (e.g., `42`, `-5`, `3.14`). Note: requires digits after decimal (so `"2."` does NOT match, preventing edge case bugs)

**Gender pattern**: `/^(boy|girl)$/i` matches root words only. Related words (he/him/man, she/her/woman) are highlighted together but not individually selectable.

## Keys

- **Ctrl+Alt+Left**: Highlight token to the left (or activate at rightmost if inactive)
- **Ctrl+Alt+Right**: Highlight token to the right (or activate at rightmost if inactive, **clear if already at rightmost**)
- **Ctrl+Alt+Up**: Increment number by 1 / Flip gender words to opposite
- **Ctrl+Alt+Down**: Decrement number (stops at original) / Restore original gender
- **Escape** or **any typing**: Clear highlight

## Increment/Decrement Behavior (Numbers Mode)

When a number is highlighted, Up/Down modify the actual text:
- Up: 0 → 1 → 2 → 3 → 4... (no upper limit)
- Down: 4 → 3 → 2 → 1 → 0 → 0 → 0 (stops at the original value when first highlighted)
- The `originalNumber` is stored when you first press Up or Down (not when highlighting), capturing the pre-edit value
- Each number remembers its own original value independently (stored in `originalNumbers` map)
- Navigating to a different number and back preserves the original floor

## Gender Flip Behavior (Gender Mode)

When a root word (boy/girl) is highlighted, Up/Down flip only the LINKED group:
- Up: Flips only words linked to the selected root word
  - If "boy" selected: flips boy→girl, he→she, him→her, man→woman
  - If "girl" selected: flips girl→boy, she→he, her→him, woman→man
  - Other gender words NOT in the linked group remain unchanged
- Down: Restores ALL words to original gender (before any edits)
- Case is preserved character-by-character (He→She, HIM→HER, Boy→Girl)
- Linked groups: boy/he/him/his/man/he's (male) | girl/she/her/woman/she's (female)
- When root word selected, only its linked group highlights together (white)
- Only root words (boy/girl) appear dimmed when not selected

## Cursor Position Preservation

When flipping words or incrementing/decrementing numbers, the cursor position is intelligently adjusted:
- If cursor is at end of text, it stays at end after the change
- For replacements before the cursor: offset adjusts by length difference (e.g., boy→girl adds 1)
- For replacements after the cursor: offset stays the same
- For restore (Down on gender): offset clamps to new text length

## Output Format

State exported to `/tmp/claude-highlight-state-{PID}.json`:
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

## Number Dimming

When `numberDimming` is enabled (default: true), all numbers in the input appear in dark gray (`\x1b[90m`), making them visually distinct from regular text.

**Key implementation details:**
- Uses **raw ANSI codes** (not chalk) for consistent coloring
- **Discards base ANSI codes** for colored characters to prevent stacking
- **Reset prefix** on each color code prevents "double cursor" bug
- Dim: `\x1b[0m\x1b[90m` (reset + dark gray) | Highlight: `\x1b[0m\x1b[1;97m` (reset + bold bright white)
- Cursor characters (`\x1b[7m` inverse mode) are passed through unchanged

**Why reset prefix is critical:**
When cursor exits a character, inverse-off code (`\x1b[27m`) goes to `_pending`. We discard `_pending` for dimmed chars, but without a reset, inverse mode leaks to the next character, causing a "ghost cursor" (darker double cursor to the right).

**Why raw ANSI with base code discarding:**
Previous approaches failed because ANSI codes would stack on top of existing styling, causing inconsistent colors after highlighting/unhighlighting. By discarding the base ANSI codes for characters we're coloring and applying fresh codes, we get consistent results every time.

## Patch Injection Points

The patch injects code in **six locations**:

| Patch | Location | Purpose |
|-------|----------|---------|
| Key handler | `VA()` switch statement | Detect Ctrl+Alt+Left/Right/Up/Down keys |
| Raw sequence | Default case nested switch | Fallback for `\x1B[1;7D/C/A/B` sequences |
| Clear on escape | Escape case handler | Clear highlight state |
| Clear on typing | Input handler function | Clear highlight on text changes |
| Rendering | `renderedValue` wrapper | Apply dim to numbers, white to highlighted word |
| Status line trigger | INK component | Expose vh6 trigger for status line refresh |

**Key detection**: Checks `key.{left,right,up,down}Arrow && key.ctrl && (key.meta || key.option || key.alt)` plus raw sequence fallback for `\x1B[1;7{D,C,A,B}` (modifier 7 = Ctrl+Alt).

**State storage**: Uses `globalThis._hlState = {active, index, wordIndex, text, originalNumbers, originalGender}` and `globalThis._hlText` for current input text.
- `originalNumbers`: Map of `wordIndex → originalNumber` for tracking each number's floor independently
- `originalGender`: Stores original text before any gender flips (for restore on Down)

## The Invisible Character Toggle (Critical)

**Problem**: Updating `globalThis._hlState` doesn't trigger a React re-render. Claude Code's input handler only calls the `onChange` callback when **text actually changes**.

**Solution**: Toggle between TWO invisible Unicode characters:
- `\u200B` (zero-width space)
- `\u200C` (zero-width non-joiner)

Each navigation checks what the **parent** has and inserts the **opposite**, ensuring text always changes.

**Key quirks solved**:
1. **Cursor wall bug**: Append at END of text (not at cursor position) using `fromText(R.text + char, G, R.offset)`
2. **Parent-based toggle**: Store parent value in `globalThis._parentValue`, check it in key handler
3. **R stripping**: Strip invisible chars from R **outside** IIFE (need to reassign `let`-bound R)
4. **Clear-on-typing**: Compare text **without** invisible chars to detect real user input

## Status Line Integration

The word highlight feature integrates with Claude Code's status line to show highlighted word info.

**How it works:**
1. Key handler writes state to `/tmp/claude-highlight-state-{PID}.json` (sync, PID-based)
2. Key handler calls `globalThis._triggerStatusLineRefresh()` to trigger status line update
3. Status line script walks process tree to find Claude Code's PID
4. Status line script reads JSON and displays: `"word" (chars) pos/total` (plain text, no color)

**The Status Line Trigger Pattern (Important for future features):**

Claude Code's status line only refreshes on specific events (messages, permissions, vim mode changes). To make it refresh on custom events:

1. **Expose the trigger**: Patch INK component to store debounced vh6 in globalThis
   ```javascript
   // Pattern: O=Wn(()=>X(A),300)
   // Becomes: O=Wn(()=>X(A),300);globalThis._triggerStatusLineRefresh=O
   ```

2. **Call the trigger**: From your custom code, call the stored function
   ```javascript
   if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
   ```

**Files:**
- Patch: `writeStatusLineTriggerExport()` in `wordHighlight.ts`
- Status line script: `~/.claude/highlight-statusline.sh`
- Settings: `~/.claude/settings.json` → `statusLine.command`

**Multi-Instance Support:**
- State files use PID: `/tmp/claude-highlight-state-${process.pid}.json`
- Status line script walks process tree to find Claude Code's PID
- **CRITICAL GOTCHA**: Claude Code's cmdline is `claude`, NOT `node cli.js`
  - Use `grep -q "^claude"` to find the process
  - Do NOT use `grep -q "node.*cli.js"` (won't match)
  - See `docs/status-line-integration.md` → "Multi-Instance Support" for details

## Config

In `defaultSettings.ts`:
```typescript
enableWordHighlight: true,
highlightColor: 'white',           // white|cyan|yellow|inverse|underline
highlightIndexFromLeft: false,     // false = right-to-left indexing
highlightWrap: false,              // false = stop at boundaries
highlightClearOnEscape: true,
highlightMode: 'numbers',          // 'numbers' (default) | 'words' | 'gender' | 'both'
highlightExportEnabled: true,
numberDimming: true,               // dim all numbers in dark gray (highlight overrides)
// Note: Export path is PID-based at runtime: /tmp/claude-highlight-state-{PID}.json
```
