---
last_updated: 2026-04-02
---

# Feature Concepts

Platform-agnostic feature specifications. Each integration implements these concepts with its own UI. See `docs/glossary.md` for terminology.

| # | Feature | Description |
|---|---------|-------------|
| 1 | [Navigation](navigation.md) | Move between words to select one |
| 2 | [Cycling](cycling.md) | Change the selected word via alternatives |
| 3 | [Visual Cues](visual-cues.md) | Indicate available alternatives within the text |
| 4 | [Cursor Preservation](cursor-preservation.md) | Adjust cursor when words change length |
| 5 | [Linked Words](linked-words.md) | Words that must change together |
| 6 | [Local Cues](local-cues.md) | Alternatives computed locally (~0ms) |
| 7 | [Remote Cues](remote-cues.md) | Alternatives computed via LLM (~200-500ms) |
| 8 | [Fill-in-the-Blank](fill-in-the-blank.md) | Underscore placeholder filling |
| 9 | [Multi-Word Spans](multi-word-spans.md) | Alternatives that are multiple words |
| 10 | [Per-Word Clearing](per-word-clearing.md) | Preserve alternatives when editing text |
| 11 | [Cue-Controls](cue-controls.md) | Words that trigger external controls |
| 12 | [Control Blanks](control-blanks.md) | Blanks bound to controls — auto-populate, step, list, read-only |
| 13 | [Auto-Submit](auto-submit.md) | Automatic analysis as you type |
| 14 | [Cursor Export](cursor-export.md) | Export cursor position for external tools |
| 15 | [Secondary Display](secondary-display.md) | Show cue-tips in a secondary area |
| 16 | [Hot-Reload Config](hot-reload-config.md) | Config file changes take effect without restart |
| 17 | [Selector + Satellite Blanks](selector-satellite.md) | Single `_` becomes two linked words: selector picks a setting, satellite shows/writes its value |
| 18 | [Tip Priority](tip-priority.md) | Which tip source wins when multiple sources match a word |
| 19 | [Consume-All Blanks](consume-all-blanks.md) | Blanks that consume surrounding text and replace it with multi-word cycling alternatives |

## Adding a new feature

See `docs/guides/adding-a-feature.md`.
