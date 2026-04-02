---
last_updated: 2026-04-02
---

# Tips System

Instant per-word alternatives and hints from a local JSON file. No LLM call needed (~0ms).

**How it works:**
1. At startup, tips file is parsed and a hash map is built — O(n) once
2. On each analysis trigger, tips lookup runs **first** — O(1) per word
3. Words with matches get instant alts + tip text (merged immediately, don't wait for LLM)
4. Non-matching words are sent to the LLM
5. Words in the same sentence can have different sources: "quick" → LLM grammar, "ultrathink" → tips

**Tips file supports two formats:**

Groups (synonyms share a tip, alts point to other concepts):
```json
{
  "id": "parallel-execution",
  "groups": [{
    "synonyms": ["agents", "sub-agents", "spawn"],
    "tip": "Spawn parallel workers via Task tool",
    "alts": ["swarm", "background"]
  }]
}
```

Words (individual entries):
```json
{
  "id": "extended-thinking",
  "words": {
    "ultrathink": {
      "tip": "Add 'ultrathink' for max reasoning",
      "alts": ["Tab", "deep thinking"]
    }
  }
}
```

**Per-alternative tips (`altTips`):**
When cycling from "agents" to "swarm", the tip updates to show swarm's tip. This is built at lookup time by cross-referencing other sections.

**Lookup priority:** Groups are checked first, then individual words (backward compatible).
