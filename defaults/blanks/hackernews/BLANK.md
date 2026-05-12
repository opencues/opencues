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
impl: ./blank.js
network: [hacker-news.firebaseio.com]
storage: hackernews
# Auto: bare "hn _" → wipe → "<top story title>" (self-contained).
# Copula phrasing → keep.
blankReplace: auto
---

Dispatched by the shared runtime `HackerNewsBlank`
(`packages/opencues-runtime/src/blanks/hackernews.ts`). No `blankScript:`
field — every host wires `HackerNewsBlank` into its blanks registry,
the runtime dispatches via `blankInvoke`. The previous `hn-blank.sh`
shell script was deleted on 2026-04-18 once chrome + opencode were both
verified green on the runtime path.
