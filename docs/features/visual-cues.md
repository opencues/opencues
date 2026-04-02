---
last_updated: 2026-04-02
---

# Visual Cues

Visual cues are the indications within the body of text that additional information is available.

Words need three visual states so the user knows what's interactive:

| State | Meaning | When |
|-------|---------|------|
| **Normal** | No alternatives available | Default |
| **Dimmed** | Has alternatives, can be navigated to | Word has alternatives and word is IN the alternatives array |
| **Highlighted** | Currently selected for cycling | User navigated to this word |

When a word is highlighted AND part of a multi-word group or linked words, all related words also show the highlighted state.

Dimming applies to: numbers, cue-actions, and words with alternatives.
