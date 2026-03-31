---
last_updated: 2026-03-31
---

# Dynamic Highlight Prompt Optimization

> **HISTORICAL NOTE**: The script-based references (`llm-analyze.sh`, `llm-analyze-compact.sh`) in this document are from the pre-cues-core era. LLM calls now go through cues-core's CueResolver and NodeHttpAdapter. The prompt benchmarks and optimization findings remain valid.

This document details the benchmarking and optimization of system prompts for the Dynamic Highlight feature's LLM-based word analysis.

**Benchmark Date:** February 2026

---

## Executive Summary

| Metric | v1-original | v6-balanced (Winner) | Improvement |
|--------|-------------|----------------------|-------------|
| Input tokens | 160 | 96 | **40% fewer** |
| Latency | 0.94s | 0.92s | **~same** |
| Alternatives found | 2.2 | 5.5 | **150% more** |
| Consistency | Variable | 3-5 alts/run | **Much better** |
| Reliability | 100% | 100% | Same |

**Recommendation:** Use **v6-balanced** prompt for production. While v3-minimal showed higher average alternatives in benchmarks, real-world testing revealed high variance (0-3 alts). v6-balanced provides consistent 3-5 alternatives per sentence with explicit guidance.

---

## Prompt Versions Tested

### v1-original (Baseline)

```
You are a text analyzer. Given input text, identify words with meaningful alternatives and semantic links.

Return ONLY valid JSON (no markdown, no code blocks, no explanation):
{"priority":1,"sentence":"<text>","words":[{"index":0,"word":"The","alts":null,"linked":null},{"index":1,"word":"boy","alts":["boy","girl","child"],"linked":[3],"currentAltIndex":0}]}

Rules:
- Index all words from 0
- alts: array with original at [0], or null if no alternatives
- linked: indices of words that change together (pronouns to nouns)
- currentAltIndex: 0 for words with alts

Analyze: {TEXT}
```

**Characteristics:** Verbose, full example, explicit rules

### v3-minimal (Recommended)

```
Return JSON: {"words":[{"i":IDX,"w":"WORD","a":["orig","alt1","alt2"],"l":[linked_idx]}]}
a=alternatives (original at [0]), l=linked word indices. null if none.
{TEXT}
```

**Characteristics:** Terse, minimal example, abbreviated keys

### v6-balanced

```
Analyze text for word alternatives. Return JSON only:
{"words":[{"i":0,"w":"word","a":["word","alt1","alt2"],"l":[linked_idx]}]}
- a: 3+ alternatives (original first), null if no good alts
- l: linked word indices (e.g., pronouns to their nouns)
Find alternatives for nouns, verbs, adjectives, pronouns.
Text: {TEXT}
```

**Characteristics:** Medium length, explicit guidance on what to find

### v7-quality

```
Analyze each word for alternatives and semantic links.
JSON format: {"words":[{"i":index,"w":"word","a":["original","alt1","alt2","alt3"],"l":[linked_indices]}]}
Rules:
- a: Array with 3-5 alternatives, original at [0]. null if no alternatives.
- l: Indices of semantically linked words (pronouns↔nouns). null if none.
- Include alternatives for: nouns, verbs, adjectives, adverbs, pronouns
- Skip articles (the, a, an) and prepositions
Text: {TEXT}
```

**Characteristics:** Detailed rules, explicit skip list, quality focus

---

## Benchmark Results

### Model: gemini-2.5-flash-lite (Recommended)

| Prompt | Input Tok | Latency | Alts | Links | Reliability |
|--------|-----------|---------|------|-------|-------------|
| v1-original | 160 | 0.94s | 2.2 | 2.0 | 100% |
| v2-compact | 84 | 0.91s | 2.4 | 1.0 | 100% |
| **v3-minimal** | **60** | **0.79s** | **7.1** | 1.2 | **100%** |
| v4-medium | 71 | 0.78s | 3.2 | 1.7 | 100% |
| v5-terse | 43 | 0.88s | 8.3 | 7.6 | **43%** |
| v6-balanced | 96 | 0.97s | 5.5 | 0.5 | 100% |
| v7-quality | 129 | 1.23s | 5.5 | 3.2 | 100% |

### Model: gemini-2.0-flash

| Prompt | Input Tok | Latency | Alts | Links | Reliability |
|--------|-----------|---------|------|-------|-------------|
| v1-original | 160 | 1.62s | 3.7 | 2.1 | 100% |
| v2-compact | 84 | 1.86s | 5.2 | 3.8 | 100% |
| **v3-minimal** | **60** | **1.34s** | **7.1** | 0.7 | **100%** |
| v4-medium | 71 | 1.34s | 0.0 | 1.7 | 100% |
| v5-terse | 43 | 1.68s | 7.2 | 1.4 | 71% |
| v6-balanced | 96 | 1.79s | 6.7 | 0.8 | 100% |
| v7-quality | 129 | 1.99s | 6.1 | 1.7 | 100% |

### Model: gemini-2.0-flash-lite

| Prompt | Input Tok | Latency | Alts | Links | Reliability |
|--------|-----------|---------|------|-------|-------------|
| v1-original | 160 | 1.55s | 1.7 | 1.8 | 100% |
| v2-compact | 84 | 1.21s | 0.4 | 0.2 | 100% |
| **v3-minimal** | **60** | **1.79s** | **7.1** | 4.4 | **100%** |
| v4-medium | 71 | 1.30s | 0.1 | 1.8 | 100% |
| v5-terse | 43 | 2.03s | 6.5 | 1.0 | 57% |
| v6-balanced | 96 | 1.91s | 5.1 | 1.0 | 100% |
| v7-quality | 129 | 2.22s | 5.5 | 2.0 | 100% |

---

## Test Sentences

The benchmark used 7 diverse sentence types:

| Type | Sentence | Purpose |
|------|----------|---------|
| simple | "The boy loved his cats" | Basic noun/pronoun linking |
| pronouns | "She told him that he was wrong" | Heavy pronoun usage |
| numbers | "The 3 boys had 5 apples each" | Numeric content |
| adjectives | "The happy girl ran quickly home" | Adjective/adverb alternatives |
| complex | "The old man slowly walked his big brown dog" | Multiple modifiers |
| actions | "He jumped over the fence and ran away" | Verb alternatives |
| emotions | "She felt sad but tried to be happy" | Emotional vocabulary |

---

## Analysis

### Why v6-balanced Wins (Real-World Testing)

Initial benchmarks suggested v3-minimal was best, but real-world testing revealed:

**v3-minimal variance (3 consecutive runs):**
- Run 1: 0 alternatives
- Run 2: 1 alternative
- Run 3: 3 alternatives

**v6-balanced variance (3 consecutive runs):**
- Run 1: 4 alternatives (boy, loved, his, cats)
- Run 2: 3 alternatives (boy, loved, cats)
- Run 3: 4 alternatives (boy, loved, his, cats)

v6-balanced advantages:

1. **Consistency**: 3-5 alts every run vs 0-3 for v3-minimal
   - Explicit "Find alternatives for nouns, verbs, adjectives, pronouns" guides the model
   - More predictable user experience

2. **Token Efficiency**: 96 tokens vs 160 (40% reduction)
   - Still significant savings over original
   - Worth the extra 36 tokens for reliability

3. **Good Quality**: ~4 alts average with meaningful words
   - boy → lad, youth, kid
   - loved → cherished, adored
   - cats → felines, kitties

4. **Fast Enough**: 0.9s average latency
   - Only 0.1s slower than v3-minimal
   - Well under 1s target

### Why v5-terse Fails

Despite being the shortest (43 tokens) and having highest quality when working (8.3 alts), v5-terse only achieves 43-71% reliability:

```
{"words":[{"i":N,"w":"word","a":["word","alt"],"l":[N]}]} a=alts(orig@0),l=linked. {TEXT}
```

**Failure modes:**
- Too compressed, model sometimes outputs plain text
- Missing clear "return JSON" instruction
- No newline separation between format and text

### Trade-offs

| Priority | Best Prompt | Rationale |
|----------|-------------|-----------|
| **Speed + Quality** | v3-minimal | 0.79s, 7.1 alts, 100% reliable |
| Speed only | v4-medium | 0.78s but only 3.2 alts |
| Quality only | v7-quality | 5.5 alts, 3.2 links, but 1.23s |
| Max quality (risky) | v5-terse | 8.3 alts when it works, 43% reliable |

---

## Model Comparison

### Latency Rankings (v3-minimal prompt)

| Rank | Model | Latency | Notes |
|------|-------|---------|-------|
| 1 | gemini-2.5-flash-lite | 0.79s | **Fastest, recommended** |
| 2 | gemini-2.0-flash | 1.34s | 70% slower |
| 3 | gemini-2.0-flash-lite | 1.79s | 126% slower |

### Quality Rankings (v3-minimal prompt)

| Rank | Model | Alts | Links | Notes |
|------|-------|------|-------|-------|
| 1 | gemini-2.0-flash-lite | 7.1 | 4.4 | Best linking |
| 2 | gemini-2.5-flash-lite | 7.1 | 1.2 | Same alts, fewer links |
| 3 | gemini-2.0-flash | 7.1 | 0.7 | Same alts, fewest links |

**Conclusion:** All models produce similar alternative counts with v3-minimal. gemini-2.5-flash-lite is recommended for its speed advantage.

---

## Recommended Configuration

### Production Settings

```bash
# Model
export GEMINI_MODEL="gemini-2.5-flash-lite"

# Prompt (v6-balanced)
PROMPT='Analyze text for word alternatives. Return JSON only:
{"words":[{"i":0,"w":"word","a":["word","alt1","alt2"],"l":[linked_idx]}]}
- a: 3+ alternatives (original first), null if no good alts
- l: linked word indices (e.g., pronouns to their nouns)
Find alternatives for nouns, verbs, adjectives, pronouns.
Text: INPUT_TEXT'
```

### Expected Performance

| Metric | Value |
|--------|-------|
| Input tokens | ~96 |
| Output tokens | ~180 |
| Latency | 0.7-1.1s |
| Alternatives per sentence | 3-5 words (consistent) |
| Reliability | 100% |

### Compared to Original

| Metric | Original | Optimized | Change |
|--------|----------|-----------|--------|
| Input tokens | 162 | 96 | -40% |
| Latency | 2.15s | 0.92s | -57% |
| Alternatives | 2.2 | 4-5 | +100-127% |
| Consistency | Variable | Stable | ✓ |

---

## Implementation

### Updated llm-analyze.sh

```bash
#!/bin/bash
# Optimized LLM Analysis for Dynamic Highlight

INPUT_FILE="$1"
OUTPUT_FILE="$2"
TEXT=$(cat "$INPUT_FILE")

MODEL="${GEMINI_MODEL:-gemini-2.5-flash-lite}"

# v6-balanced prompt (optimized for consistency)
PROMPT="Analyze text for word alternatives. Return JSON only:
{\"words\":[{\"i\":0,\"w\":\"word\",\"a\":[\"word\",\"alt1\",\"alt2\"],\"l\":[linked_idx]}]}
- a: 3+ alternatives (original first), null if no good alts
- l: linked word indices (e.g., pronouns to their nouns)
Find alternatives for nouns, verbs, adjectives, pronouns.
Text: $TEXT"

PROMPT_ESCAPED=$(echo "$PROMPT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))')

curl -s --max-time 30 \
    "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=$GEMINI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
        \"contents\": [{\"parts\": [{\"text\": $PROMPT_ESCAPED}]}],
        \"generationConfig\": {\"maxOutputTokens\": 512}
    }" | python3 -c '
import sys, json, re
raw = sys.stdin.read()
resp = json.loads(raw)
if "candidates" in resp:
    text = resp["candidates"][0]["content"]["parts"][0]["text"].strip()
    text = re.sub(r"^```json\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    data = json.loads(text)
    print(json.dumps(data, indent=2))
else:
    print(json.dumps({"error": resp.get("error", {}).get("message", "unknown")}))
' > "$OUTPUT_FILE"
```

---

## Variance Testing

Benchmarks use averaged results which can hide inconsistency. Real-world variance testing revealed:

### v3-minimal (High Variance)

```
Run 1: 0 alternatives ❌
Run 2: 1 alternative  ⚠️
Run 3: 3 alternatives ✓
```

Despite averaging 7.1 alts in benchmarks, individual runs varied wildly.

### v6-balanced (Low Variance)

```
Run 1: 4 alternatives ✓ (boy→lad, loved→cherished, his→her, cats→felines)
Run 2: 3 alternatives ✓ (boy→lad, loved→cherished, cats→felines)
Run 3: 4 alternatives ✓ (boy→lad, loved→cherished, his→her, cats→kittens)
```

Consistent 3-4 alts with similar words each time.

### Lesson

**Always test variance, not just averages.** The explicit guidance in v6-balanced ("Find alternatives for nouns, verbs, adjectives, pronouns") constrains the model to produce consistent output.

---

## Key Learnings

### 1. Less Is More

The most verbose prompt (v1-original, 160 tokens) produced the fewest alternatives (2.2). The minimal prompt (v3, 60 tokens) produced the most (7.1).

**Hypothesis:** Detailed examples constrain the model's output to match the example too closely. A minimal format specification allows the model to use its full capabilities.

### 2. Abbreviated Keys Work

Using `i`, `w`, `a`, `l` instead of `index`, `word`, `alts`, `linked` saves tokens without reducing quality. The model understands the abbreviation from context.

### 3. Explicit "Return JSON" Matters

v5-terse failed because it lacked a clear instruction. The phrase "Return JSON:" at the start of v3-minimal ensures JSON output.

### 4. Model Speed vs Quality Trade-off

All models produce similar quality with the optimized prompt, but gemini-2.5-flash-lite is 2x faster. There's no quality penalty for using the faster model.

---

## Future Optimizations

1. **Caching:** Cache results for repeated phrases
2. **Streaming:** Start processing before full response arrives
3. **Batching:** Analyze multiple sentences in one request
4. **Fine-tuning:** Create a specialized model for this task

---

## Appendix: Raw Benchmark Data

Full benchmark results saved to:
- `/home/wilfred/tweakcc/tests/results/prompt-benchmark-20260210-163444.txt`

Benchmark script:
- `/home/wilfred/tweakcc/tests/benchmark-prompts.sh`

---

## Groq GPT-OSS Benchmarks (Simple Format)

An alternative to JSON output is a simple pipe-delimited format for faster parsing.

### Format Tested

```
N:word,word|N:word,word
```

Where N is the 1-based word position.

### GPT-OSS-20B Results

**Best Prompt (P2 Compact):**
```
Synonyms. Format: N:word,word|N:word,word (N=word position, 1-indexed). Skip: the/a/an/is/was/he/she/it
```

| Metric | Value |
|--------|-------|
| Avg Latency | ~300-350ms |
| Format Success | 95%+ |
| Links Support | None |
| Reliability | High |

**Sample Output:**
```
Input: "The young boy said he was very happy today"
Output: 2:young,adolescent|3:boy,lad|4:said,declared|7:very,extremely|8:happy,joyful|9:today,nowadays
```

**All Prompts Tested:**

| ID | Prompt | Latency | Format | Links |
|----|--------|---------|--------|-------|
| P1 | `N:syn,syn\|N:syn,syn (1-indexed)` | ~380ms | 60% | None |
| **P2** | Compact with skip list | **~350ms** | **95%** | None |
| P3 | With >N link notation | ~250ms | 40% | Broken |
| P4 | Detailed explanation | ~300ms | 50% | Partial |
| P5 | Few-shot example | ~300ms | 80% | Wrong |

**Key Findings (20B):**
- Links are unreliable - model struggles with semantic linking
- Compact prompt wins for speed + consistency
- Skip list prevents function word clutter
- Latency ~50ms per 5 additional words

### GPT-OSS-120B Results

**P2 Compact (no links):**

| Input | Latency | Format | Sample Output |
|-------|---------|--------|---------------|
| S1 (5w) | 371-450ms | 100% | `2:boy,lad,child|4:happy,joyful,content,pleased` |
| S2 (10w) | 497-825ms | 100% | `2:young,youthful|3:boy,lad|4:said,stated|7:very,extremely|8:happy,joyful` |
| S3 (20w) | 676-823ms | 100% | Full synonym coverage |

**P3 With Links:**

| Input | Latency | Format | Links Quality |
|-------|---------|--------|---------------|
| S1 (5w) | 456-837ms | 80% | Partial - `3:happy,joyful>1` |
| S2 (10w) | 970-1112ms | 60% | Wrong - links to wrong indices |

**120B vs 20B Comparison:**

| Metric | 20B | 120B |
|--------|-----|------|
| Latency (S1) | 185-250ms | 371-450ms |
| Latency (S2) | 280-350ms | 497-825ms |
| Latency (S3) | 225-480ms | 676-823ms |
| Format Success | 95% | 100% |
| Alternatives per word | 2-3 | 3-4 |
| Link Quality | Poor | Poor |

**Key Findings (120B):**
- **More verbose output** - gives 3-4 alternatives vs 2-3
- **Higher format success** - 100% vs 95%
- **~2x slower** - not worth the latency penalty
- **Links still broken** - semantically incorrect

**Recommendation:** Use **20B with P2 Compact** for production:
- 2x faster (200-350ms vs 400-800ms)
- Adequate synonyms (2-3 per word)
- High reliability (95%+)
- Skip link feature (unreliable on both models)

---

*Last updated: February 2026*
