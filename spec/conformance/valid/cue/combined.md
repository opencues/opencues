---
name: concise
description: Curated overrides for common wordy phrases + LLM fallback for the long tail
match: utilize|leverage|facilitate|aforementioned|hereto
priority: 70
spec: opencues/0.1-alpha
---

```json
[{
  "id": "concise-overrides",
  "words": {
    "utilize": { "tip": "Prefer the plain verb", "alts": ["use", "apply", "employ"] }
  }
}]
```

For other matched terms, suggest 3 alternatives that preserve meaning.

Format: INDEX:alt1,alt2,alt3
