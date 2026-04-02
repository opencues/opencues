---
last_updated: 2026-04-02
---

# LLM Alternatives

For words not in the tips file, an LLM generates alternatives via cues-core's `CueResolver`.

**Sources (by priority):**

| Source | Priority | When | What it does |
|--------|----------|------|-------------|
| Tips | 100 | Always (instant) | Local lookup from JSON file |
| Math | 90 | Input has `_` + looks like math | Extracts expression, evaluates locally |
| Factual | 90 | Input has `_` + looks like factual | Returns factual answer |
| Grammar | 50 | Always (fallback) | Synonym, opposite, creative alternative |

**Priority resolution:** Higher priority wins. If tips and grammar both provide alts for the same word, tips wins. Same-priority results merge (deduplicated).

**Grammar alternatives:** For each word, the LLM provides three types — a synonym, an opposite, and a creative alternative. Proper nouns get similar entities (Google → Microsoft, Apple, Amazon).

**Targeted optimisation:** After the first full analysis, subsequent triggers only send words that don't already have valid alts — reducing LLM calls and latency.


