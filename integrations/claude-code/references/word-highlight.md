---
last_updated: 2026-04-01
---

# Word Highlight Navigation — Quick Reference

## Navigation Modes

**Four navigation modes** (configured via `highlightMode`):

| Mode | Behavior | Example |
|------|----------|---------|
| `'numbers'` | Only jump between numeric tokens | `"abc 1 test 3"` → 3 → 1 (skips abc, test) |
| `'words'` | Jump between all words | `"abc 1 test 3"` → 3 → test → 1 → abc |
| `'gender'` | Only jump between boy/girl (root words) | `"The boy said he"` → only "boy" selectable |
| `'both'` | Jump between numbers AND boy/girl | `"The boy has 3 cats"` → 3 → boy (both selectable) |

**Number pattern**: `/^-?\d+(\.\d+)?$/` matches integers, decimals, and negatives (e.g., `42`, `-5`, `3.14`). Note: requires digits after decimal (so `"2."` does NOT match)

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

## Number Dimming

When `numberDimming` is enabled (default: true), all numbers in the input appear dimmed, making them visually distinct from regular text. Highlighted numbers appear in the highlight colour instead.

## State Export

State exported to `/tmp/claude-highlight-state-{PID}.json`:
```json
{
  "active": true,
  "highlightedWordIndex": 2,
  "highlightedWord": "agents",
  "wordCount": 5,
  "originalNumber": null,
  "tip": "Spawn parallel workers via Task tool",
  "alts": ["agents", "swarm", "background"],
  "currentAltIndex": 0,
  "altTips": {
    "agents": "Spawn parallel workers via Task tool",
    "swarm": "Multiple coordinated agents working on related tasks"
  },
  "timestamp": 1705500000000
}
```

## Config

```typescript
enableWordHighlight: true,
highlightColor: 'white',           // white|cyan|yellow|inverse|underline
highlightIndexFromLeft: false,     // false = right-to-left indexing
highlightWrap: false,              // false = stop at boundaries
highlightClearOnEscape: true,
highlightMode: 'numbers',          // 'numbers' (default) | 'words' | 'gender' | 'both'
highlightExportEnabled: true,
numberDimming: true,               // dim all numbers (highlight overrides)
```

## Related

- `references/status-line.md` — status line display and tips
- `references/dynamic-highlight.md` — LLM alternatives and cycling
- `references/config.md` — all configuration options
