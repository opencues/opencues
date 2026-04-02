---
last_updated: 2026-04-02
---

# Linked Words

Words that must change together when any one of them cycles.

- `linked` array on each word definition contains indices of co-dependent words
- All linked words cycle to the same `currentAltIndex`
- When the user cycles a word, all its linked words update simultaneously

**LLM-detected links:**
The linked words prompt detects semantic relationships:
- Gender agreement: "The boy loves his dog" → boy↔his
- Number agreement: "The cats chase their toys" → cats↔their↔toys
- Verb agreement: "She runs" → she↔runs
- Possession: "John loves his car" → John↔his
