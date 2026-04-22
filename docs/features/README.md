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
| 20 | [Consume-Context Blanks](consume-context-blanks.md) | Blanks that collapse keyword + context between keyword and blank, preserving surrounding text |
| 21 | [Cursor Navigate](cursor-navigate.md) | Highlight automatically follows cursor to navigable words |
| 22 | [Word-Alt Routing](word-alt-routing.md) | Per-word dispatch of `### alternatives` cue sources via match/keywords/priority/default |
| 23 | [Chrome Sync](chrome-sync.md) | How `opencues sync chrome` picks which `.opencues/` dirs feed the browser extension (user-only by default; opt-in for projects) |
| 24 | [Shipped Defaults](shipped-defaults.md) | `<repo>/defaults/` as the seed + bake source; the repo no longer self-dogfoods via an in-tree `.opencues/` |
| 25 | [Chrome Hot-Reload](chrome-hot-reload.md) | Content-addressable `.version` polling so chrome picks up `sync chrome --watch` edits in already-open tabs (~2.5s) |
| 26 | [Resolver Skip Filter](resolver-skip-filter.md) | The four-condition check that prevents the LLM from re-resolving words already owned by cycling — keeps cycle tracks stable and saves tokens |
| 27 | [Deterministic Relocate](deterministic-relocate.md) | Cycle progress survives prefix/middle text edits — DynDefs are re-anchored to their content's new position when (and only when) the match is unambiguous |

## Adding a new feature

See `docs/guides/adding-a-feature.md`.
