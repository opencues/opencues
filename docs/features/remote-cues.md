---
last_updated: 2026-04-06
---

# Remote Cues

Remote cues are alternatives computed externally via an LLM or other system, typically taking 200-500ms. For words not covered by local cues, remote cue sources generate alternatives by sending the input text to a language model and parsing the response.

---

## How It Works

1. **The caller invokes `CueResolver.resolve()`** with the input text and an optional `targetIndices` array to limit which words are analyzed
2. **Each `ConfigSource`** checks its `supports()` method against the context. Word-scoped sources activate when no blanks (`_`) are present; blank-scoped sources activate when blanks exist; `all`-scoped sources always activate
3. **The source formats the input** for its parser type. The `alternatives` parser sends indexed format (`0=word1 1=word2`); other parsers (`math`, `compute`, `answer`, `raw`) send the full text with `_` replaced by `BLANK`
4. **The LLM response is parsed** into `CueResult[]` keyed by word index, with alternatives, source ID, and priority
5. **Priority resolution** merges results: higher-priority sources win for the same word index; same-priority results are deduplicated and merged

---

## Source Combining

Word-scoped `alternatives` sources from `cues.md` are combined into a single `ConfigSource` via `combineWordSources()`. This produces **one LLM call instead of N sequential calls**.

The combining logic:

1. **Base sources** (no `match` regex) contribute their prompt text directly
2. **Domain sources** (with a `match` regex, e.g., `medical|clinical`) get a conditional header: `"When the input contains terms like medical, clinical: {prompt}"`
3. **Format reinforcement** — when domain sources are present, the combined prompt appends `"Output ONLY index:alternatives format."` to prevent domain instructions from disrupting the output format
4. **Priority** — the combined source takes the maximum priority of its constituents

The result is a single `SourceConfig` with `name: 'grammar'`, `scope: 'words'`, `parser: 'alternatives'`, and the concatenated prompt text.

---

## Config Fields

`ConfigSource` is constructed from a `SourceConfig` (parsed from a `### section` in a `.md` file):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | (required) | Source identifier (e.g., "grammar", "math") |
| `priority` | number | 50 | Higher wins; same-priority results merge |
| `scope` | `'words'` \| `'blanks'` \| `'all'` | `'words'` | When the source activates |
| `parser` | `'alternatives'` \| `'math'` \| `'compute'` \| `'answer'` \| `'raw'` | `'alternatives'` | How the LLM response is parsed |
| `match` | string | (none) | Regex used for two purposes: (1) by `ClassifiedSourceGroup.classifyFast()` for blank mode classification, and (2) by `combineWordSources()` to generate conditional prompt headers for domain sources. It does NOT gate `ConfigSource.supports()` directly. |
| `model` | string | (from promptConfig) | LLM model override for this source |
| `promptText` | string | (none) | The prompt template; input is appended after it |
| `enabled` | boolean | true | Set to `false` to disable without removing |

**Parser behavior:**
- `alternatives` — expects `index:alt1,alt2,alt3` lines; returns one `CueResult` per word
- `math`, `compute`, `answer` — expects a short response; maps the result to the blank (`_`) position with `max_tokens: 200` and `temperature: 0.1`
- `raw` — passes the full response as a single alternative for the blank position

---

## Portability

### Standard (cues-core)

- `ConfigSource` wraps each LLM source with priority, scope filtering (`words` or `blanks`), and response parsing
- Five parser types handle different response formats: `alternatives`, `math`, `compute`, `answer`, and `raw`
- Priority resolution is built into the resolver: higher-priority sources win, same-priority results merge with deduplication
- Scope filtering ensures blank-specific sources only activate when `_` is present in the input
- Targeted optimisation logic lives in the resolver, skipping words that already have valid alternatives

### Integration responsibilities

- Provide an `HttpAdapter` implementation for the platform (HTTPS with keep-alive, timeouts, error handling)
- Manage API keys (environment variables, config files, or credential stores) and pass them to cues-core
- Handle network errors and timeouts gracefully (e.g., show stale results, retry, or degrade to local-only)
- Wire the resolver's async results into the UI update loop so alternatives appear when ready
- Respect the targeted optimisation by not clearing valid alternatives unnecessarily between analysis runs
