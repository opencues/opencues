---
last_updated: 2026-03-27
---

# System Prompt Benchmarks

Benchmarking the LLM system prompts for word analysis.

## Current Setup

- **Model**: GPT-OSS-120b via Groq API
- **Mode**: `reasoning_effort: 'low'`
- **Architecture**: Classifier → Mode-specific prompt

## Prompt Sizes

| Prompt | File | Lines | Characters | Purpose |
|--------|------|-------|------------|---------|
| **Classifier** | `classifier.txt` | 41 | 1,589 | Detect MATH/FACTUAL/GRAMMAR |
| **Math** | `blank_math.txt` | 38 | 1,626 | Arithmetic expressions |
| **Factual** | `blank_factual.txt` | 44 | 1,935 | Facts, trivia, knowledge |
| **Grammar** | `grammar.txt` | 150 | 6,418 | Word alternatives (no blanks) |
| **Blank Grammar** | `blank_grammar.txt` | 63 | 2,999 | Fill-in-the-blank |
| **Linked** | `linked.txt` | 320 | 18,146 | Concept linking |

## Speed Benchmarks

Tested February 2026, 3 runs each:

| Component | Run 1 | Run 2 | Run 3 | **Average** |
|-----------|-------|-------|-------|-------------|
| Classifier | 242ms | 317ms | 290ms | **~280ms** |
| Math | 416ms | 420ms | 328ms | **~390ms** |
| Factual | 330ms | 310ms | 362ms | **~330ms** |
| Grammar | 514ms | 922ms | 891ms | **~775ms** |
| Linked | 743ms | 763ms | 741ms | **~750ms** |

## Total Latency (with Classifier)

For inputs with blanks (`_`), the classifier runs first:

| Mode | Classifier | Prompt | **Total** |
|------|------------|--------|-----------|
| MATH | 280ms | 390ms | **~670ms** |
| FACTUAL | 280ms | 330ms | **~610ms** |
| GRAMMAR | 280ms | 775ms | **~1050ms** |

Inputs without blanks skip the classifier and use GRAMMAR mode directly (~775ms).

## Why Grammar is Slowest

The grammar prompt (150 lines, ~6.4KB) includes:
- Adjective/adverb/verb/noun examples
- **Proper noun categories** (companies, universities, sports teams, etc.)
- **Job title categories** (CEO, manager, doctor, etc.)
- Emotional words
- Blank-filling rules (start/mid-sentence/verb position)

The proper noun and job title sections add ~60 lines for entity flipping (Google→Microsoft, CEO→CFO).

## Why Linked is Large but Fast

The linked prompt (320 lines, 18KB) is huge but similar speed to grammar because:
- **Output tokens matter more than input** for latency
- Linked outputs are small (`LINKS: 1-3` vs full alt lists)
- GPT-OSS-120b handles large contexts efficiently

## Optimization Notes

### Token Efficiency
- Input tokens: ~1900 for grammar, ~4500 for linked
- Output tokens: ~100-200 (dominates latency)

### Variance
Grammar shows high variance (514ms to 922ms) likely due to:
- Variable output complexity
- Server-side load balancing

### Potential Improvements

1. **Trim proper nouns**: Remove rarely-used categories (~30% size reduction)
2. **Cache classifier**: Same text doesn't need re-classification
3. **Parallel warmup**: Pre-establish connection to reduce cold start

## Architecture Flow

```
Input: "The _ dog barked"
         │
         ▼
    ┌─────────┐
    │Classifier│ (~280ms)
    │ MATH?   │
    │ FACTUAL?│
    │ GRAMMAR?│
    └────┬────┘
         │ GRAMMAR
         ▼
    ┌─────────┐
    │ Grammar │ (~775ms)
    │ Prompt  │
    └────┬────┘
         │
         ▼
    Output: 1:big,small,brown,happy,loud
```

## Blank Position Detection

The grammar prompt now handles different blank positions:

| Position | Example | Alternatives |
|----------|---------|--------------|
| Start | `_ dog barked` | The, A, My, That, His (determiners) |
| After determiner | `The _ dog barked` | big, small, brown, happy, loud (adjectives) |
| Verb position | `He _ loudly` | shouted, whispered, ran, walked (verbs) |

Key instruction in prompt:
```
IMPORTANT: Check what comes BEFORE the blank to determine word type needed!
```

## API Response Handling

When using `reasoning_effort: 'low'`, responses may be in the `reasoning` field instead of `content`:

```javascript
// Check both fields
content = (resp.choices[0].message.content || resp.choices[0].message.reasoning || '').trim();
```

## Provider Comparison

| Provider | Model | Avg Latency | Notes |
|----------|-------|-------------|-------|
| **Groq** | GPT-OSS-120b | ~400-800ms | Current default |
| Cerebras | GPT-OSS-120b | ~450ms | Alternative |
