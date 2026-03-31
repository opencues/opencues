---
last_updated: 2026-03-31
---

# LLM Model Integration

Multiple LLM providers are available for word alternatives and blank computation. All LLM calls now go through cues-core's CueResolver and NodeHttpAdapter.

## Quick Start

```bash
# Default is GPT-OSS-120b via Groq (~200ms), called inline via cues-core
export GROQ_API_KEY="your-key"

# Alternative providers (set env vars, cues-core reads them at runtime)
export LLM_MODEL=cerebras-120b CEREBRAS_API_KEY="your-key"
export LLM_MODEL=gemini GEMINI_API_KEY="your-key"
```

> **HISTORICAL NOTE**: Before cues-core, LLM calls were made via bash scripts (`llm-analyze-auto.sh`, `llm-analyze.sh`). These scripts are no longer used.

## Available Models

| Model ID | Provider | Script Default | Notes |
|----------|----------|----------------|-------|
| `groq-120b` | Groq | **Default** | GPT-OSS-120b, fastest (~200ms) |
| `groq-20b` | Groq | — | GPT-OSS-20b, lighter |
| `cerebras-120b` | Cerebras | — | GPT-OSS-120b via Cerebras |
| `cerebras-glm` | Cerebras | — | ZAI-GLM-4.7 |
| `qwen-3-32b` | Cerebras | — | Qwen 3 32B |
| `gemini` | Google | — | Gemini 3 Flash Preview (~1400ms) |

## Benchmark Results

### Factual Mode Accuracy

Tested 20 factual questions across multiple categories:

| Category | Passed | Examples |
|----------|--------|----------|
| Companies/Leaders | 4/4 | CEO of Apple → Tim Cook |
| World Capitals | 4/4 | Capital of China → Beijing |
| Science Facts | 4/4 | Chemical symbol for iron → Fe |
| Historical Events | 4/4 | Berlin Wall fell in → 1989 |
| Arts/Literature | 4/4 | Author of 1984 → George Orwell |
| **Total** | **20/20** | **100% accuracy** |

**Average latency: ~230ms**

### Latency Comparison

| Provider | Model | 3 words | 7-8 words | 13 words | 18 words |
|----------|-------|---------|-----------|----------|----------|
| **Groq** | **GPT-OSS-120b** | **~170ms** | **~200ms** | **~250ms** | **~300ms** |
| Groq | GPT-OSS-20b | ~220ms | ~320ms | ~255ms | ~260ms |
| Cerebras | GPT-OSS-120b | ~200ms | ~250ms | ~300ms | ~350ms |

Both providers offer similar performance with GPT-OSS-120b.

### Math Accuracy

Tested 249 problems across multiple categories:

| Category | Passed | Total | Rate |
|----------|--------|-------|------|
| Basic Math | 19 | 19 | 100% |
| Hard Math | 27 | 27 | 100% |
| Edge Cases | 28 | 30 | 93% |
| Obscure | 22 | 23 | 96% |
| Factorials | 14 | 14 | 100% |
| Extreme Edge | 35 | 36 | 97% |
| Powers/Temp/Speed | 24 | 24 | 100% |
| Diverse | 21 | 25 | 84% |
| Shopping/Everyday | 22 | 23 | 96% |
| Brain Teasers | 23 | 28 | 82% |
| **TOTAL** | **235** | **249** | **94.4%** |

## Mode-Specific Prompts

The key to GPT-OSS performance is the **improved prompt format**. Each mode has an optimized prompt.

**Prompt files:** `system_prompts/` folder
- `blank_math.txt` - MATH mode prompt (blanks)
- `blank_factual.txt` - FACTUAL mode prompt (blanks)
- `blank_grammar.txt` - GRAMMAR mode prompt (blanks)
- `grammar.txt` - GRAMMAR mode prompt (word alternatives, no blanks)
- `classifier.txt` - Mode classifier
- `references/*.md` - Detailed documentation for each prompt

### MATH Mode

**Detection triggers:**
- Numbers with operators: `[0-9].*[*/+-]`
- Percentages: `[0-9]+%` or `percent`
- Word math: `plus|minus|times|half of|double|triple|factorial`
- Measurements: `celsius|fahrenheit|mph|gallons|meters`

**Prompt format:**
```
Solve the math. Output ONLY: COMPUTE=expression

Examples:
- 4 * 12 = BLANK → COMPUTE=4*12
- half of 16 = BLANK → COMPUTE=16/2
- 50 plus 20% tax = BLANK → COMPUTE=50*1.20
- 5 factorial = BLANK → COMPUTE=1*2*3*4*5
- tip 18% on 85 = BLANK → COMPUTE=0.18*85
- celsius to fahrenheit 100C = BLANK → COMPUTE=(100*9/5)+32
- average of 80, 90, 100 = BLANK → COMPUTE=(80+90+100)/3

Solve: [INPUT TEXT]
```

**Key improvements over old prompt:**
1. **No word tokenization** - pass raw text, not `0=7 1=* 2=8`
2. **Simple output format** - just `COMPUTE=expression`
3. **Comprehensive examples** - 20+ covering all math types
4. **Local evaluation** - expression evaluated via Node.js

### FACTUAL Mode

**Detection triggers:**
- Titles: `CEO of|capital of|president of|founder of|author of|inventor of|creator of|director of|composer of|painter of`
- Actions: `invented|discovered|born in|died in|directed by|written by|composed by|painted by`
- Superlatives: `largest|smallest|tallest|longest|oldest|youngest|closest|nearest|first|last|highest|lowest`
- Events: `ended in|started in|began in|founded in|fell in|sank in|released in|launched in`
- Questions: `^Who|What|Where|When|Which|How many`
- Patterns: `chemical symbol|atomic number|speed of`

**Prompt format:**
```
Answer the factual question. Output ONLY the answer(s).

Format: ANSWER=answer1,answer2

Examples:
- The CEO of Apple is BLANK → ANSWER=Tim Cook
- The capital of France is BLANK → ANSWER=Paris
- World War 2 ended in BLANK → ANSWER=1945

Question: [INPUT TEXT]
```

### GRAMMAR Mode

**Detection:** Default when no MATH or FACTUAL triggers match.

**Prompt format:**
```
[INDEXED WORDS: 1=nervous 2=teenager 3=carefully ...]

For each content word, provide 2-3 alternatives (synonym, opposite, or creative).
For BLANK positions, provide 5 words that fit grammatically.

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2
```

## API Configuration

### Groq (GPT-OSS)

```bash
curl -s "https://api.groq.com/openai/v1/chat/completions" \
    -H "Authorization: Bearer $GROQ_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "model": "openai/gpt-oss-120b",
        "reasoning_effort": "low",
        "max_tokens": 400,
        "temperature": 0.3,
        "messages": [{"role": "user", "content": "..."}]
    }'
```

**Critical settings:**
- `reasoning_effort: "low"` - Required! Without it, model uses all tokens for reasoning
- `max_tokens: 400` - Enough for complex math with reasoning
- `temperature: 0.3` - Low for consistent results

### Reasoning Effort Options

| Level | Latency | Behavior |
|-------|---------|----------|
| `none` | ~80ms | No output (broken) |
| `low` | ~200ms | Best for our use case |
| `medium` | ~400ms | More reasoning, slower |
| `high` | ~800ms | Maximum reasoning |

**Always use `low`** - it provides the right balance of speed and accuracy.

## Math Categories Tested

### Basic Arithmetic
- Addition, subtraction, multiplication, division
- Order of operations: `2 + 3 * 4 - 5 = 9`
- Parentheses: `(10 + 5) * 4 = 60`

### Word Math
- `half of 16` → `COMPUTE=16/2`
- `double 25` → `COMPUTE=25*2`
- `triple half of 60` → `COMPUTE=(60/2)*3`
- `a quarter of 200` → `COMPUTE=200/4`
- `one third of 90` → `COMPUTE=90/3`

### Percentages & Tax
- `100 plus 10% tax` → `COMPUTE=100*1.10`
- `80 with 25% off` → `COMPUTE=80*0.75`
- `15% of 200` → `COMPUTE=0.15*200`
- `tip 18% on 85` → `COMPUTE=0.18*85`
- `markup 40% on cost 75` → `COMPUTE=75*1.40`

### Factorials & Combinatorics
- `5 factorial` → `COMPUTE=1*2*3*4*5`
- `5!` → `COMPUTE=1*2*3*4*5`
- `5! divided by 3!` → `COMPUTE=(1*2*3*4*5)/(1*2*3)`
- `permutations of 5 choose 2` → `COMPUTE=(1*2*3*4*5)/(1*2*3)`
- `combinations of 5 choose 2` → `COMPUTE=(1*2*3*4*5)/((1*2)*(1*2*3))`

### Powers & Roots
- `2 to the power of 10` → `COMPUTE=2**10`
- `5 squared` → `COMPUTE=5*5`
- `3 cubed` → `COMPUTE=3*3*3`
- `square root of 144` → `COMPUTE=12`
- `cube root of 125` → `COMPUTE=5`

### Temperature Conversion
- `celsius to fahrenheit: 100C` → `COMPUTE=(100*9/5)+32`
- `fahrenheit to celsius: 32F` → `COMPUTE=(32-32)*5/9`

### Speed/Distance/Time
- `distance if speed 60 mph for 2.5 hours` → `COMPUTE=60*2.5`
- `time to travel 300 miles at 50 mph` → `COMPUTE=300/50`
- `speed if 180 km in 3 hours` → `COMPUTE=180/3`

### Financial
- `simple interest on 5000 at 8% for 2 years` → `COMPUTE=5000*0.08*2`
- `monthly payment if 18000 over 60 months` → `COMPUTE=18000/60`
- `down payment 20% on 250000` → `COMPUTE=250000*0.20`

### Statistics
- `average of 85, 90, 78, 95` → `COMPUTE=(85+90+78+95)/4`
- `sum of first 10 positive integers` → `COMPUTE=1+2+3+4+5+6+7+8+9+10`
- `median of 3, 7, 9, 12, 15` → `COMPUTE=9`

### Geometry
- `area of square with side 7` → `COMPUTE=7*7`
- `perimeter of rectangle 5 by 8` → `COMPUTE=2*(5+8)`
- `area of triangle base 10 height 6` → `COMPUTE=0.5*10*6`
- `circumference of circle radius 7` → `COMPUTE=2*3.14159*7`
- `volume of cube side 4` → `COMPUTE=4*4*4`

### Real World Problems
- `3 items at 4.99 each` → `COMPUTE=3*4.99`
- `bill split 5 ways if total 127.50` → `COMPUTE=127.50/5`
- `gallons for 420 mile trip at 30 mpg` → `COMPUTE=420/30`
- `tiles needed: floor 144 sq ft, each tile 0.25 sq ft` → `COMPUTE=144/0.25`

### Classic Brain Teasers
- `if 3 cats catch 3 mice in 3 minutes, mice caught by 9 cats in 9 minutes` → 27
- `handshakes if 5 people each shake once with everyone` → 10
- `diagonals in a hexagon` → 9
- `sum of interior angles of pentagon` → 540
- `next in sequence 1, 1, 2, 3, 5, 8` → 13 (Fibonacci)

## Known Limitations

Some categories have lower accuracy:

1. **Mixture problems** (~60%) - Complex multi-step algebra
2. **GCD/LCM** (~70%) - Algorithmic, not expression-based
3. **Abstract phrasing** (~80%) - "a number doubled then halved"
4. **Modulo/Remainder** (~70%) - Not well supported

These are acceptable tradeoffs for the 7.5x speed improvement.

## Switching Providers

Set environment variables before launching Claude Code; cues-core reads them at runtime:

```bash
# Use Groq (default)
export GROQ_API_KEY="your-key"

# Use Cerebras
export LLM_MODEL=cerebras-120b
export CEREBRAS_API_KEY="your-key"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `groq-120b` | Provider/model selection |
| `GROQ_API_KEY` | - | Required for Groq models |
| `CEREBRAS_API_KEY` | - | Required for Cerebras models |
| `GEMINI_API_KEY` | - | Required for Gemini models |

## Changelog

- **Feb 2026**: Added Cerebras as alternative provider
- **Feb 2026**: Added LLM classifier for mode detection (MATH/FACTUAL/GRAMMAR)
- **Feb 2026**: Added factorial support to math prompt
- **Feb 2026**: Improved prompt format (no tokenization, cleaner output)
- **Feb 2026**: Added comprehensive math examples (20+)
- **Feb 2026**: Documented 249 test cases with 94.4% accuracy
