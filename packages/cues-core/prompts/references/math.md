---
last_updated: 2026-03-27
---

# MATH Mode System Prompt

## Overview

The MATH prompt instructs the LLM to return a computable expression rather than computing the answer itself. This allows for **local evaluation** via Node.js, which is more accurate than LLM arithmetic.

## Prompt File

`../blank_math.txt`

## Key Design Principles

### 1. Expression Output (Not Answer)

```
Output ONLY: COMPUTE=expression
```

**Why:** LLMs can make arithmetic errors. By returning an expression like `COMPUTE=4*12`, we evaluate it locally with `node -e "console.log(4*12)"` for guaranteed accuracy.

### 2. Comprehensive Examples (33 examples)

| Category | Example | Output |
|----------|---------|--------|
| Multiplication | `4 * 12 = BLANK` | `COMPUTE=4*12` |
| Division | `100 / 4 = BLANK` | `COMPUTE=100/4` |
| Word math | `half of 16 = BLANK` | `COMPUTE=16/2` |
| Percentages | `50 plus 20% tax = BLANK` | `COMPUTE=50*1.20` |
| Discounts | `80 with 25% off = BLANK` | `COMPUTE=80*0.75` |
| Factorial | `5 factorial = BLANK` | `COMPUTE=1*2*3*4*5` |
| Powers | `2 to the power of 8 = BLANK` | `COMPUTE=2**8` |
| Roots | `square root of 144 = BLANK` | `COMPUTE=12` |
| Temperature | `celsius to fahrenheit 100C = BLANK` | `COMPUTE=(100*9/5)+32` |
| Speed/Distance | `distance at 60 mph for 2.5 hours = BLANK` | `COMPUTE=60*2.5` |
| Averages | `average of 80, 90, 100 = BLANK` | `COMPUTE=(80+90+100)/3` |
| Combinatorics | `permutations 5 choose 2 = BLANK` | `COMPUTE=(1*2*3*4*5)/(1*2*3)` |

### 3. No Word Tokenization

**Old approach (broken):**
```
0=7 1=* 2=8 3== 4=BLANK
```
The `*` becomes a separate token, confusing the model.

**New approach (working):**
```
Solve: 7 * 8 = BLANK
```
Pass the raw text, let the model understand it naturally.

### 4. Simple Output Format

```
COMPUTE=expression
```

- No index number needed (we find the BLANK position in the parser)
- Easy to regex match: `COMPUTE=([0-9+\-*/.()\s\^]+)`
- Evaluated directly with Node.js

## Detection Triggers

The script detects MATH mode when input contains:

```bash
# Numbers with operators
[0-9].*[\*\/+\^-] || [\*\/+\^-].*[0-9]

# Percentages
[0-9]+% || percent

# Word math keywords
plus|minus|times|multiplied|divided|half of|double|triple|squared|cubed|factorial

# Measurements
celsius|fahrenheit|mph|gallons|liters|feet|meters|inches
```

## Benchmark Results

**34 examples, 90%+ accuracy on edge cases, ~200ms average latency**

| Category | Passed | Total |
|----------|--------|-------|
| Basic Arithmetic | 19 | 19 |
| Hard Math | 27 | 27 |
| Edge Cases | 28 | 30 |
| Factorials | 14 | 14 |
| Powers/Roots | 7 | 7 |
| Percentages | 19 | 19 |
| Temperature | 5 | 5 |
| Word Problems | 25 | 25 |

### New Categories (Feb 2026)

| Category | Examples |
|----------|----------|
| Absolute value | `absolute value of -42` → `COMPUTE=42` |
| Modulo | `17 mod 5` → `COMPUTE=17%5` |
| Floor/Ceiling | `floor of 3.7` → `COMPUTE=3` |
| GCD/LCM | `gcd of 48 and 18` → `COMPUTE=6` (direct answer) |
| Trig functions | `sine of 90 degrees` → `COMPUTE=1` (direct answer) |
| Logarithms | `log base 10 of 1000` → `COMPUTE=3` (direct answer) |

**Key insight:** For functions not available in JavaScript (`gcd`, `log10`, `sin`), the model returns the direct answer instead of a function call.

## Why This Works

1. **Examples as patterns** - The LLM learns the input→output mapping from examples
2. **Consistent format** - Always `COMPUTE=expression`, easy to parse
3. **Local evaluation** - Node.js handles the actual math
4. **No hallucination** - LLM just extracts the expression, doesn't compute
