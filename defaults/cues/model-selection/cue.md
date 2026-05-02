---
name: model-selection
---

```json
{
  "opus": {
    "tip": "Use Opus for complex architecture - best reasoning, higher cost",
    "alts": [
      "sonnet",
      "haiku",
      "/model"
    ]
  },
  "sonnet": {
    "tip": "Use Sonnet for routine coding - good balance of speed/quality",
    "alts": [
      "opus",
      "haiku",
      "/model"
    ]
  },
  "haiku": {
    "tip": "Use Haiku for simple tasks - 3x cheaper than Sonnet",
    "alts": [
      "opus",
      "sonnet",
      "/model"
    ]
  },
  "/model": {
    "tip": "Use /model command to switch models mid-session",
    "alts": [
      "opus",
      "sonnet",
      "haiku"
    ]
  }
}
```
