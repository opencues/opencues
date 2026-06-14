---
name: hackernews
type: blank
blankKeywords: hn, hackernews
blankKeywordExpansions.hn: HackerNews
# blankShapes: precision gate (June 2026). Anchored bare-keyword
# patterns — drops prose like "I posted on hn yesterday _" or
# "hackernews was buggy _" from claiming the slot.
blankShapes: [{"pattern":"^(?:hn|hackernews)\\s*_$","action":"get"}]
blankAutoPopulate: true
blankFormat: string
blankTip: Hacker News
blankReadOnly: true
# Multi-alt cycle vocab: the script returns multiple top-story
# titles, one per line. blankDismissible lets the user cycle through
# them with Ctrl+Alt+↑/↓ and dismiss back to `_`. Emission is the
# one-span shape (no selector-satellite split) — the cyclable thing
# IS the whole substitution.
blankDismissible: true
blankClearOnEdit: true
blankConsumeContext: true
# Blank-as-context: when blank-context-mode is on, expose the current
# top story as [HACKERNEWS TOP] so casual phrasings ("anything
# interesting on hn _", "write a quick comment about today's top hn
# story _") route through the catalog without typing the keyword.
as-context: safe
context-slots: top
---

Implementation: built-in `HackerNewsBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/hackernews.ts`). Every host
wires it via `createDefaultBlanksRegistry`; the runtime dispatches
via `blankInvoke`. Multi-line stdout: each line is one cycleable alt.
