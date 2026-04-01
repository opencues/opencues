---
last_updated: 2026-04-01
---

# Alternatives — Claude Code Implementation

Implements features 6, 7, 8, 12 from `docs/features.md`: Tips, LLM Alternatives, Fill-in-the-Blank, Auto-Submit Trigger.

**Patch file:** `patches/dynamicHighlight.ts`

## Auto-Submit Trigger

Analysis fires automatically as the user types. Three tiers:

| Tier | Trigger | Debounce | Purpose |
|------|---------|----------|---------|
| 1 | Space typed (word count increases) | 50ms + stability check | Analyse just-completed word |
| 2 | No typing for 300ms | 300ms + stability check | Analyse final word (no trailing space) |
| 3 | Word edited (same word count) | 50ms + stability check | Re-analyse after mid-sentence edit |

**Flow:**
1. Trigger fires → tips lookup runs first (instant, ~0ms)
2. Words with tips get alts immediately
3. Remaining words (without tips or existing alts) become `targetIndices`
4. If `targetIndices` is empty → skip LLM entirely
5. Otherwise → CueResolver call with targeted indices (~400ms)
6. Results merge into existing `_dynDefs` → force UI refresh

**Optimisations:**
- `_dynPending` flag prevents overlapping LLM requests
- `_dynLastAnalyzed` tracks what was sent to avoid duplicate submissions
- Tips results merge immediately (don't wait for LLM)

## Tips Lookup

Words matching `~/.claude/claude-code-tips.json` get instant alternatives without LLM.

- Hash map built at startup (`globalThis._tipsMap`) — O(1) per lookup
- Runs before every LLM call
- Words in the same sentence can have different sources: "quick" → grammar LLM, "ultrathink" → tips
- Each word gets a `tip` string and `altTips` (per-alternative tips)

**Per-word tips update when cycling:**
- Navigate to "ultrathink" → tip: "Add 'ultrathink' to prompt..."
- Cycle to "Tab" → tip: "Press Tab to toggle extended thinking..."

**Two structures supported:**

`words` (per-word tips):
```json
{
  "id": "context-management",
  "words": {
    "/compact": { "tip": "Summarize history...", "alts": ["/clear", "/rewind"] }
  }
}
```

`groups` (synonym groups — alts point to OTHER concepts):
```json
{
  "id": "parallel-execution",
  "groups": [{
    "synonyms": ["agents", "sub-agents", "spawn"],
    "tip": "Spawn parallel workers...",
    "alts": ["swarm", "background"]
  }]
}
```

Groups are checked first, then words.

## LLM Sources

All LLM calls go through cues-core's `CueResolver`:

| Source | Priority | When | Output |
|--------|----------|------|--------|
| Tips | 100 | Always (instant) | Direct alternatives |
| MathSource | 90 | Input has `_` + looks like math | `COMPUTE=expression` → eval |
| FactualSource | 90 | Input has `_` + looks like factual | `ANSWER=value` |
| GrammarSource | 50 | Always (fallback) | `INDEX:alt1,alt2,alt3` |

Higher priority wins when sources conflict. Same-priority results merge.

**CueResolver initialisation** (IIFE injected at startup in cli.js):
- Loads cues-core module
- Parses tips file → builds hash map
- Creates NodeHttpAdapter (HTTPS keep-alive, Groq provider config)
- Creates CueResolver with all sources
- Stores in `globalThis._cueResolver`

**Default provider:** GPT-OSS-120b via Groq (~400ms avg). See `/docs/llm-providers.md` for alternatives.

## Fill-in-the-Blank

Type `_` (underscore) as a placeholder. The system classifies and fills it:

| Type | Detection | Example | Source |
|------|-----------|---------|--------|
| Math | `looksLikeMath()` — operators, percentages, math keywords | `4 * 12 = _` → 48 | MathSource |
| Factual | `looksLikeFactual()` — "X of Y is", who/what/when patterns | `Capital of France is _` → Paris | FactualSource |
| Grammar | Default | `The _ dog barked` → big, small, brown | GrammarSource |

**Blank grammar rules** (determines word type from position):

| After blank | Before blank | Blank needs |
|-------------|-------------|-------------|
| Noun (dog) | Determiner (The) | ADJECTIVE |
| Verb (ran) | Determiner (The) | NOUN (subject) |
| Noun/Adj | Start of sentence | DETERMINER |
| Adverb (quickly) | Subject | VERB |

**Context invalidation:** Changing words around a blank clears its cached alts and triggers re-analysis. Cycling the blank itself does not invalidate.

**Underscore queuing:** If context changes while an LLM request is pending, re-analysis is queued and fires when the current request completes.

## Performance

**CueResolver (current, words-first prompt):**

| Metric | Value |
|--------|-------|
| avg | 471ms |
| p50 | 405ms |
| p90 | 708ms |
| min | 287ms |

**Tips lookup:** ~0-1ms (hash map, no network)

## Debugging

```bash
tail -f /tmp/claude-llm-timing-*.txt /tmp/claude-auto-debug-*.txt
```

## Config

```json
{
  "misc": {
    "enableDynamicHighlight": true,
    "dynamicHighlightDebounceMs": 0
  }
}
```

Requires `enableWordHighlight: true` (master switch).

## Related

- `navigation.md` — how to navigate to words
- `cycling.md` — how Up/Down modifies words
- `status-line.md` — tip display in status bar
- `/docs/llm-providers.md` — provider config and benchmarks
