---
last_updated: 2026-04-02
---

# Cursor State Export

Export the current cursor position and context for external tools.

**Data to export:**
- Current text content
- Cursor offset (character position)
- Current word (the word at the cursor)
- Whether cursor is at end of text
- Timestamp

**Implementation considerations:**
- Debounce writes (~100ms) to avoid I/O overhead from rapid keystrokes
- Use platform-appropriate mechanism (file, event emitter, API, etc.)
- Enables external tools to react to cursor position in real time


