# Tests

Benchmarks for the four LLM analysis modes: MATH, FACTUAL, GRAMMAR (word alternatives), and LINKED (pronoun linking).

## Models

| Provider | Model | Model ID | Speed | Input $/M | Output $/M |
|----------|-------|----------|-------|-----------|------------|
| **Groq** | GPT OSS 120B 128k | `openai/gpt-oss-120b` | 500 TPS | $0.15 | $0.60 |
| **Groq** | GPT OSS 20B 128k | `openai/gpt-oss-20b` | 1,000 TPS | $0.075 | $0.30 |
| **Cerebras** | GPT OSS 120B | `gpt-oss-120b` | 3,000 TPS | $0.35 | $0.75 |
| **Cerebras** | ZAI GLM 4.7 | `zai-glm-4.7` | 1,000 TPS | $2.25 | $2.75 |

## API Reference

### Groq API

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

**Critical**: Must include `"reasoning_effort": "low"` or model uses all tokens for reasoning.

### Cerebras API

```bash
curl -s "https://api.cerebras.ai/v1/chat/completions" \
    -H "Authorization: Bearer $CEREBRAS_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
        "model": "gpt-oss-120b",
        "max_tokens": 400,
        "temperature": 0.3,
        "messages": [{"role": "user", "content": "..."}]
    }'
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | For Groq models | API key from console.groq.com |
| `CEREBRAS_API_KEY` | For Cerebras models | API key from cerebras.ai |
| `LLM_MODEL` | No | Model selection: `groq-120b`, `groq-20b`, `cerebras-120b`, `cerebras-glm` |

## Structure

```
tests/
├── test-sentences.txt       # Standard test sentences
├── benchmarks/              # Mode-specific benchmarks
│   ├── math.sh              # MATH mode (53 tests)
│   ├── math-edge.sh         # MATH edge cases (56 tests)
│   ├── factual.sh           # FACTUAL mode (51 tests)
│   ├── factual-edge.sh      # FACTUAL edge cases (51 tests)
│   ├── word.sh              # GRAMMAR mode (48 tests)
│   ├── word-edge.sh         # GRAMMAR edge cases (47 tests)
│   ├── word-link.sh         # LINKED mode - pronoun linking (12 tests)
│   ├── run-all.sh           # Run all benchmarks for a single model
│   └── compare-models.sh    # Compare all 4 models
└── results/                 # Benchmark results (generated)
```

**Total: 318 tests across all benchmarks**

## Running Benchmarks

Benchmarks require API keys based on model:
- **Groq models**: `GROQ_API_KEY`
- **Cerebras models**: `CEREBRAS_API_KEY`

### MATH Mode (Computation)

```bash
# Core tests - arithmetic, percentages, tips, discounts, word math
./tests/benchmarks/math.sh

# Edge cases - powers, roots, factorials, decimals, word forms (e.g., "four times four")
./tests/benchmarks/math-edge.sh
```

### FACTUAL Mode (Knowledge)

```bash
# Core tests - CEOs, capitals, dates, chemistry, literature
./tests/benchmarks/factual.sh

# Edge cases - obscure capitals, scientific constants, tech history
./tests/benchmarks/factual-edge.sh
```

### GRAMMAR Mode (Word Alternatives)

```bash
# Core tests - synonyms, antonyms, verbs, adjectives, nouns
./tests/benchmarks/word.sh

# Edge cases - polysemy, compounds, prefixed words
./tests/benchmarks/word-edge.sh
```

### LINKED Mode (Pronoun Linking)

```bash
# Detects linked pronouns - boy↔he, girl↔she, man↔his, etc.
./tests/benchmarks/word-link.sh
```

### Run All Benchmarks (Single Model)

```bash
# Run all benchmarks for current model (default: groq-120b)
./tests/benchmarks/run-all.sh

# Run for a specific model
LLM_MODEL=groq-20b ./tests/benchmarks/run-all.sh
LLM_MODEL=cerebras-120b ./tests/benchmarks/run-all.sh
LLM_MODEL=cerebras-glm ./tests/benchmarks/run-all.sh
```

### Compare All Models

```bash
# Run benchmarks on all 4 models and generate comparison report
./tests/benchmarks/compare-models.sh

# Results saved to tests/results/comparison-{timestamp}.md
```

Output includes:
- Per-benchmark pass/fail counts
- Per-mode accuracy breakdown (MATH, FACTUAL, GRAMMAR)
- Latency averages per mode
- Cost estimates per model

## Test Sentences

`test-sentences.txt` contains 10 standard sentences for ad-hoc testing:

```
The boy said he was happy
She quickly ran to the store
The old man walked slowly down the street
...
```

## Test Categories

### MATH Tests Cover

- **Basic arithmetic**: `8 + 5`, `6 * 9`, `72 / 8`
- **Word arithmetic**: `five plus three`, `seven times eight`
- **Percentages**: `100 plus 10% tax`, `80 with 25% off`
- **Tips/discounts**: `50 plus 15% tip`, `200 with 15% off`
- **Half/double/triple**: `half of 50`, `double 35`, `triple 12`
- **Powers/roots**: `2 to the power of 3`, `square root of 16`
- **Factorials**: `5 factorial`, `3!`
- **Modulo**: `17 mod 5`, `23 remainder 7`
- **Word problems**: `3 items at 5 each`, `distance at 60 mph for 2 hours`

### FACTUAL Tests Cover

- **Tech leaders**: Apple, Microsoft, Tesla, Amazon, Google, Meta CEOs
- **Founders**: Bezos, Zuckerberg, Gates, Jobs, Musk
- **World capitals**: Major and obscure (Myanmar, Kazakhstan, Sri Lanka)
- **Chemical symbols**: Au, Ag, Fe, Cu, Na, K
- **Historical dates**: WWII, Moon landing, Titanic, Berlin Wall
- **Science facts**: Boiling/freezing points, speed of light, atomic numbers
- **Literature/art**: Authors, painters, composers
- **Geography**: Oceans, rivers, mountains, deserts

### GRAMMAR Tests Cover

- **Adjective synonyms/antonyms**: happy, big, old, tall, hot, cold
- **Adverb synonyms/antonyms**: quickly, softly, slowly, loudly
- **Verb synonyms**: ran, ate, walked, looked, said, threw
- **Noun synonyms**: dog, house, car, kid, road
- **Emotion words**: angry, scared, sad, excited, worried
- **Sensory words**: quiet, smooth, rough, sweet, sharp
- **Polysemy (context)**: ran (company), bank (river), blue (sad)
- **Compounds**: well-known, high-quality, fast-moving
- **Prefixed words**: unhappy, impossible, invisible

### LINKED Tests Cover

- **Gender linking**: boy↔he, girl↔she, man↔his, woman↔her
- **Pronoun chains**: he↔him, she↔her
- **Reflexive pronouns**: boy↔himself, girl↔herself
- **Multi-pronoun**: boy↔he↔his (full chains)
- **No-link cases**: boy + girl (different entities)
