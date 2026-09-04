---
name: claude-status
# The four get() lines are CYCLEABLE ALTERNATIVES (yes/no, indicator,
# component breakdown, incident context - progressively more detail),
# not one card. The #339 sweep briefly joined them; unpinned 2026-09-03.
type: blank
blankKeywords: is claude down, claude status, claude api status
blankAutoPopulate: true
blankFormat: string
tip: Claude / Anthropic service status
blankDismissible: true
# Clearing is SHAPE-DERIVED (the blankReplace dial was deleted, June 2026):
# a bare keyword get keeps its label — "claude status _" fills the `_`
# with the Yes/No + reason ("No — all systems operational") and the
# lead-in stays. No get() reformat needed; the answer reads on its own.
blankClearOnEdit: true
# Blank-as-context: when blank-context-mode is on, expose Anthropic
# API status as [CLAUDE-STATUS API] so casual phrasings ("is claude
# working _", "anything broken _", "should i wait to retry _") route
# through the catalog without typing the keyword.
as-context: safe
context-slots: api
---

Implementation: built-in `ClaudeStatusBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/claude-status.ts`). Hits the
public Statuspage API at `https://status.claude.com/api/v2/summary.json` and
synthesises four cycling alts from one fetch:

1. `Yes/No — <reason>` (default — answers the literal question)
2. `<indicator>` (one-word verdict: `none` / `minor` / `major` / …)
3. Per-component breakdown
4. Active or last incident with relative timestamp

30-second cache (status pivots quickly during incidents — the longer
TTL we use for weather would be too stale here). Read-only; no API
key required. Works on every host that mounts `@opencues/runtime`
with a fetch implementation (native + Chrome).
