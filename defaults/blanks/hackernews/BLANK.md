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
---

Implementation: built-in `HackerNewsBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/hackernews.ts`). Every host
wires it via `createDefaultBlanksRegistry`; the runtime dispatches
via `blankInvoke`.
