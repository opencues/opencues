---
name: gh-issues
type: blank
tip: open issue count for a github repo
blankKeywords: gh-issues
# blankShapes: precision gate (June 2026). Captures owner/repo at
# the end. Drops prose where "gh-issues" appears mid-sentence from
# claiming.
blankShapes: [{"pattern":"^gh-issues\\s+([\\w.-]+\\/[\\w.-]+)\\s*_$","action":"get","valueGroup":1}]
blankAutoPopulate: true
blankReadOnly: true
# One-span emission — no cycle vocab.
blankClearOnEdit: true
blankConsumeContext: true
impl: ./blank.js
network: [api.github.com]
storage: gh-issues
---

User-shipped JS blank demo. Type `gh-issues owner/repo _` and the
blank fills with the repo's open-issue count (cached for 5 minutes
in chrome.storage / `~/.cues/.user-blank-state/`).

Demonstrates:
  - `ctx.fetch` (api.github.com only — declared in `network:`)
  - `ctx.storage` for caching (declared in `storage: gh-issues`)
  - `ctx.now()` for cache-freshness checks

Runs in a capability-constrained context: no fs / process / DOM /
runtime-internals access. See `docs/architecture/user-blanks.md`
for the full author guide.
