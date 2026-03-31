---
last_updated: 2026-02-17
---

# CLASSIFIER Mode System Prompt

## Overview

The CLASSIFIER prompt determines which mode (MATH, FACTUAL, or GRAMMAR) should be used to process a given input. This replaces regex-based detection with intelligent classification.

## Prompt File

`../classifier.txt`

## Key Design Principles

### 1. Clear Mode Definitions

Each mode has explicit criteria:

| Mode | Criteria | Examples |
|------|----------|----------|
| **MATH** | Calculations, operators, percentages, word math | `7 * 8 = _`, `half of 200`, `15% of 300` |
| **FACTUAL** | Facts, names, dates, knowledge questions | `CEO of Apple`, `capital of France`, `Who invented` |
| **GRAMMAR** | Word alternatives, sentence completion | `The _ dog barked`, `She walked _ to school` |

### 2. Example-Based Learning

The prompt includes 8 examples per mode (24 total) covering:

**MATH examples:**
- Arithmetic: `4 * 12 = _`
- Word math: `half of 16 = _`
- Percentages: `50 plus 20% tax = _`
- Statistics: `average of 80, 90, 100 = _`
- Conversions: `celsius to fahrenheit 100C = _`

**FACTUAL examples:**
- People: `The CEO of Apple is _`
- Places: `The capital of France is _`
- Dates: `World War 2 ended in _`
- Science: `The chemical symbol for gold is _`

**GRAMMAR examples:**
- Verb blanks: `The nervous boy _ quickly`
- Adjective blanks: `The _ dog barked loudly`
- Adverb blanks: `She walked _ to school`

### 3. Simple Output Format

```
Output ONLY: MODE=MATH or MODE=FACTUAL or MODE=GRAMMAR
```

## API Configuration

```bash
curl -s "https://api.groq.com/openai/v1/chat/completions" \
    -H "Authorization: Bearer $GROQ_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "model": "openai/gpt-oss-120b",
        "reasoning_effort": "low",
        "max_tokens": 80,
        "temperature": 0.1,
        "messages": [{"role": "user", "content": "..."}]
    }'
```

**Critical settings:**
- `max_tokens: 80` - Must be high enough for reasoning + output
- `temperature: 0.1` - Low for consistent classification
- `reasoning_effort: "low"` - Required for GPT-OSS

**Note:** The mode may appear in either `content` or `reasoning` field. Check both:
```python
if "MODE=" in content:
    mode = extract(content)
elif "MODE=" in reasoning:
    mode = extract(reasoning)
```

## Benchmark Results

**45/45 (100%) on comprehensive test suite**

| Category | Pass | Total |
|----------|------|-------|
| MATH | 15 | 15 |
| FACTUAL | 15 | 15 |
| GRAMMAR | 15 | 15 |

### Test Cases

**MATH (correctly classified):**
- `7 * 8 = _` → MATH
- `half of 200 = _` → MATH
- `15% of 300 = _` → MATH
- `tip 20% on 50 = _` → MATH
- `5 factorial = _` → MATH
- `What is 2+2` → MATH
- `Calculate the sum of 5 and 7` → MATH
- `A train travels 120 miles in 2 hours, speed = _` → MATH

**FACTUAL (correctly classified):**
- `The CEO of Apple is _` → FACTUAL
- `The capital of France is _` → FACTUAL
- `World War 2 ended in _` → FACTUAL
- `Who invented the telephone` → FACTUAL
- `Where was Shakespeare born` → FACTUAL
- `The atomic number of oxygen is _` → FACTUAL

**GRAMMAR (correctly classified):**
- `The nervous boy _ quickly` → GRAMMAR
- `She walked _ to school` → GRAMMAR
- `The _ dog barked loudly` → GRAMMAR
- `The quick brown fox _ over the lazy dog` → GRAMMAR
- `Life is _` → GRAMMAR

### Edge Cases Handled

| Input | Classification | Reasoning |
|-------|----------------|-----------|
| `The 5 _ boys played soccer` | GRAMMAR | Number is context, not calculation |
| `Room 101 contains _` | GRAMMAR | Number is identifier, not math |
| `John has 5 apples and gives away 2` | MATH | Word problem requiring calculation |
| `The population of China is _` | FACTUAL | Asking for a specific fact |
| `I need _ more dollars` | GRAMMAR | Asking for word alternatives |

## Comparison: Classifier vs Regex

| Aspect | Regex Detection | Classifier |
|--------|-----------------|------------|
| Accuracy | ~85% | 100% |
| Edge cases | Often fails | Handles well |
| Maintenance | Update patterns | Update examples |
| Latency | ~0ms | ~170ms |
| Context awareness | None | Full |
| Scalability | Poor (exponential complexity) | Good (linear) |

**When to use classifier:**
- Ambiguous inputs
- Complex sentences
- When accuracy matters more than speed
- Systems with many modes or future expansion

**When to use regex:**
- Simple, clear patterns
- High-volume, latency-sensitive
- As a fast first-pass filter

## Scalability

The classifier scales well for future modes. Adding a new mode requires:

1. Add examples to `classifier.txt`:
```
NEWMODE - Description of when to use:
- "example input 1" → NEWMODE
- "example input 2" → NEWMODE
```

2. Create `newmode.txt` with mode-specific prompt

3. Create `references/newmode.md` with documentation

### Why Classifier Scales Better

| # Modes | Regex Complexity | Classifier Complexity |
|---------|------------------|----------------------|
| 3 | Manageable | 24 examples |
| 5 | Complex priority rules | 40 examples |
| 10 | Unmaintainable | 80 examples |
| 20 | Impossible | 160 examples |

With regex, each new mode requires handling overlaps with ALL existing modes. With classifier, just add examples for the new mode.

## Integration

```bash
# 1. Classify the input
MODE=$(classify "$INPUT")  # Returns MATH, FACTUAL, or GRAMMAR

# 2. Use mode-specific prompt
case "$MODE" in
    MATH)    PROMPT=$(cat system_prompts/math.txt) ;;
    FACTUAL) PROMPT=$(cat system_prompts/factual.txt) ;;
    GRAMMAR) PROMPT=$(cat system_prompts/grammar.txt) ;;
esac

# 3. Process with mode-specific prompt
RESULT=$(call_llm "${PROMPT/\{INPUT\}/$INPUT}")
```

## Latency

| Operation | Latency |
|-----------|---------|
| Classification | ~170ms |
| MATH processing | ~200ms |
| FACTUAL processing | ~230ms |
| GRAMMAR processing | ~250ms |
| **Total (worst case)** | **~420ms** |

### Benchmark Results

| Test | Latency |
|------|---------|
| `7 * 8 = _` | 157ms |
| `The CEO of Apple is _` | 154ms |
| `The nervous boy _ quickly` | 167ms |
| `half of 200 = _` | 186ms |
| `She walked _ to school` | 144ms |
| **Median** | **~167ms** |
| **Typical range** | **150-190ms** |

The classifier adds ~170ms overhead but significantly improves accuracy on ambiguous inputs and scales well for future modes.
