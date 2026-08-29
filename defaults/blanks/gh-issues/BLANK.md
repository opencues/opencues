---
name: gh-issues
type: blank
tip: open issue count for a github repo
blankKeywords: gh-issues
blankAutoPopulate: true
blankReadOnly: true
impl: ./blank.js
network: [api.github.com]
storage: gh-issues
# Clearing is SHAPE-DERIVED (the blankReplace dial was deleted, June 2026):
# a captured arg consumes the command span — "gh-issues opencues/opencues _"
# → "opencues/opencues: 42 open" (repo embedded).
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
