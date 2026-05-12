---
name: gh-issues
type: blank
tip: open issue count for a github repo
blankKeywords: gh-issues
# Allow `owner/repo` between the keyword and `_`. Without this,
# `blankKeywords` must be immediately adjacent to `_` (proximity 0).
blankProximity: 2
blankAutoPopulate: true
blankReadOnly: true
impl: ./blank.js
network: [api.github.com]
storage: gh-issues
# Auto: bare "gh-issues opencues/opencues _" → wipe → "opencues/opencues: 42 open"
# (repo embedded). Copula phrasing → keep.
blankReplace: auto
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
