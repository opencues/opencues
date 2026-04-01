---
last_updated: 2026-04-01
---

# Navigation & Rendering — Claude Code Implementation

Implements features 1, 3, 4, 13 from `docs/features.md`: Word Navigation, Visual States, Cursor Preservation, Cursor State Export.

**Patch file:** `patches/wordHighlight.ts`

## Keys

- **Ctrl+Alt+Left**: Highlight token to the left (or activate at rightmost if inactive)
- **Ctrl+Alt+Right**: Highlight token to the right (or activate at rightmost if inactive, **clear if already at rightmost**)
- **Ctrl+Alt+Up**: Increment number / flip gender / cycle alternative
- **Ctrl+Alt+Down**: Decrement number / restore gender / cycle alternative
- **Escape** or **any typing**: Clear highlight

Also handles raw terminal escape sequences (`\x1B[1;7D/C/A/B`) as fallback for terminals that don't set meta/option flags.

## Navigation Modes

Configured via `highlightMode`:

| Mode | What's navigable | Example |
|------|-----------------|---------|
| `'numbers'` | Numeric tokens only | `"abc 1 test 3"` → 3 → 1 |
| `'words'` | All words | `"abc 1 test 3"` → 3 → test → 1 → abc |
| `'gender'` | Gender root words (boy/girl) only | `"The boy said he"` → boy |
| `'both'` | Numbers + gender roots | `"The boy has 3 cats"` → 3 → boy |

Additionally navigable regardless of mode: words with LLM alternatives, words with tips, action words.

**Patterns:**
- Number: `/^-?\d+(\.\d+)?$/` — integers, decimals, negatives (requires digit after decimal)
- Gender: `/^(boy|girl)$/i` — root words only

## Visual States

| State | ANSI Code | When |
|-------|-----------|------|
| Normal | (none) | No alternatives |
| Dimmed | `\x1b[0m\x1b[90m` (dark gray) | Has alternatives and word is IN alts |
| Highlighted | `\x1b[0m\x1b[1;97m` (bold bright white) | Currently selected |

Each colour code starts with `\x1b[0m` reset to prevent ANSI stacking from cursor inverse mode.

Dimming applies to: numbers (if `numberDimming` enabled), gender roots, action words, and words with dynamic alternatives.

When a word is highlighted AND part of a span or linked group, all related words also highlight.

## Cursor Preservation

- Replacement before cursor → offset adjusts by length difference
- Replacement after cursor → offset unchanged
- Cursor at end → stays at end
- Gender restore (Down) → offset clamps to new text length

## Cursor State Export

Writes cursor position to `/tmp/claude-cursor-state.json` (debounced 100ms):

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

Controlled by `enableCursorStateExport` config option.

## Highlight State Export

Writes highlight state to `/tmp/claude-highlight-state-{PID}.json` (sync, on every navigation):

```json
{
  "active": true,
  "highlightedWordIndex": 2,
  "highlightedWord": "agents",
  "wordCount": 5,
  "tip": "Spawn parallel workers via Task tool",
  "alts": ["agents", "swarm", "background"],
  "currentAltIndex": 0,
  "altTips": { "agents": "...", "swarm": "..." },
  "timestamp": 1705500000000
}
```

PID-based path prevents multi-instance interference. Controlled by `highlightExportEnabled` config option.

## Config

```
enableWordHighlight: true       # Master switch
highlightMode: 'numbers'        # 'numbers' | 'words' | 'gender' | 'both'
highlightColor: 'white'         # white | cyan | yellow | inverse | underline
numberDimming: true             # Dim all numbers in dark gray
highlightExportEnabled: true    # Write highlight state JSON
enableCursorStateExport: true   # Write cursor state JSON
highlightClearOnEscape: true
highlightIndexFromLeft: false   # false = right-to-left indexing
highlightWrap: false            # false = stop at boundaries
```

## Related

- `cycling.md` — how Up/Down modifies words
- `alternatives.md` — how alternatives are generated
- `status-line.md` — status line display
- `config.md` — all config options
