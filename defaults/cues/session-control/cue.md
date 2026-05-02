---
name: session-control
---

```json
{
  "Ctrl+Z": {
    "tip": "Press Ctrl+Z to suspend, fg to resume - don't restart",
    "alts": [
      "suspend",
      "resume",
      "pause"
    ]
  },
  "suspend": {
    "tip": "Ctrl+Z suspends Claude, fg resumes - context preserved",
    "alts": [
      "Ctrl+Z",
      "resume",
      "pause"
    ]
  },
  "resume": {
    "tip": "Use --resume to continue a named session",
    "alts": [
      "Ctrl+Z",
      "suspend",
      "/rename"
    ]
  },
  "/rename": {
    "tip": "Use /rename for memorable sessions, --resume to continue",
    "alts": [
      "resume",
      "session"
    ]
  },
  "pause": {
    "tip": "Ctrl+Z pauses, fg resumes - don't restart and lose context",
    "alts": [
      "Ctrl+Z",
      "suspend",
      "resume"
    ]
  }
}
```
