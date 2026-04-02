---
last_updated: 2026-04-02
---

# Local Cues

Alternatives computed locally on your machine, returning near-instantly (~0ms). A local cue source provides both alternatives (for cycling) and cue-tips (for the secondary display).

**How it works:**
1. At startup, the cue source file is parsed and a hash map is built — O(n) once
2. On each analysis trigger, local lookup runs **first** — O(1) per word
3. Words with matches get instant alternatives + cue-tips (merged immediately, don't wait for remote cues)
4. Non-matching words are sent to remote cue sources
5. Words in the same sentence can have different sources: "quick" → remote, "ultrathink" → local

**The cue source file supports two formats:**

Groups (synonyms share a cue-tip, alternatives point to other concepts):
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

**Per-alternative cue-tips:**
When cycling from "agents" to "swarm", the cue-tip updates to show swarm's tip. This is built at lookup time by cross-referencing other sections.

**Lookup priority:** Groups are checked first, then individual words.
