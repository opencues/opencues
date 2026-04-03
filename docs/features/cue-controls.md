---
last_updated: 2026-04-03
---

# Cue-Controls

Words with built-in cycling behavior that bypasses the normal alternatives pipeline. Cue-controls never show tips or alts in the secondary display.

There are two kinds:

- **Custom cue-controls** — trigger external scripts instead of modifying text (e.g., "volume" → system volume control). Configured per-word with custom arguments for up/down directions.
- **Number cue-controls** — increment/decrement numerals. Any word matching `/^-?\d+(\.\d+)?$/` is automatically a cue-control. See feature 2 (cycling) for floor behavior.

Cue-controls are checked **first** before any other cycling logic.

**Priority:** Cue-controls (custom + numbers) → alternatives → linked words
