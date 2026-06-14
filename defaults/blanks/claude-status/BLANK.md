---
name: claude-status
type: blank
blankKeywords: is claude down, claude status, claude api status
# blankShapes: precision gate (June 2026). Anchored multi-word
# triggers — drops prose like "claude was so down on me _" or
# "the claude api was annoying _" from claiming.
blankShapes: [{"pattern":"^is\\s+claude\\s+down\\s*_$","action":"get"},{"pattern":"^claude\\s+(?:api\\s+)?status\\s*_$","action":"get"}]
blankAutoPopulate: true
blankFormat: string
blankTip: Claude / Anthropic service status
# Multi-alt cycle vocab: the script synthesises 4 alts from one
# Statuspage fetch:
#   1. Yes/No — <reason>           (default — answers the literal question)
#   2. <indicator>                  (one-word verdict)
#   3. Per-component breakdown
#   4. Active or last incident
# blankDismissible lets the user cycle through them with Ctrl+Alt+↑/↓
# and dismiss back to `_`. One-span emission — the cyclable thing IS
# the whole substitution.
blankDismissible: true
blankClearOnEdit: true
blankConsumeContext: true
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
synthesises four cycling alts from one fetch. 30-second cache.
Read-only; no API key required.
