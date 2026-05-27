---
name: tips-opencode
# Tip pack scoped to the OpenCode integration. The folder-loader's
# host-compat filter (packages/opencues-core/src/discover.ts:isAllowedOnHost)
# skips this entire folder on every other host so the trigger words
# below never collide with vocabulary in claude-code / gemini-cli /
# shell / chrome.
#
# To add OpenCode-specific tips, append a group to the JSON array
# below. Shape per group:
#   { "id": "<kebab-id>", "words": { "<trigger>": { "tip": "...", "alts": [...] } } }
# Tips render via the active host's tip surface (footer / statusline);
# `tips-mode: off` in OPENCUES.md hides every pack uniformly.
on-host: [opencode]
---

```json
[]
```
