---
last_updated: 2026-03-31
---

# Groq & Cerebras API Benchmarks

Benchmarks comparing Groq and Cerebras for the dynamic highlight word analysis feature.

**Note:** Groq, Cerebras, and Gemini are currently supported via cues-core's NodeHttpAdapter. Baseten data kept for reference.

> **HISTORICAL NOTE**: These benchmarks were originally run against the bash scripts `llm-analyze-auto.sh` and `llm-analyze.sh`. LLM calls now go through cues-core inline, but the latency characteristics of the providers remain the same.

## Summary

| Rank | Provider | Model | Avg Latency | Min | Max | Format | Reliability |
|------|----------|-------|-------------|-----|-----|--------|-------------|
| 🥇 | **Groq** | **gpt-oss-120b** | **~377ms** | 244ms | 1000ms | 100% | **100%** |
| 🥈 | Groq | gpt-oss-20b | ~315ms | 204ms | 733ms | 90% | 90% |
| 🥉 | Gemini | 2.5-flash-lite | ~681ms | 544ms | 837ms | 100% | 100% |
| 4th | Cerebras | gpt-oss-120b | ~967ms | 375ms | 3631ms | 80% | 80% |
| 5th | Baseten | gpt-oss-120b | ~2087ms | 1339ms | 2809ms | 100% | 100% |

**Winner: Groq gpt-oss-120b** - Best balance of speed and reliability.

**Speed Option: Groq gpt-oss-20b** - 16% faster but 10% failure rate (use with retry logic).

---

## Key Configuration

### Groq (Recommended)

```bash
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "reasoning_effort": "low",
    "max_tokens": 256,
    "temperature": 0.3,
    "messages": [{"role": "user", "content": "..."}]
  }'
```

**Critical parameter:** `"reasoning_effort": "low"` - Required to get output from thinking models.

### Groq gpt-oss-20b (Speed Option)

```bash
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d '{
    "model": "openai/gpt-oss-20b",
    "reasoning_effort": "low",
    "max_tokens": 512,
    "temperature": 0.3,
    "messages": [{"role": "user", "content": "..."}]
  }'
```

**Notes:**
- ~16% faster than 120B (~315ms vs ~377ms)
- 10% empty response rate - use with retry logic
- Simpler output (fewer alternatives)
- Occasional format errors (e.g., `1:boy>girl` instead of `1:girl>3`)
- Use `max_tokens: 512` (higher than 120B) for better reliability
- **Do NOT use** `reasoning_effort: "medium"` - uses all tokens for thinking, empty content

### Cerebras (Alternative)

```bash
curl https://api.cerebras.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CEREBRAS_API_KEY" \
  -d '{
    "model": "gpt-oss-120b",
    "reasoning_effort": "low",
    "max_tokens": 256,
    "temperature": 0.3,
    "messages": [{"role": "user", "content": "..."}]
  }'
```

**Note:** Cerebras has higher variance and ~20% empty response rate.

### Baseten (Slow - Not Recommended)

```bash
curl https://inference.baseten.co/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Key $BASETEN_API_KEY" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "reasoning_effort": "low",
    "max_tokens": 256,
    "temperature": 0.3,
    "messages": [{"role": "user", "content": "..."}]
  }'
```

**Note:** Despite ranking #1 for Time-to-First-Token (TTFT) in streaming benchmarks, Baseten is 5.5x slower than Groq for total response time in non-streaming mode.

---

## Available Models

### Groq Models

| Model | Notes |
|-------|-------|
| `llama-3.1-8b-instant` | Fast, but 40% preamble failures |
| `llama-3.3-70b-versatile` | Good format, missing >INDEX links |
| `llama-4-scout-17b-16e-instruct` | All preambles, unusable |
| `llama-4-maverick-17b-128e-instruct` | All preambles, unusable |
| `openai/gpt-oss-120b` | **Best choice** - 100% reliable, ~377ms |
| `openai/gpt-oss-20b` | **Speed option** - 90% reliable, ~315ms |
| `qwen/qwen3-32b` | Thinking model, needs special handling |

### Cerebras Models

| Model | Notes |
|-------|-------|
| `llama3.1-8b` | Unstable, frequent timeouts |
| `llama-3.3-70b` | ~554ms, missing >INDEX links |
| `gpt-oss-120b` | Works with reasoning_effort=low, but 20% failures |
| `qwen-3-32b` | Only outputs `<think>` blocks |
| `qwen-3-235b-a22b-instruct-2507` | Large MoE model |
| `zai-glm-4.7` | Very slow (~13s) |

---

## Detailed Benchmark Results

### Test Configuration

- **Input:** `"The boy said he was happy"`
- **Task:** Generate word alternatives with semantic linking
- **Expected format:** `1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad`
- **Runs per model:** 15

### Groq gpt-oss-120b (reasoning_effort: low)

**Run 1:**
```
669ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
241ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
515ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
242ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
453ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
510ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
247ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
265ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
276ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
230ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
529ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
520ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
245ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
262ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
585ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
```

**Run 2 (vs Baseten):**
```
287ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
352ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
299ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1000ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
279ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
253ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
527ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
252ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
252ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
256ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
256ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
701ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
250ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
253ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
244ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
```

**Stats:** Avg=~380ms, Min=230ms, Max=1000ms, Success=100%

### Groq gpt-oss-20b (reasoning_effort: low)

```
242ms: 1:girl>3|3:she>1
271ms: 1:girl|3:she>1
483ms: 1:girl>3|3:she>1|2:stated,spoke|5:glad,content
399ms: EMPTY
254ms: 1:girl>3|3:she>1|5:glad,content
248ms: 1:girl>3|3:she>1|5:glad,content
321ms: 1:girl>3|2:told,mentioned|3:she>1|5:glad,content
353ms: 1:boy>girl|3:he>she>1 (format error)
232ms: 1:girl>3|3:she>1|5:content,pleased
347ms: 1:girl|3:she>1
```

**Stats:** Avg=315ms, Min=204ms, Max=733ms, Success=90%

**vs 120B comparison (10 runs each):**
| Model | Avg | Reliability | Output Quality |
|-------|-----|-------------|----------------|
| gpt-oss-20b | 315ms | 90% | Basic - fewer alternatives |
| gpt-oss-120b | 527ms | 100% | Rich - more alternatives |

**Note:** 20B with `reasoning_effort: "medium"` produces 100% empty responses (all 256 tokens go to reasoning field).

### Cerebras gpt-oss-120b (reasoning_effort: low)

```
1807ms: EMPTY
2054ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
442ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
534ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
528ms: EMPTY
616ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1282ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
445ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
3631ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
491ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
553ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
700ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
375ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
450ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
602ms: EMPTY
```

**Stats:** Avg=967ms, Min=375ms, Max=3631ms, Success=80% (3 EMPTY responses)

### Gemini 2.5 Flash Lite (Baseline)

```
806ms: 0:That|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
837ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
544ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
761ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
707ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
666ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
791ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
703ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
650ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
549ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
697ms: 0:That|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
600ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
605ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
744ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
553ms: 0:This|1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|4:felt|5:sad,glad
```

**Stats:** Avg=681ms, Min=544ms, Max=837ms, Success=100%

### Baseten gpt-oss-120b (reasoning_effort: low)

```
2752ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2028ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2276ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1821ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2157ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1875ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2066ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2809ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2295ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1720ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2342ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1780ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1339ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
2545ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
1500ms: 1:girl>3,child>3|2:yelled,stated|3:she>1,they>1|5:sad,glad
```

**Stats:** Avg=2087ms, Min=1339ms, Max=2809ms, Success=100%

---

## Other Models Tested

### Models That Don't Work Well

| Provider | Model | Issue |
|----------|-------|-------|
| Groq | llama-4-scout-17b | 100% preambles, no actual output |
| Groq | llama-4-maverick-17b | 100% preambles, no actual output |
| Groq | gpt-oss-20b | Empty without reasoning_effort (thinking model) |
| Cerebras | llama3.1-8b | Unstable, frequent 30s timeouts |
| Cerebras | qwen-3-32b | Only outputs `<think>` blocks |

### Models Missing Semantic Links

| Provider | Model | Latency | Issue |
|----------|-------|---------|-------|
| Groq | llama-3.3-70b-versatile | ~566ms | Outputs `1:girl,child` not `1:girl>3,child>3` |
| Cerebras | llama-3.3-70b | ~554ms | Same issue - missing >INDEX notation |

These models are fast but don't produce the correct linking format.

---

## Thinking Models: The `reasoning_effort` Parameter

GPT-OSS and Qwen3 are "thinking" models that reason internally before responding. Without proper configuration:

- Output goes to `reasoning` field, not `content`
- `content` field is empty
- Response appears to fail

**Solution:** Use `"reasoning_effort": "low"` to:
1. Reduce thinking time
2. Get output in the `content` field
3. Dramatically improve latency

| Setting | Behavior |
|---------|----------|
| No parameter | Full thinking, empty content |
| `"reasoning_effort": "low"` | Minimal thinking, fast response |
| `"reasoning_effort": "medium"` | Balanced (not tested) |
| `"reasoning_effort": "high"` | Full thinking (default) |

---

## Why Groq Beats Cerebras (and Baseten)

According to [Artificial Analysis benchmarks](https://artificialanalysis.ai/models/gpt-oss-120b/providers):

| Metric | Cerebras | Groq | Baseten |
|--------|----------|------|---------|
| **Output Speed** | 2,942 t/s (#1) | ~493 t/s | ~500 t/s |
| **Time to First Token** | Not top 5 | 0.17s (#2) | 0.12s (#1) |

**Key insight: For SHORT outputs (~50 tokens), Time-to-First-Token (TTFT) dominates, not throughput.**

```
Cerebras: ~0.3s TTFT + 50/2942s generation = ~317ms theoretical
Groq:     0.17s TTFT + 50/493s generation  = ~270ms theoretical
Baseten:  0.12s TTFT (streaming only, high overhead for sync requests)
```

- **Cerebras** is optimized for **throughput** (tokens/second) - best for long outputs
- **Groq** is optimized for **latency** (time to first token) - best for short outputs
- **Baseten** has low streaming TTFT but high overhead for synchronous requests

For our ~50 token word analysis outputs, Groq's latency optimization wins.

---

## Environment Variables

```bash
# Add to ~/.bashrc
export GROQ_API_KEY="your-groq-api-key"
export CEREBRAS_API_KEY="your-cerebras-api-key"
export GEMINI_API_KEY="your-gemini-api-key"
export BASETEN_API_KEY="your-baseten-api-key"
```

---

## Recommendations

1. **Use Groq gpt-oss-120b** for production
   - 45% faster than Gemini
   - 100% reliable
   - Consistent latency (244-1000ms, typically ~300ms)
   - Best for short outputs where TTFT matters

2. **Consider Groq gpt-oss-20b** for maximum speed
   - 16% faster than 120B (~315ms vs ~377ms)
   - 90% reliability - implement retry logic
   - Simpler output (fewer alternatives per word)
   - Good for latency-critical applications

3. **Fallback to Gemini** if Groq is unavailable
   - Still fast (~680ms)
   - 100% reliable
   - No API key dependency issues

4. **Avoid Cerebras** for short outputs
   - 20% failure rate
   - High variance (375ms to 3.6s)
   - Better suited for long-form generation where throughput matters

5. **Avoid Baseten** for non-streaming
   - 5.5x slower than Groq (~2s avg)
   - Low TTFT only applies to streaming mode
   - High overhead for synchronous requests

---

## When to Use Each Provider

| Use Case | Best Provider | Why |
|----------|---------------|-----|
| Short outputs, reliable | **Groq gpt-oss-120b** | 100% reliability, ~377ms |
| Short outputs, max speed | Groq gpt-oss-20b | ~315ms but 90% reliability |
| Long outputs (1000+ tokens) | Cerebras | Highest throughput (2942 t/s) |
| Streaming with fast first byte | Baseten | Lowest streaming TTFT (0.12s) |
| Reliability critical | Gemini or Groq 120B | 100% success rate |

---

*Benchmarked: February 2026*
*Test sentence: "The boy said he was happy"*
