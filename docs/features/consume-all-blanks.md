---
last_updated: 2026-04-10
---

# Consume-All Blanks

A consume-all blank is a blank that **clears all surrounding text** when it auto-populates and replaces it with a multi-word result. The user can cycle through alternative results as a single word group.

This extends [Cue-Blanks](cue-blanks.md) with a new pattern: instead of replacing just `_`, the entire input is consumed — activation keywords, prompt text, and the blank are all replaced by the result.

---

## Concept

Standard cue-blanks replace `_` with a value (e.g., `volume _` → `50`). Consume-all blanks replace **everything**:

```
Input:  write a poem about love improve prompt _
Result: Compose a deeply moving sonnet exploring the transformative power of love
```

The activation keywords (`improve prompt`) and the original text (`write a poem about love`) are all cleared. The result is a multi-word span that the user can cycle through alternative versions of.

---

## Config

Consume-all behaviour is enabled by two fields working together:

| Field | Purpose |
|-------|---------|
| `blankConsumeAll: true` | Expands `blankKeywordIndices` to include ALL non-blank word positions |
| `blankClearKeywords: true` | Enables the clearing logic that removes words at those positions |

Together, these make the existing keyword-clearing logic remove everything, not just keywords.

Other fields typically used:
- `blankAutoPopulate: true` — fill blank with first result immediately
- `blankFormat: string` — bypass numeric validation
- `blankDismissible: true` — add `_` as final cycling option

---

## Data model

### Input to the blank

The blank receives ALL context words (minus `_`). The implementation is responsible for separating activation keywords from useful content. This typically requires a multi-step process (e.g., an LLM extraction step).

### Output from the blank

The script returns multiple lines (newline-separated). Each line becomes a cycling alternative via the existing dynamic list pattern.

### Cycling state

Consume-all results require **dedicated cycling storage** (`_consumeAllAlts` in Claude Code) because the standard `_dynDefs` WordDef array is overwritten by tips/grammar analysis after the text changes.

---

## Integration responsibilities

An integration implementing consume-all blanks must:

1. **Clear all words** — use the expanded `blankKeywordIndices` from `BlankSource` (which includes every non-blank index when `blankConsumeAll` is true)
2. **Store alternatives independently** — dedicated storage that survives analysis cycles
3. **Cycle as a word group** — replace the full span on each cycle, not individual words
4. **Protect spans from per-word clearing** — skip consume-all positions in per-word invalidation
5. **Render full span highlight** — extend the highlight across all words in the span, not just the origin

---

## Example: Prompt Improver

```
blanks/prompt/
  cue.md              # Config: blankConsumeAll, keywords (improve prompt, enhance prompt, refine prompt)
                      # Implementation: @opencues/runtime PromptImproverBlank
                      # (packages/opencues-runtime/src/blanks/prompt-improver.ts)
```

The implementation is a TypeScript class in `@opencues/runtime` (post the
blanks hoist refactor). It performs a two-step LLM pass: extract
prompt/conditions from the activation keywords, then generate 3 improved
versions. Returns newline-separated output, which the consume-all pipeline
treats as cycling alternatives.

**Usage:**
- `write a poem about love improve prompt _` → improved prompt (3 alternatives + original to cycle)
- `improve prompt _ write a poem about love make it rhyme` → improved prompt respecting conditions
- Cycle past last improved version → original prompt text (without activation keywords)

**Original prompt preservation:** The class includes the extracted original prompt (minus activation keywords) as the last cycling alternative. This lets the user always get back to their original text without dismissing to `_`. The extraction step already separates the prompt from keywords, so the original is available at no extra cost.

