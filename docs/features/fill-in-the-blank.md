---
last_updated: 2026-04-02
---

# Fill-in-the-Blank

Typing `_` (underscore) creates a blank that the system fills contextually.

**Classification:** The system detects what kind of blank this is:
- **Math** — contains operators, percentages, math keywords (e.g., "4 * 12 = _")
- **Factual** — matches knowledge patterns like "the X of Y is _", "who/what/when"
- **Grammar** (default) — fill with grammatically correct word

**Blank position detection** (grammar mode):

| What's AFTER blank | What's BEFORE blank | Blank needs |
|-------------------|---------------------|-------------|
| Verb (ran, walked) | Determiner (The) | **NOUN** (subject) |
| Noun (dog, team) | Determiner (The) | **ADJECTIVE** |
| Noun/Adjective | Nothing (start) | **DETERMINER** |
| Adverb (quickly) | Subject | **VERB** |

Examples:
```
"The _ dog barked"  → big, small, brown, happy
"The _ ran quickly" → dog, boy, girl, athlete
"_ dog barked"      → The, A, My, That
"She _ quickly"     → ran, walked, moved
"4 * 12 = _"        → 48
"Capital of France is _" → Paris
```

**Context invalidation:** If words around the blank change (e.g., "CEO of Google" → "CEO of Microsoft"), cached alts are cleared and re-analysis triggers. Cycling the blank itself does NOT trigger invalidation.

**Queuing:** If context changes while an LLM request is already pending, re-analysis is queued and fires automatically when the current request completes. This prevents lost updates when the user types faster than the LLM responds.

**Separate prompts:** Blank filling uses a different prompt than regular word alternatives, because blanks need a different word TYPE than surrounding words (e.g., "The _ dog" needs an adjective), while regular alternatives stay the same type (e.g., "beautiful" → "gorgeous").
