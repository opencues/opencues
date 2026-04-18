---
name: hackernews
type: control
control: hackernews
blankKeywords: hn, hackernews
blankKeywordExpansions.hn: HackerNews
blankAutoPopulate: true
blankFormat: string
blankTip: Hacker News
blankReadOnly: true
blankDismissible: true
blankProximity: 3
---

Dispatched by the shared runtime `HackerNewsControl`
(`packages/opencues-runtime/src/controls/hackernews.ts`). No `blankScript:`
field — every host wires `HackerNewsControl` into its controls registry,
the runtime dispatches via `controlInvoke`. The previous `hn-blank.sh`
shell script was deleted on 2026-04-18 once chrome + opencode were both
verified green on the runtime path.
