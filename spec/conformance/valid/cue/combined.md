---
name: concise
description: A situation catalogue for wordy drafts + an LLM prompt body for the matched words
match: utilize|leverage|facilitate|aforementioned|hereto
priority: 70
spec: opencues/0.1-alpha
---

```json
[{
  "id": "concise-overrides",
  "words": {
    "utilize": { "tip": "Prefer the plain verb", "when": "reaches for a long word where a short one does the job", "say": "Wordy? Say use, apply or employ" }
  }
}]
```

For the matched terms, suggest 3 alternatives that preserve meaning.

Format: INDEX:alt1,alt2,alt3
