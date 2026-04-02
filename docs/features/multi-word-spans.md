---
last_updated: 2026-04-02
---

# Multi-Word Spans

An alternative can be multiple words (e.g., `_` → "Sundar Pichai", "toy" → "stuffed animal").

**The problem:** The system uses word indices for tracking. Replacing one word with two shifts all subsequent indices.

**The solution:** Span tracking maps each word of the replacement back to the original index:

```
Before: "The CEO of Google is _"         (indices 0-5)
After:  "The CEO of Google is Sundar Pichai"  (indices 0-6)

Span map: { 5: {originalIndex: 5, spanLength: 2},
            6: {originalIndex: 5, spanLength: 2} }
```

**Behaviour:**
- All span words cycle as a unit (cycling "Pichai" cycles "Sundar Pichai")
- Navigation to any span word redirects to the original index
- Non-original span positions are skipped during navigation
- Dimming and highlighting apply to all words in the span
- Re-analysis protects span words from getting individual alternatives
- Cycling back to a single word clears the span tracking


