---
name: tips-shell
# Tip pack scoped to the shell integration (`oc-shell` slide-pane input
# box). The folder-loader's host-compat filter skips this folder on
# every other host. Shell users compose prompts FOR another CLI, so the
# most useful tips are about composing — see the default seed below.
on-host: [shell]
---

```json
[
  {
    "id": "prompt-composing",
    "words": {
      "improve prompt": {
        "tip": "Type your rough draft then `improve prompt _` — the runtime rewrites it inline before you submit",
        "alts": ["enhance prompt", "refine prompt"]
      },
      "enhance prompt": {
        "tip": "Same as `improve prompt _` — rewrites your draft into a structured prompt",
        "alts": ["improve prompt", "refine prompt"]
      },
      "refine prompt": {
        "tip": "Same as `improve prompt _` — rewrites your draft into a structured prompt",
        "alts": ["improve prompt", "enhance prompt"]
      }
    }
  }
]
```
