---
last_updated: 2026-05-03
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
| 11 | [Cue-Blanks](cue-blanks.md) | Words and `_` positions with built-in cycling — script-driven, auto-populated, step, list, read-only |
| 13 | [Auto-Submit](auto-submit.md) | Automatic analysis as you type |
| 14 | [Cursor Export](cursor-export.md) | Export cursor position for external tools |
| 15 | [Secondary Display](secondary-display.md) | Show cue-tips in a secondary area |
| 16 | [Hot-Reload Config](hot-reload-config.md) | Config file changes take effect without restart |
| 17 | [Selector + Satellite Blanks](selector-satellite.md) | Single `_` becomes two linked words: selector picks a setting, satellite shows/writes its value |
| 18 | [Tip Priority](tip-priority.md) | Which tip source wins when multiple sources match a word |
| 19 | [Consume-All Blanks](consume-all-blanks.md) | Blanks that consume surrounding text and replace it with multi-word cycling alternatives |
| 20 | [Consume-Context Blanks](consume-context-blanks.md) | Blanks that collapse keyword + context between keyword and blank, preserving surrounding text |
| 21 | [Cursor Navigate](cursor-navigate.md) | Highlight automatically follows cursor to navigable words |
| 22 | [Word-Cue Routing](word-cue-routing.md) | Per-word dispatch of folder-based cue sources via per-source match/keywords/priority |
| 23 | [Chrome Sync](chrome-sync.md) | How `opencues sync chrome` picks which `.cues/` dirs feed the browser extension (user-only by default; opt-in for projects) |
| 24 | [Shipped Defaults](shipped-defaults.md) | `<repo>/defaults/` as the seed + bake source for `opencues seed-configs` and the Chrome extension's bundled fallback |
| 25 | [Chrome Hot-Reload](chrome-hot-reload.md) | Content-addressable `.version` polling so chrome picks up `sync chrome --watch` edits in already-open tabs (~2.5s) |
| 26 | [Resolver Skip Filter](resolver-skip-filter.md) | The four-condition check that prevents the LLM from re-resolving words already owned by cycling — keeps cycle tracks stable and saves tokens |
| 27 | [Deterministic Relocate](deterministic-relocate.md) | Cycle progress survives prefix/middle text edits — DynDefs are re-anchored to their content's new position when (and only when) the match is unambiguous |
| 28 | [Config Search Paths](config-search-paths.md) | Three-layer precedence (`$OPENCUES_HOME → <cwd>/.cues → ~/.cues`), the `CUES.md` system-settings user-level-only special case, and how `seed-configs` populates `~/.cues/` |
| 29 | [Transform Blanks](transform-blank.md) | Imperative-instruction blanks at `_` — 3-pass LLM pipeline (EXTRACT → APPLY → VERIFY) that rewrites the surrounding text per the instruction. Plus a generative branch for "write a poem _" / "compose an email _" prompts. The third leg of the blank trio alongside BlankSource (keyword) and FluidBlankSource (lookup). |
| 30 | [Agent Tasks](agent-task.md) | Continuously-running agent loop declared in plain English (`agentically <X> _`). Re-evaluates the doc on every debounce settle; applies edits as dimmed words you can revert via cycling. Per-task invalidation cache keyed on (textHash, taskId). Built on the same DynDef-backed ownership primitives the rest of the runtime uses. |
| 31 | [Blank Loading Animation](blank-loading.md) | Per-frame glyph + colour cycling at `_` slots while their source resolves. Five OPENCUES.md scalars (mode, frames, RGB palette, ANSI palette, interval). Thunk-shaped re-read so hot edits propagate; capability-routed RGB vs ANSI per host. |

## Adding a new feature

See `docs/guides/adding-a-feature.md`.
