---
last_updated: 2026-04-02
---

# Cue-Actions

Words with built-in cycling behavior that bypasses the normal alternatives pipeline. Cue-actions never show tips or alts in the secondary display.

There are two kinds:

- **Custom cue-actions** — trigger external scripts instead of modifying text (e.g., "volume" → system volume control). Configured per-word with custom arguments for up/down directions.
- **Number cue-actions** — increment/decrement numerals. Any word matching `/^-?\d+(\.\d+)?$/` is automatically a cue-action. See feature 2 (cycling) for floor behavior.

Cue-actions are checked **first** before any other cycling logic.

**Priority:** Cue-actions (custom + numbers) → alternatives → linked words
