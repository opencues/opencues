---
last_updated: 2026-03-31
---

# FACTUAL Mode System Prompt

## Overview

The FACTUAL prompt instructs the LLM to answer knowledge-based questions directly, rather than suggesting word alternatives. This mode handles questions about people, places, dates, and scientific facts.

## Prompt Location

Defined in `blanks.md` → `## Prompt` → `### factual`

## Key Design Principles

### 1. Direct Answer Output

```
Output ONLY: ANSWER=answer
```

**Why:** Without this instruction, the LLM might return synonyms or word alternatives instead of the actual factual answer.

### 2. Categorized Examples (31 total)

The prompt organizes examples by category to help the LLM understand different question types:

| Category | Count | Example |
|----------|-------|---------|
| **People** | 10 | CEO, founder, inventor, author, composer, painter, sculptor, architect |
| **Places** | 6 | Capitals, oceans, mountains, rivers, deserts, continents |
| **Dates/Years** | 7 | Wars, events, releases, collapses, inventions |
| **Science** | 8 | Chemical symbols, atomic numbers, temperatures, astronomy |

### 3. Pattern Coverage

Each category covers the specific phrasing patterns we detect:

**People patterns:**
- "The CEO of X is _"
- "The founder of X is _"
- "The inventor of X is _"
- "The author of X is _"
- "The painter of X is _"
- "The sculptor of X is _"
- "The architect of X is _"

**Date patterns:**
- "X ended in _"
- "X started in _"
- "X fell in _"
- "X collapsed in _"
- "X was released in _"
- "X became queen in _"

**Science patterns:**
- "The chemical symbol for X is _"
- "The atomic number of X is _"
- "Water boils at _ degrees"
- "The speed of light is approximately _"

## Detection Triggers

These patterns are checked via the `match` and `keywords` fields in blanks.md `### factual`:

```bash
# Title patterns
CEO of|capital of|president of|founder of|author of|inventor of|
creator of|director of|composer of|painter of|sculptor of|architect of

# Action patterns
invented|discovered|born in|died in|directed by|written by|
composed by|painted by

# Superlatives
largest|smallest|tallest|longest|oldest|youngest|closest|nearest|
first|last|highest|lowest

# Event patterns
ended in|started in|began in|founded in|fell in|collapsed in|
sank in|released in|held in|became

# Science patterns
chemical symbol|atomic number|speed of|boils at|freezes at|melts at

# Question words
^Who|What|Where|When|Which|How many|How much
```

## Benchmark Results

**100 tests, 98% accuracy, ~230ms average latency**

| Category | Passed | Total |
|----------|--------|-------|
| Companies/Leaders | 20 | 20 |
| World Capitals | 19 | 20 |
| Science Facts | 20 | 20 |
| Historical Events | 20 | 20 |
| Arts/Literature | 19 | 20 |

The 2 "failures" are accent mismatches (Brasília, Dalí), not actual errors.

## Why Categorized Examples Work

1. **Pattern recognition** - LLM sees "The X of Y is BLANK" across multiple domains
2. **Answer format** - Learns to return concise answers, not explanations
3. **Coverage** - Each category primes the model for that type of question
4. **Consistency** - Same format across all categories

## Comparison: Without vs With Prompt

**Without FACTUAL prompt (falls to GRAMMAR mode):**
```
Input: "The CEO of Apple is _"
Output: 1:executive,leader,boss|4:company,corporation|6:great,excellent
```
Returns word alternatives, not the answer.

**With FACTUAL prompt:**
```
Input: "The CEO of Apple is _"
Output: ANSWER=Tim Cook
```
Returns the actual factual answer.

## Adding New Categories

To add support for new question types:

1. Add detection keywords/match patterns to the `### factual` yaml block in `blanks.md`

2. Add examples to the `### factual` prompt text in `blanks.md`:
   ```
   New Category:
   - Example question BLANK → ANSWER=example answer
   ```

3. Test with representative questions
