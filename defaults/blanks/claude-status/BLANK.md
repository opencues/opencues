---
name: claude-status
type: blank
blankKeywords: is claude down, claude status, claude api status
blankAutoPopulate: true
blankFormat: string
blankTip: Claude / Anthropic service status
blankDismissible: true
# Auto: bare "is claude down _" / "claude status _" → wipe → just the
# Yes/No + reason ("No — all systems operational"). Copula phrasings
# ("the claude api is _") → keep → preserves the lead-in.
# The Yes/No answer reads naturally on its own — no get() reformat needed.
blankReplace: auto
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
