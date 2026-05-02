---
name: debugging
---

```json
{
  "bug": {
    "tip": "Use /rewind (Esc x2) to roll back context AND code",
    "alts": [
      "debug",
      "fix",
      "broken",
      "/rewind"
    ]
  },
  "debug": {
    "tip": "Check git changes, use /rewind if stuck",
    "alts": [
      "bug",
      "fix",
      "broken",
      "/rewind"
    ]
  },
  "fix": {
    "tip": "Stuck on a fix? /rewind rolls back code AND context",
    "alts": [
      "bug",
      "debug",
      "broken",
      "/rewind"
    ]
  },
  "broken": {
    "tip": "Broken code? /rewind (Esc x2) to roll back everything",
    "alts": [
      "bug",
      "debug",
      "fix",
      "/rewind"
    ]
  },
  "stack trace": {
    "tip": "Provide complete error messages and full stack traces",
    "alts": [
      "error message",
      "full error"
    ]
  }
}
```
