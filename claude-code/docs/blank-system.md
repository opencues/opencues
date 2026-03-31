---
last_updated: 2026-03-31
---

# Blank Fill-in System

This document covers the underscore (`_`) fill-in-the-blank system.

## Overview

Type `_` as a placeholder in your text, and the LLM fills it with contextually appropriate words.

The system **auto-detects context** via LLM classifier:

| Context Type | Example | Alternatives |
|--------------|---------|--------------|
| **Grammar** | "The _ dog barked" | big, small, brown, happy, loud |
| **Factual** | "The CEO of Google is _" | Sundar Pichai |
| **Math** | "2 + 2 = _" | 4 |

## Architecture

```
Input: "The _ dog barked"
         │
         ▼
    Has blank (_)?
         │
        Yes
         │
         ▼
┌─────────────────────────┐
│   LLM CLASSIFIER        │  (~280ms)
│   "MATH, FACTUAL, or    │
│    GRAMMAR?"            │
└───────────┬─────────────┘
            │
    ┌───────┼───────┐
    ▼       ▼       ▼
  MATH   FACTUAL  GRAMMAR
    │       │       │
    ▼       ▼       ▼
math.txt factual.txt blank_grammar.txt
    │       │       │
    ▼       ▼       ▼
COMPUTE=  ANSWER=  INDEX:word1,word2,...
```

## Mode Detection

The classifier uses GPT-OSS-120b with a simple prompt:
```
Is "The _ dog barked" asking for MATH (calculation), FACTUAL (facts/trivia), or GRAMMAR (word fill)? Answer:
```

### Total Latency

| Mode | Classifier | Prompt | Total |
|------|------------|--------|-------|
| MATH | 280ms | 390ms | **~670ms** |
| FACTUAL | 280ms | 330ms | **~610ms** |
| GRAMMAR | 280ms | 775ms | **~1050ms** |

## Grammar Blank Filling

The `blank_grammar.txt` prompt uses grammatical rules to determine the correct word type.

### Key Principle

Look at BOTH sides of the blank to determine what word type is needed:

| What's AFTER blank | What's BEFORE blank | Blank needs |
|-------------------|---------------------|-------------|
| Verb (ran, walked) | Determiner (The) | **NOUN** (subject) |
| Noun (dog, team) | Determiner (The) | **ADJECTIVE** |
| Noun/Adjective | Nothing (start) | **DETERMINER** |
| Adverb (quickly) | Subject | **VERB** |

### Examples

| Input | Rule Applied | Alternatives |
|-------|--------------|--------------|
| "The _ dog barked" | Det + blank + noun → adj | big, small, brown, happy |
| "The _ ran quickly" | Det + blank + verb → noun | dog, boy, girl, athlete |
| "_ dog barked" | Start + noun → det | The, A, My, That |
| "She _ quickly" | Subject + blank + adv → verb | ran, walked, moved |

### Why Separate Prompts?

We use `blank_grammar.txt` (not `grammar.txt`) for blanks because:

1. **Different goals**: Word alternatives vs blank filling
2. **Different word types**: Alternatives stay same type; blanks need different types
3. **Context handling**: Blanks need full sentence context (don't skip "The")
4. **Accuracy**: Focused prompt achieves 14/14 on edge cases

### Important Processing Logic

When there's a blank, cues-core:
1. **Keeps all words** in the indexed input (doesn't skip "the", "a", etc.)
2. **Keeps `_` as-is** (doesn't convert to "BLANK")
3. **Uses `blank_grammar.txt`** instead of `grammar.txt`
4. **Classifies** via `looksLikeMath`/`looksLikeFactual` (no external classifier call needed for obvious cases)

> **HISTORICAL NOTE**: Before the cues-core migration, this logic lived in `llm-analyze-auto.sh` as bash script processing. It is now handled inline by cues-core's CueResolver.

## Benchmark Results

### Grammar Blank Accuracy: 14/14 (100%)

| Test Case | Expected | Result |
|-----------|----------|--------|
| The _ dog barked | adjectives | big, small, brown ✅ |
| The _ team won | adjectives | strong, local, national ✅ |
| The _ software failed | adjectives | new, old, buggy ✅ |
| The _ ran quickly | nouns | dog, boy, girl ✅ |
| The _ walked slowly | nouns | man, woman, dog ✅ |
| The _ crashed | nouns | server, computer, car ✅ |
| _ dog barked | determiners | The, A, My ✅ |
| _ computer crashed | determiners | The, My, That ✅ |
| _ quick fox jumped | determiners | The, A, My ✅ |
| He _ her softly | verbs | kissed, hugged, touched ✅ |
| They _ us badly | verbs | defeated, beat, helped ✅ |
| She _ quickly | verbs | ran, walked, spoke ✅ |

### No Regression on Other Benchmarks

| Benchmark | Before | After | Status |
|-----------|--------|-------|--------|
| Math | 53/53 | 53/53 | ✅ Same |
| Math Edge | 56/56 | 56/56 | ✅ Same |
| Factual | 47/51 | 47/51 | ✅ Same |
| Word | 43/48 | 47/48 | ✅ Better |
| Word Edge | 36/47 | 38/47 | ✅ Better |

## Multi-Word Alternatives

Factual answers are often multi-word (e.g., "Sundar Pichai"). These are tracked as "spans":

```javascript
globalThis._dynSpans = {
  5: { originalIndex: 5, spanLength: 2 },  // "Sundar"
  6: { originalIndex: 5, spanLength: 2 }   // "Pichai"
}
```

See `docs/span-system.md` for full details.

## Files

| File | Purpose |
|------|---------|
| `system_prompts/blank_grammar.txt` | Grammar blank filling prompt |
| `system_prompts/math.txt` | Math computation prompt |
| `system_prompts/factual.txt` | Factual answer prompt |
| `~/.claude/node_modules/cues-core/` | CueResolver handles classification and LLM calls |

## Related Documentation

- `system_prompts/README.md` → All prompts overview
- `docs/system-prompt-benchmark.md` → Latency benchmarks
- `docs/span-system.md` → Multi-word span tracking
- `docs/per-word-clearing.md` → How alternatives are preserved
