---
last_updated: 2026-04-02
---

# Status Display

Secondary display showing info about the highlighted word.

**What to show:**
- Current word name
- Position in cycle (e.g., "2/4")
- Tip text (if available from tips file)
- Per-alt tip when cycling (from `altTips`)

**Integration decides the UI:** status bar, tooltip, hover panel, sidebar, etc.

**Data needed:** The display needs access to: current word, tip text, alternatives list, current position in cycle, and per-alternative tips. How this data flows (file, event, state) depends on the platform.
