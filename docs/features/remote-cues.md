---
last_updated: 2026-04-02
---

# Remote Cues

Alternatives computed externally utilising an LLM or other system (~200-500ms). For words not covered by local cues, remote cue sources generate alternatives.

**Sources (by priority):**

| Source | Priority | When | What it does |
|--------|----------|------|-------------|
| Local cues | 100 | Always (instant) | Local lookup from cue source file |
| Math | 90 | Input has blank + looks like math | Extracts expression, evaluates locally |
| Factual | 90 | Input has blank + looks like factual | Returns factual answer |
| Grammar | 50 | Always (fallback) | Synonym, opposite, creative alternative |

**Priority resolution:** Higher priority wins. If local and grammar both provide alternatives for the same word, local wins. Same-priority results merge (deduplicated).

**Grammar alternatives:** For each word, the LLM provides three types — a synonym, an opposite, and a creative alternative. Proper nouns get similar entities (Google → Microsoft, Apple, Amazon).

**Targeted optimisation:** After the first full analysis, subsequent triggers only send words that don't already have valid alternatives — reducing remote calls and latency.
