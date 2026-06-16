---
name: hackernews
type: blank
blankKeywords: hn, hackernews
blankKeywordExpansions.hn: HackerNews
blankAutoPopulate: true
blankFormat: string
blankTip: Hacker News
blankReadOnly: true
blankDismissible: true
blankProximity: 3
# Auto: bare "hn _" → wipe → "<top story title>" (self-contained).
# Copula phrasing → keep.
blankReplace: auto
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
via `blankInvoke`.
