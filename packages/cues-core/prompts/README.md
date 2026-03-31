---
last_updated: 2026-03-31
---

# System Prompts

This folder contains the system prompts used by cues-core's CueResolver for different modes of operation.

## Structure

```
system_prompts/
├── README.md            # This file
├── classifier.txt       # Mode classifier prompt (MATH/FACTUAL/GRAMMAR only)
├── blank_math.txt       # MATH mode - compute expressions (blanks)
├── blank_factual.txt    # FACTUAL mode - answer questions (blanks)
├── blank_grammar.txt    # GRAMMAR mode - fill blanks with words
├── grammar.txt          # GRAMMAR mode - word alternatives (no blanks)
├── claude_code.txt      # CLAUDE_CODE mode prompt (legacy, replaced by tips lookup)
├── hints.txt            # Hints system prompt
├── linked.txt           # Linked words prompt (gender/number agreement)
├── linked-kimi.txt      # Linked words prompt (Kimi variant)
└── references/
    ├── classifier.md    # Classifier documentation
    ├── math.md          # MATH prompt documentation
    ├── factual.md       # FACTUAL prompt documentation
    └── grammar.md       # GRAMMAR prompt documentation
```

Note: CLAUDE_CODE is now handled by per-word tips lookup (`~/.claude/claude-code-tips.json`), not a prompt.

## Mode Classification

### Per-Word Tips Lookup (NEW)

Before the classifier runs, each word is checked against the tips file:
- Matching words get instant alternatives + tips (~1ms)
- Non-matching content words go to LLM for GRAMMAR alternatives (~200ms)
- Words in the same sentence can have DIFFERENT sources (tips vs grammar)

Example: "The quick fox uses ultrathink"
- "quick", "fox", "uses" → GRAMMAR (LLM)
- "ultrathink" → TIPS (local file)

### Classifier Prompt (`classifier.txt`)

The classifier only runs for inputs with blanks (`_`). Returns `MODE=MATH`, `MODE=FACTUAL`, or `MODE=GRAMMAR`.

| Metric | Value |
|--------|-------|
| Examples | 16 (MATH + FACTUAL + GRAMMAR) |
| Accuracy | 100% (45/45 tests) |
| Latency | ~170ms |

**Classifier runs when:** Input contains a blank (`_`) that needs MATH/FACTUAL/GRAMMAR handling.

**Tips lookup runs when:** Always (checks each word against tips file first).

## Modes Overview

| Mode | Trigger | Purpose | Examples | Accuracy | Latency |
|------|---------|---------|----------|----------|---------|
| **TIPS** | Word matches tips file | CLI term alternatives | N/A | 100% | ~1ms |
| **MATH** | Blank + numbers/operators | Compute expressions | 33 | 90%+ | ~200ms |
| **FACTUAL** | Blank + factual question | Answer questions | 31 | 98% | ~230ms |
| **GRAMMAR** | Default (no other triggers) | Word alternatives | 23 | 94% | ~250ms |
| **LINKED** | `LLM_MODE=LINKED` | Semantic word links | 172 | 56% | ~900ms |

## Prompt Files

### `classifier.txt`
Returns `MODE=MATH`, `MODE=FACTUAL`, or `MODE=GRAMMAR` (blanks only).
- 16 examples across 3 modes
- 100% accuracy on test benchmark
- Handles ambiguous inputs with blanks
- Note: CLAUDE_CODE detection handled by tips file, not classifier

### `blank_math.txt`
Returns `COMPUTE=expression` which is evaluated locally via Node.js.
- 33 examples across 10+ categories
- Covers arithmetic, percentages, factorials, powers, temperature, absolute value, modulo, floor/ceil, gcd/lcm, trig functions, logarithms

### `blank_factual.txt`
Returns `ANSWER=value` for knowledge questions.
- 31 categorized examples
- Covers people, places, dates, science

### `grammar.txt`
Returns `INDEX:alt1,alt2,alt3` for word alternatives (when NO blanks present).
- Used for existing words, not blank filling
- Generates synonyms, opposites, creative variations
- Includes proper noun categories (companies, job titles, etc.)

### `linked.txt`
Returns `LINKS: idx-idx [CATEGORY], ...` for semantic word linking.
- Identifies words that MUST change together (gender, number, verb agreement, etc.)
- 12 categories: GENDER, NUMBER, VERB, POSSESSION, TENSE, REFLEXIVE, QUANTITY, DETERMINER, NEGATION, COMPARATIVE, CONDITIONAL, CONCEPT
- Parser extracts index pairs bidirectionally into `result.words[n].linked` arrays
- **CRITICAL:** Must have its own parser branch — grammar parser cannot parse `LINKS:` format
- Benchmarks (March 2026): gender 100%, most categories 75-89%, concept 23%
- Also: `linked-kimi.txt` variant optimized for Kimi K2 model

### `blank_grammar.txt`
Returns `INDEX:word1,word2,word3,word4,word5` for blank filling.
- Focused prompt for `_` placeholder filling only
- Rules based on what comes BEFORE and AFTER the blank:
  - Determiner + blank + noun → adjectives ("The _ dog" → big, small, brown)
  - Blank + verb → nouns ("The _ ran" → dog, boy, girl)
  - Start + noun/adj → determiners ("_ dog" → The, A, My)
  - Subject + blank + adverb → verbs ("She _ quickly" → ran, walked)
- 14/14 accuracy on edge cases

### `~/.claude/claude-code-tips.json` (not a prompt)
Per-word tips lookup replaces the old `claude_code.txt` prompt:
- Each word is checked against the tips file before LLM call
- Matching words get instant alternatives + per-word tips
- Two structures supported:
  - `words`: Per-word entries with individual tips and alts
  - `groups`: Synonym groups that share one tip; alts point to OTHER groups
- Lookup priority: groups first, then words (backward compatible)
- See CLAUDE.md "Claude Code Tips System" for full documentation

## Key Design Principles

### 1. Output Format Prefix
Each mode has a distinct prefix (`COMPUTE=`, `ANSWER=`, `INDEX:`, `LINKS:`) for easy parsing.

### 2. Comprehensive Examples
More examples = better accuracy:
- MATH: 50% → 90%+ (21 → 33 examples)
- GRAMMAR: 50% → 94% (2 → 23 examples)

### 3. Categorized Organization
All prompts group examples by category:
- MATH: arithmetic, percentages, powers, temperature, functions
- FACTUAL: People, Places, Dates, Science
- GRAMMAR: nouns, adjectives, adverbs, verbs, emotional, sensory, modern, BLANK handling

### 4. Local Evaluation
MATH mode returns expressions, not answers. Local evaluation is more accurate than LLM arithmetic.

### 5. Direct Answers for Non-Evaluable Functions
For functions not available in JavaScript (gcd, lcm, log, sin), MATH returns direct numeric answers instead of function calls.

### 6. Creative Variety (GRAMMAR)
The grammar prompt explicitly requests "synonym, opposite, creative" alternatives, producing imaginative outputs like:
- `haunting melody` → eerie, comforting, **lingering echo**
- `velvet darkness` → plush, coarse, **whisper-fabric**
- `astronaut` → cosmonaut, groundling, **star-walker**

## Modifying Prompts

1. Edit the `.txt` file directly
2. Test with representative inputs
3. Update the reference `.md` file if adding new patterns
4. Update detection triggers in cues-core if needed

## Model Configuration

These prompts are optimized for **GPT-OSS-120b** via Groq with:
- `reasoning_effort: "low"`
- `max_tokens: 400`
- `temperature: 0.3`

**Execution paths:**
- All modes go through cues-core's CueResolver and NodeHttpAdapter (inline HTTPS, no bash scripts)
- Classification (MATH/FACTUAL/GRAMMAR) handled by cues-core's `looksLikeMath`/`looksLikeFactual`

**Per-mode model overrides** (env vars):
- `LLM_MODEL` — override all modes
- `LLM_MODEL_MATH` — override MATH mode only
- `LLM_MODEL_FACTUAL` — override FACTUAL mode only
- `LLM_MODEL_LINKED` — override LINKED mode only

See `/docs/llm-providers.md` for full model documentation.

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      INPUT TEXT                         │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│     STEP 1: Per-Word Tips Lookup (~1ms)                 │
│     Check each word against ~/.claude/claude-code-tips.json │
│     Matching words get tips alts, non-matching continue │
└─────────────────────────────────────────────────────────┘
                           │
            ┌──────────────┴──────────────┐
            ▼                             ▼
   Has blank (_)?                  No blank?
            │                             │
            ▼                             ▼
┌─────────────────────────────┐  ┌─────────────────────────┐
│    CLASSIFIER (~280ms)      │  │   LLM for GRAMMAR       │
│  "MATH, FACTUAL, GRAMMAR?"  │  │   (non-tips words only) │
└─────────────────────────────┘  └─────────────────────────┘
           │                              │
   ┌───────┼───────┐                      │
   ▼       ▼       ▼                      ▼
┌──────┐┌──────┐┌──────────┐         ┌──────────┐
│ MATH ││FACTUL││ GRAMMAR  │         │ GRAMMAR  │
│      ││      ││ (blank)  │         │(no blank)│
└──────┘└──────┘└──────────┘         └──────────┘
   │       │          │                   │
   ▼       ▼          ▼                   ▼
blank_math blank_factual blank_grammar  grammar.txt
```

### Key Design: Separate Blank Prompt

The GRAMMAR mode uses **two different prompts**:
- `grammar.txt` - Word alternatives (synonyms, antonyms) for existing words
- `blank_grammar.txt` - Fill-in-the-blank with grammatically correct words

This separation prevents confusion between "give alternatives for this word" and "fill this blank with the right word type".

### Pipeline Latency

| Path | Latency |
|------|---------|
| Classifier → MATH | ~370ms |
| Classifier → FACTUAL | ~400ms |
| Classifier → GRAMMAR | ~420ms |

### Adding New Modes

1. **Add to classifier.txt:**
   ```
   NEWMODE - When to use this mode:
   - "example 1" → NEWMODE
   - "example 2" → NEWMODE
   ```

2. **Create newmode.txt** with processing prompt

3. **Create references/newmode.md** with documentation

4. **Update integration code** to handle new mode

The classifier approach scales linearly—adding a new mode only requires adding examples for that mode, not handling interactions with all existing modes.
