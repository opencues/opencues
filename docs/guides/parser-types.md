---
last_updated: 2026-04-03
---

# Response Parser Types

When adding a source to `cues.md` or `blanks.md`, the `parser` field tells opencues-core how to interpret the LLM's response. There are four parser types.

## alternatives (default)

Extracts per-word alternatives from indexed lines.

**LLM output format:**
```
0:better,improved,enhanced
2:quick,rapid,speedy
```

Each line is `INDEX:alt1,alt2,alt3` where INDEX is the word's position in the input text. The original word is automatically prepended to the alternatives list.

**Use when:** you want multiple word-level suggestions (synonyms, grammar corrections, style variations). This is the default if `parser` is omitted.

## compute

Evaluates a math expression from the LLM response.

**LLM output format:**
```
COMPUTE=40+8
```

The expression is sanitized (only digits, operators, parentheses allowed) and evaluated safely. Results are rounded to 4 decimal places, converted to integer when possible.

**Use when:** the blank requires a calculated numeric answer (e.g., `4 * 12 = _`).

## answer

Extracts a single direct answer.

**LLM output format:**
```
ANSWER=Paris
```

The value after `ANSWER=` is used verbatim (trimmed, max 100 characters).

**Use when:** the blank has one correct factual answer (e.g., `capital of France is _`).

## raw

Uses the entire LLM response as a single alternative, with no parsing.

**Use when:** the response doesn't follow a structured format, or you want the full text as-is.

## Quick reference

| Parser | Format | Output | Typical use |
|--------|--------|--------|-------------|
| `alternatives` | `INDEX:alt1,alt2` | Multiple alternatives per word | Word sources, grammar blanks |
| `compute` | `COMPUTE=expr` | Single computed number | Math blanks |
| `answer` | `ANSWER=value` | Single text value | Factual blanks |
| `raw` | (any) | Full response verbatim | Unstructured output |
