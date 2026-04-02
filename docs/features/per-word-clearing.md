---
last_updated: 2026-04-02
---

# Per-Word Clearing

When the user edits text, alternatives are preserved intelligently rather than discarding everything.

**Rules:**

| Edit | What happens |
|------|-------------|
| Word changes to something IN alternatives | Update `currentAltIndex` (valid cycle) |
| Word changes to something NOT in alternatives | Word becomes non-navigable, but alternatives preserved |
| Word count changes (add/remove word) | Clear affected positions, auto-submit re-analyses |
| Word typed back to original | Alts restored (they were never deleted) |

**Typing recovery:** "dog" → "do" → "dog" — during "do", the word is not navigable (not in alternatives), but the alternatives array `["dog", "cat", "puppy"]` is preserved. When the user types "g" to make "dog" again, it matches alternatives and becomes navigable immediately.

**Why this matters:** Without per-word clearing, every keystroke would discard all LLM results (~400ms to regenerate). With it, only changed words need fresh analysis.


