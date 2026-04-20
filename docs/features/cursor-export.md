---
last_updated: 2026-04-02
---

# Cursor State Export

Export the current cursor position and context for external tools.

## Cursor state

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

## Highlight state

Separately from cursor state, the system should export the current highlight state for the secondary display (feature 14) and external tools:

- Whether highlight is active
- Highlighted word and its index
- Cue-tip text and per-alternative cue-tips
- Alternatives list and current position in cycle
- Word count

**Implementation considerations:**
- Write synchronously (not debounced) so data is ready before the secondary display reads it
- Use instance-specific identifiers (e.g., PID) to prevent interference between multiple running instances
- Updated on every navigation AND on every cycle (Up/Down)

## Portability

### Standard (opencues-core)

- opencues-core has no cursor awareness — this feature is entirely integration-specific
- The library operates on text strings and word indices; it never tracks cursor position
- No file I/O or event-emission facilities are provided by the core library

### Integration responsibilities

- Track the cursor offset within the editor's text buffer in real time
- Export cursor state (text, offset, current word, at-end flag, timestamp) to a platform-appropriate target (file, event, API)
- Debounce cursor-state writes (~100ms) to limit I/O overhead from rapid keystrokes
- Export highlight state synchronously (not debounced) so secondary displays read consistent data
- Use instance-specific identifiers (e.g., PID) to prevent interference between multiple running instances
- Choose the serialization format (JSON file, shared memory, IPC channel) based on the editor platform
