---
last_updated: 2026-04-02
---

# Auto-Submit Trigger

Analysis fires automatically as the user types. Three tiers:

| Tier | Trigger | Debounce | Purpose |
|------|---------|----------|---------|
| 1 | Space typed (word count increases) | 50ms + stability check | Analyse just-completed word |
| 2 | No typing for 300ms | 300ms + stability check | Analyse final word (no trailing space) |
| 3 | Word edited mid-sentence (same count) | 50ms + stability check | Re-analyse changed word |

Each tier includes a **stability check** — the debounce timer fires, then the system verifies the text hasn't changed since the timer was set. This prevents false triggers from rapid typing.

**Optimisations:**
- **Targeted indices**: after first full analysis, only words lacking alts are sent to the LLM
- **Duplicate prevention**: a pending flag prevents overlapping LLM requests
- **Tips first**: instant tips lookup runs before LLM, merging results immediately
- **Skip if complete**: if all words have alts (from tips or previous LLM), skip LLM entirely
