---
last_updated: 2026-04-02
---

# Auto-Submit Trigger

Analysis fires automatically as the user types. Three tiers:

| Tier | Trigger | Debounce | Purpose |
|------|---------|----------|---------|
| 1 | Space typed (word count increases) | 50ms | Analyse just-completed word |
| 2 | No typing for 300ms | 300ms | Analyse final word (no trailing space) |
| 3 | Word edited mid-sentence (same count) | 50ms | Re-analyse changed word |

**Optimisations:**
- **Targeted indices**: after first full analysis, only words lacking alts are sent to the LLM
- **Duplicate prevention**: a pending flag prevents overlapping LLM requests
- **Tips first**: instant tips lookup runs before LLM, merging results immediately
- **Skip if complete**: if all words have alts (from tips or previous LLM), skip LLM entirely


