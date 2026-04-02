---
last_updated: 2026-04-02
---

# Word Cycling

Replace the focused word with an alternative. Cycling is the **vertical** axis — once a word is selected via navigation (feature 1), cycling changes what that word is.

- `currentAltIndex` tracks position in the cycle
- Original word is always `alts[0]`
- Wraps around: after the last alt, returns to `alts[0]`

**Cycling priority** (checked in order):
1. **Cue-action** → trigger built-in behavior (numbers increment/decrement, custom actions run scripts). No tips, no LLM alts.
2. **Alternatives** → cycle through alternatives from local/remote cues
3. **Linked words** → co-dependent words cycle to the same index

### Cue-Actions

Cue-actions are words with built-in cycling behavior that bypasses the normal alternatives pipeline. They never show tips or alts in the secondary display. There are two kinds:

**Custom cue-actions** — trigger external scripts (e.g., "volume" → system volume control). See feature 11.

**Number cue-actions** — increment/decrement numerals:

- **Up**: increments by 1 (no upper limit): 0 → 1 → 2 → 3...
- **Down**: decrements by 1, but never below the **floor**
- The **floor** is the original value captured on first Up or Down press (not when highlighting)
- Each number tracks its floor independently (keyed by position)
- Navigating away and back preserves the floor

Example: highlight `0`, press Up 4 times → 1 → 2 → 3 → 4. Press Down 6 times → 3 → 2 → 1 → 0 → 0 → 0 (floors at 0).
