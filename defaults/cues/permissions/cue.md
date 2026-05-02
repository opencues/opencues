---
name: permissions
---

```json
{
  "permission": {
    "tip": "Use allowedTools config instead of --dangerously-skip-permissions",
    "alts": [
      "allow",
      "dangerous",
      "skip"
    ]
  },
  "allow": {
    "tip": "Configure allowedTools in settings for safe auto-approval",
    "alts": [
      "permission",
      "dangerous",
      "skip"
    ]
  },
  "dangerous": {
    "tip": "Prefer allowedTools config over --dangerously-skip-permissions",
    "alts": [
      "permission",
      "allow",
      "skip"
    ]
  },
  "skip": {
    "tip": "Use allowedTools config for persistent permissions",
    "alts": [
      "permission",
      "allow",
      "dangerous"
    ]
  }
}
```
