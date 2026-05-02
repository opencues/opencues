---
name: large-files
---

```json
{
  "large": {
    "tip": "Break large files into smaller ones - reduces context waste",
    "alts": [
      "huge",
      "split",
      "massive"
    ]
  },
  "huge": {
    "tip": "Split huge files into smaller modules to save context",
    "alts": [
      "large",
      "split",
      "massive"
    ]
  },
  "split": {
    "tip": "Split large files to reduce context usage",
    "alts": [
      "large",
      "huge",
      "massive"
    ]
  },
  "massive": {
    "tip": "Massive files waste context - break into smaller modules",
    "alts": [
      "large",
      "huge",
      "split"
    ]
  }
}
```
