---
last_updated: 2026-04-06
---

# Fill-in-the-Blank

Typing `_` (underscore) creates a blank that the system fills contextually. Blanks use a separate classification and prompting pipeline from regular word alternatives, because a blank needs a different word **type** than its neighbours (e.g., "The _ dog" needs an adjective), whereas regular alternatives stay the same type (e.g., "beautiful" to "gorgeous").

---

## How It Works

1. **Detect**: The user types `_` anywhere in the input
2. **Scope filter**: Sources with `scope: 'blanks'` activate; sources with `scope: 'words'` deactivate (see Scope Filtering below)
3. **Classify**: `ClassifiedSourceGroup` determines the blank mode (math, factual, grammar) via fast heuristics, then LLM fallback
4. **Prompt**: The winning child `ConfigSource` sends its mode-specific prompt to the LLM
5. **Parse**: The response is parsed by the mode's parser type (math, compute, answer, alternatives, raw)
6. **Result**: Alternatives are attached to the `_` position and the user can cycle through them

---

## Scope Filtering

Every `ConfigSource` has a `scope` field (`'words'`, `'blanks'`, or `'all'`) that gates whether the source runs for a given input. The check is in `ConfigSource.supports()`:

| Scope | Condition | Purpose |
|-------|-----------|---------|
| `words` | No word in the input equals `_` | Regular word alternatives. Deactivates when a blank is present so grammar prompts do not interfere with blank filling |
| `blanks` | At least one word equals `_` | Blank-fill modes. Only activates when a blank is present |
| `all` | Always true | Sources that apply regardless (e.g., linked words) |

The check is literal string equality (`w === '_'`), not a regex. A word must be exactly `_` to trigger blank mode.

---

## Classification Pipeline

`ClassifiedSourceGroup` wraps the child `ConfigSource` instances (one per blank mode) and selects exactly one per input. The modes are mutually exclusive.

### Fast path (regex + keywords)

Each child source can declare `match` (a regex) and `keywords` (comma-separated terms) in its `.md` config section. `classifyFast()` iterates all entries and returns the highest-priority match:

1. **Regex**: `entry.matchRe.test(text)` against the full input (case-insensitive)
2. **Keywords**: Word-boundary substring match in the lowercased input. Both left and right boundaries must be non-alphanumeric or string edges. This prevents "frenchtoast" from matching the keyword "french"

The highest-`priority` match wins. If no entry matches, fast classification returns `null`.

### LLM fallback

If the fast path returns `null` and a `classifierPrompt` is configured (from `### classifier` in `blanks.md`):

1. The classifier prompt is sent to the LLM with `max_tokens: 200`, `temperature: 0.1`, `reasoning_effort: 'low'`
2. The response is scanned for `MODE=<name>` (case-insensitive) in the `content` field first, then the `reasoning` field
3. If a mode name matches a child source, that source is returned

### Default fallback

If both fast and LLM classification fail, the source named `'grammar'` is used. If no source is named `'grammar'`, the last child source is the default.

### Misclassification recovery

If the classified source returns zero results and it is not the default, `getCues()` falls back to the default source. This handles cases where the LLM classifier picks the wrong mode.

---

## Parser Types

Each `ConfigSource` uses a `parser` field to select how the LLM response is interpreted. The parser determines both the input format sent to the LLM and the output extraction.

| Parser | Input format | Response format | Evaluator | Use case |
|--------|-------------|-----------------|-----------|----------|
| `math` | Text with `_` replaced by `BLANK` | `COMPUTE=<expression>` | Safe recursive-descent (no `eval()`) supporting `+ - * / % ()` | Arithmetic: "4 * 12 = _" |
| `compute` | Text with `_` replaced by `BLANK` | `COMPUTE=<expression>` | `Function()` (unsafe, supports full JS expressions like `Math.pow`) | Advanced math only in trusted environments |
| `answer` | Text with `_` replaced by `BLANK` | `ANSWER=<value>` | Literal string extraction, capped at 100 characters | Factual: "Capital of France is _" |
| `alternatives` | Indexed format `0=word1 1=word2` | `INDEX:alt1,alt2,alt3` per line | Regex extraction, original word prepended for non-blank positions | Grammar fill and regular word alternatives |
| `raw` | Text with `_` replaced by `BLANK` | Full response used verbatim | Trimmed string | Free-form single-answer blanks |

For `math`, `compute`, and `answer` parsers, the result is always a single alternative attached to the first `_` position. The `alternatives` parser can return results for multiple word positions.

---

## Portability

### Standard (cues-core)

- `ClassifiedSourceGroup` uses fast heuristics followed by LLM classification to detect blank type (math, factual, grammar)
- Sources with `scope: 'blanks'` activate only when `_` is present in the input
- Sources with `scope: 'words'` deactivate when `_` is present, preventing interference
- Blank modes are mutually exclusive: only one classifier wins per analysis
- Separate prompts for blank filling vs. regular alternatives are built into the source definitions
- Five parser types handle different response formats; `math` uses a safe evaluator, `compute` uses `Function()`
- Misclassification recovery falls back to the default source when the classified source returns no results

### Integration responsibilities

- Detect the presence of `_` in user input and pass the full text to the resolver for classification
- Track context around blanks so that changes (e.g., editing adjacent words) trigger re-analysis via the resolver
- Display blank-fill results the same way as regular alternatives (cycling, secondary display)
- Ensure cycling the blank itself does NOT trigger context invalidation (only surrounding word changes do)
- Handle the async nature of blank classification: show a loading state or defer display until results arrive
