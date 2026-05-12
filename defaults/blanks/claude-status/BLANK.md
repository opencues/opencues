---
name: claude-status
type: blank
blankKeywords: is claude down, claude status, claude api status
blankAutoPopulate: true
blankFormat: string
blankTip: Claude / Anthropic service status
blankDismissible: true
blankReplace: keep
blankClearOnEdit: true
impl: ./blank.js
network: [status.claude.com]
storage: claude-status
---

Dispatched by the shared runtime `ClaudeStatusBlank`
(`packages/opencues-runtime/src/blanks/claude-status.ts`). Hits the
public Statuspage API at `status.claude.com/api/v2/summary.json` and
synthesises four cycling alts from one fetch:

1. `Yes/No — <reason>` (default — answers the literal question)
2. `<indicator>` (one-word verdict: `none` / `minor` / `major` / …)
3. Per-component breakdown
4. Active or last incident with relative timestamp

30-second cache (status pivots quickly during incidents — the longer
TTL we use for weather would be too stale here). Read-only; no API
key required. Works on every host that mounts `@opencues/runtime`
with a fetch implementation (native + Chrome).
