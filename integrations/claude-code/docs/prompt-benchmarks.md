---
last_updated: 2026-03-31
---

# Prompt Benchmarks

Benchmarks and optimization notes for the LLM prompts used in dynamic highlight.

## Current Setup

- **Model**: GPT-OSS-120b via Groq API
- **Mode**: `reasoning_effort: 'low'`
- **Architecture**: Classifier → Mode-specific prompt
- **Prompts**: Now embedded in `cues-core/src/prompts.ts`

## Prompt Sizes

| Prompt | Purpose | Lines | Characters |
|--------|---------|-------|------------|
| Classifier | Detect MATH/FACTUAL/GRAMMAR | 41 | ~1,600 |
| Math | Arithmetic expressions | 38 | ~1,600 |
| Factual | Facts, trivia, knowledge | 44 | ~1,900 |
| Grammar | Word alternatives (no blanks) | 150 | ~6,400 |
| Blank Grammar | Fill-in-the-blank | 63 | ~3,000 |

## Speed Benchmarks

Tested with GPT-OSS-120b via Groq:

| Component | Average Latency |
|-----------|-----------------|
| Classifier | ~280ms |
| Math | ~390ms |
| Factual | ~330ms |
| Grammar | ~775ms |

### Total Latency (with Classifier)

For inputs with blanks (`_`), classifier runs first:

| Mode | Classifier | Prompt | **Total** |
|------|------------|--------|-----------|
| MATH | 280ms | 390ms | **~670ms** |
| FACTUAL | 280ms | 330ms | **~610ms** |
| GRAMMAR | 280ms | 775ms | **~1050ms** |

Inputs without blanks skip classifier → ~400ms (Grammar only).

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
    │ Grammar │ (~400ms)
    │ Prompt  │
    └────┬────┘
         │
         ▼
    Output: 1:big,small,brown,happy,loud
```

## Why Grammar is Slowest

The grammar prompt (150 lines, ~6.4KB) includes:
- Adjective/adverb/verb/noun examples
- Proper noun categories (companies, universities, sports teams)
- Job title categories (CEO, manager, doctor)
- Blank-filling rules (position-aware)

## Key Optimization Learnings

### 1. Output Tokens Dominate Latency

Input tokens have minimal impact. The linked prompt (320 lines, 18KB) is similar speed to grammar because output is small.

### 2. Variance Matters More Than Averages

Early benchmarks showed a minimal prompt averaging 7.1 alternatives. But individual runs varied 0-3. A slightly larger prompt with explicit guidance produced consistent 3-5 alternatives every time.

**Lesson:** Always test variance, not just averages.

### 3. Explicit Guidance Improves Consistency

Adding "Find alternatives for nouns, verbs, adjectives, pronouns" constrains the model to produce predictable output.

### 4. Abbreviated Keys Work

Using `i`, `w`, `a` instead of `index`, `word`, `alts` saves tokens without reducing quality.

### 5. "Return JSON" is Critical

Prompts without explicit format instructions fail ~40% of the time.

## Blank Position Detection

The grammar prompt handles different blank positions:

| Position | Example | Alternatives |
|----------|---------|--------------|
| Start | `_ dog barked` | The, A, My, That (determiners) |
| After determiner | `The _ dog` | big, small, brown (adjectives) |
| Before verb | `The _ ran` | dog, boy, man (nouns) |
| Verb position | `He _ loudly` | shouted, ran, walked (verbs) |

## API Response Handling

With `reasoning_effort: 'low'`, check both fields:

```javascript
content = (resp.choices[0].message.content || resp.choices[0].message.reasoning || '').trim();
```

## Potential Improvements

1. **Trim proper nouns** — Remove rarely-used categories (~30% size reduction)
2. **Cache classifier** — Same text doesn't need re-classification
3. **Connection warmup** — Pre-establish keep-alive connection

---

## Historical: Gemini Benchmarks (February 2026)

Before switching to Groq, prompts were tested on Gemini models:

| Model | Latency | Notes |
|-------|---------|-------|
| gemini-2.5-flash-lite | 0.79s | Fastest Gemini |
| gemini-2.0-flash | 1.34s | 70% slower |
| gemini-2.0-flash-lite | 1.79s | 126% slower |

Groq GPT-OSS-120b (~400ms) is now 2x faster than the fastest Gemini option.

### Prompt Version Comparison (Historical)

| Version | Tokens | Alts | Reliability | Notes |
|---------|--------|------|-------------|-------|
| v1-original | 160 | 2.2 | 100% | Too verbose |
| v3-minimal | 60 | 7.1 | 100% | High variance |
| v5-terse | 43 | 8.3 | 43% | Too compressed |
| v6-balanced | 96 | 5.5 | 100% | **Winner** |

**Key finding:** The most verbose prompt produced the fewest alternatives. Detailed examples constrain output too closely.
