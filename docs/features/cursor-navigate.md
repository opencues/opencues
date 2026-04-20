---
last_updated: 2026-04-13
---

# Cursor Navigate

Automatically highlight the word at the cursor position. Instead of requiring explicit key presses (Ctrl+Alt+Left/Right) to move between words, the highlight follows the cursor as the user moves through the text.

This is an optional mode that complements manual navigation (feature 1). When active, moving the cursor into a navigable word highlights it immediately; moving to a non-navigable word or past the end of text deactivates the highlight.

---

## How It Works

1. **Gate**: cursor-navigate only runs when `cursor-navigate: active` is set in `opencues.md`
2. **Offset to word**: On each text change or cursor movement, the cursor's character offset is mapped to a word index by walking the whitespace-split word array
3. **Change detection**: The system tracks `_cursorNavLastWordIdx`. If the cursor is on the same word as last time, no action is taken — this avoids redundant re-evaluation
4. **Navigability check**: The word at the cursor is checked against the same sources as manual navigation:
   - Cue-control words (`_isCueControl`)
   - Local cue map (`_localCueMap`) — words with pre-computed tips/alts
   - Dynamic definitions (`_dynDefs`) — words with LLM-generated alternatives
   - Span membership (`_dynSpans`) — non-origin span positions snap to the original
5. **Activate or deactivate**: If the word is navigable, `_hlState` is set to highlight it. If not navigable (and user hasn't manually navigated), the highlight is cleared
6. **Keyword skip**: Words that are blank-keyword context (e.g., "volume" in "volume _") are skipped — the blank owns the interaction, not cursor-navigate

---

## Interaction with Manual Navigation

Cursor-navigate and manual navigation (Ctrl+Alt+Left/Right) coexist:

- **Manual navigation sets `_hlManualNav = true`**, which prevents cursor-navigate from overriding the user's explicit selection
- **Text changes reset `_hlManualNav`**, allowing cursor-navigate to resume on the new text
- **`_cursorNavLastWordIdx` resets on text change**, ensuring the first cursor evaluation on new text always runs

---

## Configuration

In `opencues.md`:

```yaml
cursor-navigate:
  tip: Auto-highlight word at cursor
  values:
    active: Highlight follows cursor to navigable words
    inactive: Manual navigation only
```

This is a selector/satellite setting — it can be toggled via `opencues settings _` without restarting.

---

## Portability

### Standard (opencues-core)

- opencues-core has no cursor awareness — cursor-navigate is entirely integration-specific
- The navigability criteria (cue-control, local cues, LLM alts, spans) are the same as manual navigation
- opencues-core provides `WordDef` classification; the integration decides how to map cursor position to word index

### Integration responsibilities

- Track cursor offset within the editor's text buffer in real time
- Map character offset to word index on each cursor movement or text change
- Track the last-evaluated word index to avoid redundant re-evaluation
- Check navigability using the same sources as manual navigation (cue-controls, local cues, dynamic defs, spans)
- Skip blank-keyword positions (words that serve as context for a nearby blank)
- Respect manual navigation: do not override when the user has explicitly navigated via keys
- Reset tracking state (`_cursorNavLastWordIdx`, `_hlManualNav`) when the input text changes
- Provide a user-facing toggle (e.g., a setting in the config) to enable/disable the feature
