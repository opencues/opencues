---
last_updated: 2026-06-18
---

# Consume-Context Blanks

A consume-context blank is a blank that **collapses the keyword and context words between the keyword and blank**, while preserving surrounding text. The collapsed region is replaced by the blank's resolved value.

This extends [Cue-Blanks](cue-blanks.md) and differs from [Consume-All Blanks](consume-all-blanks.md) which clear *everything*.

> **Note:** the canonical example below — the `answer` blank (`what is the word
> for X _`) — was **retired in June 2026**. Factual `_` lookups are now served
> by the generalized `FluidBlankSource` (see [cue-blanks](cue-blanks.md) §
> fluid blanks and the glossary's FluidBlankSource entry; incl. `answer _`
> meta-triggers), which runs on the user's configured provider and
> scopes its own replacement span. The `blankConsumeContext` mechanism itself
> is unchanged and still available to custom keyword-bound blanks; the example
> is kept as an illustration of that mechanism.

---

## Concept

Standard cue-blanks replace only `_`. Consume-all blanks replace the entire input. Consume-context blanks replace the **keyword + context between keyword and blank**:

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

## Example: Answer Blank (retired)

The `blanks/answer/` blank — **retired June 2026**, intent moved to
`FluidBlankSource` — used consume-context to provide factual lookups. Its
frontmatter is preserved below to illustrate how a consume-context blank is
configured; a new custom consume-context blank would follow the same shape.

```yaml
---
# blanks/answer/ — no longer shipped; shown only as a config illustration
name: answer
type: blank
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
| `blankConsumeAll` | (a custom whole-buffer blank) | result replaces everything (entire input cleared) |
| **`blankConsumeContext`** | `I think define ephemeral _` | `I think lasting a very short time` (context collapsed, prefix kept) |

---

## Implementation

In `blank-source.ts`:

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

This expands `blankKeywordIndices` to cover the range between keyword and blank. The existing `blankClearKeywords` logic in `@opencues/runtime` then removes all words at those indices during auto-populate.
