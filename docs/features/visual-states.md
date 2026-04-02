---
last_updated: 2026-04-02
---

# Visual States

Words need three visual states so the user knows what's interactive:

| State | Meaning | When |
|-------|---------|------|
| **Normal** | No alternatives available | Default |
| **Dimmed** | Has alternatives, can be navigated to | Word has `alts.length > 1` and word is IN the alts array |
| **Highlighted** | Currently selected for cycling | User navigated to this word |

When a word is highlighted AND part of a span or linked group, all related words also show the highlighted state.

Dimming applies to: numbers (if numberDimming enabled), gender root words, action words, and words with dynamic alternatives.


