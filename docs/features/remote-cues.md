---
last_updated: 2026-04-22
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

## Word-Cue Routing (replaces the old "combine into one prompt" model)

Each `### alternatives` section in `cues.md` (or `cues/<name>/cue.md`) becomes its OWN `ConfigSource`. They are wrapped in a single `RoutedWordSourceGroup` that **dispatches each highlighted word to exactly one child source** based on the source's `match` / `keywords` / `priority` fields.

Words destined for the same source are batched into one parallel LLM call; results are then index-remapped back to the original positions. So a sentence with one legal word + one medical word + three grammar words produces three parallel LLM calls, not five sequential ones and not one giant merged prompt.

Why per-word dispatch (not the old "combine into one prompt"):

- **Isolation**: a hijacking prompt in one source can no longer poison every word. With the old combine model, a prompt in `cues/sync-demo/cue.md` saying "always output `bundled,deployed,shipped`" would swap `happy → bundled`. With routing, that prompt only affects words its source is called for.
- **Scaling**: combined prompts grow linearly with source count and start confusing the LLM at ~5+ domains. Per-source calls keep each prompt small and focused.

See [Word-Cue Routing](word-cue-routing.md) for the full classification + dispatch spec, and the `RoutedWordSourceGroup` source in `@opencues/core` for the implementation.

> The legacy `combineWordSources()` export in `build-sources.ts` is a no-op shim kept only for external callers mid-migration; new code should not call it.

---

## Config Fields

`ConfigSource` is constructed from a `SourceConfig` (parsed from a `### section` in a `.md` file):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | (required) | Source identifier (e.g., "grammar", "math") |
| `priority` | number | 50 | Higher wins; same-priority results merge |
| `scope` | `'words'` \| `'blanks'` \| `'all'` | `'words'` | When the source activates |
| `parser` | `'alternatives'` \| `'raw'` | `'alternatives'` | How the LLM response is parsed |
| `match` | string | (none) | Regex used by `RoutedWordSourceGroup` to claim words for this source. Required (or `keywords:`) for word-cue sources — sources with neither are dropped. Does NOT gate `ConfigSource.supports()` directly. |
| `model` | string | (from promptConfig) | LLM model override for this source |
| `promptText` | string | (none) | The prompt template; input is appended after it |
| `enabled` | boolean | true | Set to `false` to disable without removing |

**Parser behavior:**
- `alternatives` — expects `index:alt1,alt2,alt3` lines; returns one `CueResult` per word
- `raw` — passes the full response as a single alternative for the blank position

---

## Portability

### Standard (opencues-core)

- `ConfigSource` wraps each LLM source with priority, scope filtering (`words` or `blanks`), and response parsing
- Five parser types handle different response formats: `alternatives`, `math`, `compute`, `answer`, and `raw`
- Priority resolution is built into the resolver: higher-priority sources win, same-priority results merge with deduplication
- Scope filtering ensures blank-specific sources only activate when `_` is present in the input
- Targeted optimisation logic lives in the resolver, skipping words that already have valid alternatives

### Integration responsibilities

- Provide an `HttpAdapter` implementation for the platform (HTTPS with keep-alive, timeouts, error handling)
- Manage API keys (environment variables, config files, or credential stores) and pass them to opencues-core
- Handle network errors and timeouts gracefully (e.g., show stale results, retry, or degrade to local-only)
- Wire the resolver's async results into the UI update loop so alternatives appear when ready
- Respect the targeted optimisation by not clearing valid alternatives unnecessarily between analysis runs
