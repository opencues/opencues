# Cursor Positioning

How the cursor is managed during auto-populate (blank fill) in Claude Code's terminal input.

## The Problem

When a blank (`_`) fills with a value (e.g. `_` → `$186.43`), the text changes via `onChange(newText)`. This replaces the **entire input value**, which causes cursor issues:

1. **Editor keeps same numeric position** — cursor was at position 8 in `"stocks _"`, stays at position 8 in `"stocks $186.43"`, landing inside the value.
2. **Controlled component** — the parent component stores cursor offset via `externalOffset`. Modifying the local `InputZone` only affects the current render; the next render reverts to the parent's stale offset.

## The Solution

Two-phase cursor correction:

### Phase 1: Compute target at insertion time

At the point where `_` is replaced (`wordHighlight.ts` lines ~796, ~813), we know the user's exact cursor position and the exact text transformation:

```
_pendingCursorTarget = adjusted cursor position in new text
_pendingCursorExpected = user's current clean cursor position (for validation)
```

**Delta calculation:**
- `_apStart` = character position of `_` in the text
- `V` = length of replacement value
- If cursor `>= _apStart`: target = `Math.max(cursor, _apStart + 1) + (V - 1)`
- If cursor `< _apStart`: target = cursor (unchanged)

The `Math.max(cursor, _apStart + 1)` handles the edge case where cursor is ON the `_` (at `_apStart`). Without it, the formula gives `_apStart + V - 1` (one char short). With it, we treat the cursor as if it's after the `_`, giving `_apStart + V` (end of value).

### Phase 2: Apply and persist at render time

On the next render (`wordHighlight.ts` line ~663):

1. **Validate** — compare the editor's reported cursor against `_pendingCursorExpected` (within 1 char tolerance for ZWS). If the cursor moved (user typed), skip the fix.
2. **Apply locally** — `InputZone.fromText(cleanText, config, target)` sets cursor for this render.
3. **Persist in framework** — `onOffsetChange(target)` updates the parent component's `externalOffset` state so subsequent renders use the corrected position.
4. **Clear** — null out both globals. Fires exactly once.

## Key Variables

| Variable | Set at | Read at | Purpose |
|----------|--------|---------|---------|
| `_pendingCursorTarget` | Insertion (line ~796, ~813) | Render (line ~663) | Target cursor position in new text |
| `_pendingCursorExpected` | Insertion | Render | Expected stale cursor for validation |
| `onOffsetChangeVar` | — | Render | Framework callback to persist offset |

## ZWS Considerations

The input text contains invisible ZWS characters (`\u200B`, `\u200C`) used to force re-renders. Cursor positions must be converted between raw (includes ZWS) and clean (excludes ZWS) coordinates:

- **At insertion time**: compute clean cursor by subtracting ZWS count before cursor
- **At render time**: pass **clean text** to `fromText()` to avoid double-correction by the ZWS strip block (lines 664–668). If raw text is passed, the ZWS block subtracts ZWS count from an already-clean offset.

## Pitfalls

### 1. `fromText` alone is not enough
`InputZone.fromText()` creates a new object for the current render cycle, but the parent component's `externalOffset` state doesn't change. Without calling `onOffsetChange(offset)`, the cursor reverts on the next render.

### 2. ZWS double-correction
If the cursor fix passes raw text (with ZWS) to `fromText()` with a clean offset, the ZWS strip block (line ~664) runs afterward and subtracts ZWS count again. Always use clean text in the cursor fix so the ZWS block is a no-op.

### 3. Cursor ON the `_` vs AFTER the `_`
When `_` is the last word (no text after it), the user's cursor is at `_apStart` (on the `_`), not `_apStart + 1` (after it). The naive delta `cursor + (V - 1)` gives `_apStart + V - 1` — one char short. Use `Math.max(cursor, _apStart + 1)` to bump it past the `_` before applying the delta.

### 4. Multiple blanks filling in sequence
Each auto-populate processes one blank per render. If the cursor fix (line ~663) and auto-populate (line ~696) both run in the same render, auto-populate reads the corrected cursor (set by the fix), not the user's actual cursor. This is correct — the corrected position IS where the cursor should be for the purpose of computing the next fill's delta.

### 5. Stale target when user types between renders
The `_pendingCursorExpected` validation catches this: if the editor's cursor doesn't match what we stored, the user moved (typed more). We skip the fix and clear the globals.

### 6. Never apply cursor fix repeatedly
Always clear `_pendingCursorTarget` after applying (whether or not the validation passes). Repeated application causes "cursor dragging" — the cursor gets pulled back to the target on every render.

## When to Update This

If you change:
- How `onChange` is called during auto-populate
- The ZWS toggle mechanism
- The `InputZone.fromText` API or how `externalOffset`/`onOffsetChange` work
- The render function's execution order (cursor fix must run before auto-populate)
