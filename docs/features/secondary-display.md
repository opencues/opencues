---
last_updated: 2026-04-02
---

# Secondary Display

Where cue-tips are shown. It is not in the text input box — it is a separate display area.

**What to show:**
- Current word name
- Position in cycle (e.g., "2/4")
- Cue-tip text (if available from local cues)
- Per-alternative cue-tip when cycling

**Integration decides the UI:** status bar, tooltip, hover panel, sidebar, etc.

**Data needed:** The display needs access to: current word, cue-tip text, alternatives list, current position in cycle, and per-alternative cue-tips. How this data flows (file, event, state) depends on the platform.
