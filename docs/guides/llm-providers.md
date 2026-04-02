---
last_updated: 2026-03-31
---

# LLM Providers

LLM provider configuration and benchmarks for cues-core.

## Quick Start

```bash
# Default: Groq GPT-OSS-120b (~200-400ms)
export GROQ_API_KEY="your-key"

# Alternatives
export LLM_MODEL=cerebras CEREBRAS_API_KEY="your-key"
export LLM_MODEL=gemini GEMINI_API_KEY="your-key"
```

## Provider Comparison

| Rank | Provider | Model | Avg Latency | Reliability |
|------|----------|-------|-------------|-------------|
| 1 | **Groq** | GPT-OSS-120b | ~200-400ms | 100% |
| 2 | Groq | GPT-OSS-20b | ~315ms | 90% |
| 3 | Cerebras | GPT-OSS-120b | ~450ms | 80% |
| 4 | Gemini | 2.5-flash-lite | ~680ms | 100% |

**Recommendation:** Groq GPT-OSS-120b for best balance of speed and reliability.

## Provider Configuration

### Groq (Default)

```bash
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -d '{
    "model": "openai/gpt-oss-120b",
    "reasoning_effort": "low",
    "max_tokens": 400,
    "temperature": 0.3,
    "messages": [{"role": "user", "content": "..."}]
  }'
```

**Critical:** `"reasoning_effort": "low"` is required for thinking models.

### Cerebras

```bash
curl https://api.cerebras.ai/v1/chat/completions \
  -H "Authorization: Bearer $CEREBRAS_API_KEY" \
  -d '{
    "model": "gpt-oss-120b",
    "reasoning_effort": "low",
    "max_tokens": 400
  }'
```

### Gemini

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite-preview:generateContent?key=$GEMINI_API_KEY" \
  -d '{"contents": [{"parts": [{"text": "..."}]}]}'
```

## Accuracy Benchmarks

### Math Mode (249 problems)

| Category | Accuracy |
|----------|----------|
| Basic Math | 100% |
| Hard Math | 100% |
| Edge Cases | 93% |
| Factorials | 100% |
| Brain Teasers | 82% |
| **Overall** | **94.4%** |

### Factual Mode (20 questions)

| Category | Accuracy |
|----------|----------|
| Companies/Leaders | 100% |
| World Capitals | 100% |
| Science Facts | 100% |
| Historical Events | 100% |
| **Overall** | **100%** |

## cues-core Integration

All LLM calls go through cues-core's `NodeHttpAdapter`:

```typescript
import { NodeHttpAdapter, GrammarSource } from 'cues-core';

const httpAdapter = new NodeHttpAdapter({
  providerOverrides: {
    "api.groq.com": { reasoning_effort: "low", max_tokens: 400 }
  }
});

const source = new GrammarSource({ httpAdapter });
```

The adapter handles:
- Connection keep-alive (reduces latency ~50ms)
- Provider-specific headers
- Response parsing (content vs reasoning field)

## Latency by Input Size

| Words | Groq 120b | Cerebras |
|-------|-----------|----------|
| 3 | ~170ms | ~200ms |
| 7-8 | ~200ms | ~250ms |
| 13 | ~250ms | ~300ms |
| 18 | ~300ms | ~350ms |

## Troubleshooting

### Empty responses
- Check `reasoning_effort: "low"` is set
- For Groq 20b, increase `max_tokens` to 512
- Response may be in `reasoning` instead of `content` for thinking models:
  ```javascript
  const message = resp.choices[0].message;
  const content = (message.content || message.reasoning || '').trim();
  ```

### High latency
- First request is slower (cold start)
- Use connection keep-alive via NodeHttpAdapter
- Consider Groq 20b for speed (90% reliability)
