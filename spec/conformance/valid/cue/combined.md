---
name: legal
description: Curated overrides for high-risk legal terms + LLM fallback for the long tail
match: contract|agreement|clause|herein|whereas
priority: 70
spec: opencues/0.1-alpha
---

```json
[{
  "id": "legal-overrides",
  "words": {
    "herein": { "tip": "Avoid; replace with explicit reference", "alts": ["in this agreement", "above", "hereunder"] }
  }
}]
```

For other matched terms, suggest 3 alternatives that preserve legal meaning.

Format: INDEX:alt1,alt2,alt3
