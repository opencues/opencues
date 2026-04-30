---
last_updated: 2026-04-12
---

# Consume-Context Blanks

A consume-context blank is a blank that **collapses the keyword and context words between the keyword and blank**, while preserving surrounding text. The collapsed region is replaced by the blank's resolved value.

This extends [Control Blanks](cue-blanks.md) and differs from [Consume-All Blanks](consume-all-blanks.md) which clear *everything*.

---

## Concept

Standard control blanks replace only `_`. Consume-all blanks replace the entire input. Consume-context blanks replace the **keyword + context between keyword and blank**:

```
Input:  I wonder what is the word for love in Japanese _ she said
        ^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^
        prefix   keyword + context (collapsed)         blank  suffix

Result: I wonder Ai she said
```

The prefix ("I wonder") and suffix ("she said") are preserved. Only the trigger keyword and the context words between it and `_` are consumed and replaced by the answer.

---

## Config

Consume-context behaviour is enabled by two fields working together:

| Field | Purpose |
|-------|---------|
| `blankConsumeContext: true` | Expands `blankKeywordIndices` to include words between keyword and blank |
| `blankClearKeywords: true` | Enables the clearing logic that removes words at those positions |

Together, these make the keyword-clearing logic remove the keyword + context, leaving only the blank value and surrounding text.

Other fields typically used:
- `blankAutoPopulate: true` — fill blank with first result immediately
- `blankFormat: string` — bypass numeric validation
- `blankProximity: 20` — allow long context between trigger and blank

---

## Example: Answer Control

The `blanks/answer/` control uses consume-context to provide factual lookups:

```yaml
---
name: answer
type: control
control: answer
blankKeywords: what is the word for
blankConsumeContext: true
blankClearKeywords: true
blankAutoPopulate: true
blankFormat: string
blankScript: ./answer-blank.sh
blankTip: Answer
blankProximity: 20
---
```

Usage:
```
what is the word for love in Japanese _      → Ai
what is the word for goodbye in Spanish _    → Adiós
what is the word for thank you in Korean _   → 감사합니다
```

With surrounding text preserved:
```
I wonder what is the word for hello in French _ she said
→ I wonder Bonjour she said
```

---

## How It Works

1. **Keyword match**: The multi-word keyword "what is the word for" is found in the input
2. **Context identification**: Words between the keyword end and the blank position are identified as context
3. **Index expansion**: `blankConsumeContext` adds all indices from keyword start to blank (exclusive) into `blankKeywordIndices`
4. **Script call**: The blank script receives the keyword + context as arguments, calls the LLM
5. **Auto-populate**: The blank is filled with the answer
6. **Keyword clearing**: All words at expanded `blankKeywordIndices` are removed from the text
7. **Result**: Only the answer and any surrounding text (before keyword or after blank) remain

---

## Comparison

| Mode | Input | Result |
|------|-------|--------|
| Standard blank | `volume _` | `volume 50` |
| `blankClearKeywords` | `volume _` | `50` (keyword cleared) |
| `blankConsumeAll` | `improve write a poem _` | `Compose a moving sonnet...` (everything cleared) |
| **`blankConsumeContext`** | `I think define ephemeral _` | `I think lasting a very short time` (context collapsed, prefix kept) |

---

## Implementation

In `control-blank-source.ts`:

```typescript
if (matched.blankConsumeContext) {
  const kwStart = matchedKeywordIndex;
  const kwEnd = kwStart + (matchedKeyword?.split(/\s+/).length ?? 1);
  const rangeStart = Math.min(kwStart, blankIndex);
  const rangeEnd = Math.max(kwEnd, blankIndex);
  for (let i = rangeStart; i < rangeEnd; i++) {
    if (i !== blankIndex && !matchedKeywordIndices.includes(i)) {
      matchedKeywordIndices.push(i);
    }
  }
}
```

This expands `blankKeywordIndices` to cover the range between keyword and blank. The existing `blankClearKeywords` logic in `wordHighlight.ts` then removes all words at those indices during auto-populate.
