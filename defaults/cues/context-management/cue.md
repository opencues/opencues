---
name: context-management
---

```json
{
  "/compact": {
    "tip": "Summarize history when 'context limit' warning appears",
    "alts": [
      "/clear",
      "/rewind"
    ]
  },
  "/clear": {
    "tip": "Fresh start - clears context but keeps CLAUDE.md",
    "alts": [
      "/compact",
      "/rewind"
    ]
  },
  "/rewind": {
    "tip": "Undo everything - rolls back context AND file changes",
    "alts": [
      "/compact",
      "/clear",
      "Esc x2"
    ]
  },
  "Esc x2": {
    "tip": "Double-tap Escape for quick /rewind (rolls back context + files)",
    "alts": [
      "/rewind",
      "/compact",
      "/clear"
    ]
  },
  "undo": {
    "tip": "Use /rewind (Esc x2) to undo - rolls back context AND file changes",
    "alts": [
      "/rewind",
      "revert",
      "rollback"
    ]
  },
  "revert": {
    "tip": "Use /rewind to revert - rolls back context AND file changes",
    "alts": [
      "/rewind",
      "undo",
      "rollback"
    ]
  },
  "rollback": {
    "tip": "Use /rewind to rollback - rolls back context AND file changes",
    "alts": [
      "/rewind",
      "undo",
      "revert"
    ]
  },
  "context": {
    "tip": "Manage context: /compact (summarize), /clear (fresh), /rewind (undo all)",
    "alts": [
      "/compact",
      "/clear",
      "/rewind"
    ]
  }
}
```
