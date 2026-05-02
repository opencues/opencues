---
last_updated: 2026-04-07
---

# Porting OpenCues to a New Integration

This guide documents the contract between opencues-core and integrations, plus non-obvious behaviours and pitfalls discovered during the Claude Code implementation. Read this before building a Chrome extension, VS Code extension, or any new integration.

---

## What opencues-core provides (portable)

opencues-core is pure TypeScript with no I/O dependencies. It provides:

- **Config parsing** — `parseCuesMd()`, `parseSingleCueMd()`, `discoverFolderConfigs()`
- **Source building** — `buildSourcesFromConfig()` returns `CueSource[]` from parsed configs
- **Resolution** — `CueResolver.resolve()` queries sources and merges results
- **Local lookup** — `lookupMultiple()`, `buildLookupMap()` for O(1) tips lookup
- **Response parsing** — `parseAlternatives`, `parseRaw`

The integration provides I/O adapters (HTTP, filesystem) and handles all rendering, navigation, and user interaction.

---

## CueResult contract

Every source returns `CueResult[]`. This is the core data structure integrations consume:

```typescript
{
  wordIndex: number;          // Position in input words array (0-indexed)
  word: string;               // The actual word at this position
  alternatives: string[];     // Values to cycle through
  cueTip?: string;            // Tip text for secondary display
  altCueTips?: Record<string, string>;  // Per-alternative tips
  linked?: number[];          // Other word indices that cycle together
  source: string;             // Source ID ('tips', 'grammar', 'blank', etc.)
  priority: number;           // For merge resolution (higher wins)
  spanStart?: number;         // Multi-word span start index
  spanEnd?: number;           // Multi-word span end index (exclusive)
  metadata?: Record<string, unknown>;   // Source-specific data
}
```

Integrations convert `CueResult` to their internal word definition format (Claude Code uses `WordDef`).

---

## Integration responsibilities

### 1. HTTP adapter

opencues-core's `ConfigSource` needs an HTTP adapter for LLM calls:

```typescript
interface HttpAdapter {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}
```

For Chrome: use `fetch()`. For Node.js: use the provided `NodeHttpAdapter` (HTTPS with keep-alive).

### 2. Filesystem adapter (for folder discovery)

`discoverFolderConfigs()` needs `readFile` and `readDir` callbacks. For Chrome: these could read from IndexedDB, a bundled config, or a server endpoint.

### 3. Rendering

The integration must:
- **Dim** words that have alternatives (navigable positions)
- **Highlight** the currently selected word (bold/underline/color)
- **Replace text** when cycling through alternatives

### 4. Navigation

Ctrl+Alt+Left/Right (or equivalent) moves between navigable words. A word is navigable if:
- It has alternatives (`alts.length > 1`)
- It's a cue-blank keyword (registered in `blanksByWord`)
- It has `metadata.blankName` (cue-blank-bound value — **exception: navigable with 1 alt**)
- It's part of a multi-word span (navigable at the span's original index)

### 5. Cycling

Up/Down at a navigable position cycles alternatives. Priority order:
1. **Cue-blank values** (`metadata.blankName`) — call `blankInvoke` (`up`/`down`/`set`), then `get` for the new value
2. **Consume-all spans** — cycle the dedicated `_consumeAllAlts` storage
3. **Alternative cycling** — cycle through `alternatives` array

### 6. Auto-submit (analysis trigger)

The integration decides WHEN to send text to the resolver. Claude Code uses a three-tier debounce:
- Space typed → 50ms delay
- 300ms pause → final word analyzed
- Word edited → 50ms delay

The specific timing is integration-choice, but the trigger must call `resolver.resolve(context)` with the current text and words.

---

## Critical behaviours to implement correctly

### Scope filtering (words vs blanks)

**This is the most important thing to understand.**

Sources have a `scope` field: `'words'`, `'blanks'`, or `'all'`.

- When the input contains ANY `_` character: only `scope: 'blanks'` and `scope: 'all'` sources run. Word-scoped sources (grammar, domain cues) are **silently disabled**.
- When the input has NO `_`: only `scope: 'words'` and `scope: 'all'` sources run. Blank-scoped sources are disabled.

This means typing a `_` completely changes which LLM prompts fire. This is intentional — blanks need the full sentence context for classification, while word alternatives need per-word analysis.

### Priority and merge logic

Sources are queried in priority order (highest first). When two sources return results for the same word:
- **Higher priority wins** — lower priority result is discarded
- **Same priority** — alternatives are deduplicated and merged (case-sensitive)

Key priorities: `BlankSource` (95) > `FluidBlankSource` (92) > `SpellingSource` (80) > `ConfigSource`/word-cues (50-75)

### Tips protection

When merging results, entries from `source: 'tips'` (local tips file) are NEVER overwritten by LLM results. Similarly, entries with `metadata.blankName` (blanks) are protected from grammar/LLM overwrite. The integration's merge logic must respect these protections.

### Linked word cycling

The `linked` array on a CueResult means: when this word cycles, ALL words at the linked indices must cycle to the same `currentAltIndex`. For example, changing "boy" (index 0, alts: ["boy", "girl"]) must also change "his" (index 3, alts: ["his", "her"]) from index 0 to index 1.

The integration must:
1. Detect `linked` arrays on WordDefs
2. When cycling any word with `linked`, update ALL linked words' `currentAltIndex`
3. Replace ALL linked words' text in the display simultaneously

### Multi-word spans

When an alternative contains spaces (e.g., "Sundar Pichai" replacing "Sundar"), the integration must:
1. Track `spanStart` and `spanEnd` from the CueResult
2. Create a span map: indices within the span redirect navigation to the span's original index
3. When cycling, replace ALL words in the span range, not just the highlighted word
4. Non-original span positions (e.g., "Pichai" at index 6) should NOT be independently navigable

### Blank dispatch order

When a `_` is present, sources fire in priority order (highest first):
1. **`BlankSource` (95)** — keyword-bound. If any registered blank's `blankKeywords` matches a phrase within `blankProximity` words of the `_`, that blank claims the slot. Auto-populates via the blank's script or runtime class.
2. **`FluidBlankSource` (92)** — free-form lookup. Two-pass LLM (P1 SEGMENT + P3 ANSWER) for any `_` no keyword-bound blank claimed.

The host's responsibility is to pass the full text + word indices through to the resolver and splice the `_` substitution into place when the result arrives. The host doesn't need to know which source fired — `CueResult.source` carries that information.

### Per-word clearing

When the user edits a word (e.g., "dog" → "do"), the integration should:
- Keep the WordDef in memory (don't discard alternatives)
- Mark the word as non-navigable (the text no longer matches any alternative)
- When the user restores the word (types "g" back), the alternatives become valid again immediately (no LLM re-fetch)

This avoids 200-500ms delays on every keystroke. The WordDef persists, keyed by position index.

---

## Pitfalls and edge cases

### Parser format sensitivity

Each blank mode has a `parser` type. The parser expects a specific LLM response format:

| Parser | Expected format | Example |
|--------|----------------|---------|
| `alternatives` | `INDEX:alt1,alt2,alt3` | `0:happy,sad,excited` |
| `raw` | Full response verbatim | `The answer is 42.` |

If the parser doesn't match the response format, it silently returns empty results. No error is raised. The prompt and parser type MUST agree.

### `parseAlternatives` skips cue-blank keyword positions

If a word at position N is a registered cue-blank keyword, the LLM analysis pipeline skips it — the keyword is the trigger, not a candidate for synonyms.

### Blanks: only first `_` is bound

If the input has multiple underscores (e.g., `set _ to _`), only the FIRST `_` is bound to the cue-blank. The second stays as a regular blank.

### Cache invalidation for blanks

When `_` reappears at a position that previously had a cue-blank-bound value, the old WordDef must be cleared and the resolver must re-run. Without this, the stale value persists.

### Hot-reload is integration-specific

opencues-core's parsers are stateless — call `parseCuesMd()` any time to re-parse. The caching/TTL logic (how often to re-read `.md` files) is entirely the integration's responsibility. Claude Code uses a 2-second TTL. A Chrome extension might use file watchers, storage events, or manual refresh.

---

## Blanks: additional integration notes

See `docs/features/cue-blanks.md` for the full spec. Key integration points:

1. **`blankInvoke` capability** — the host adapter implements a registry-then-spawn dispatcher. `blankInvoke({ blankName, action: 'get'|'set'|'up'|'down', args })` returns the result. Registered TS-class blanks handle it directly; unregistered ones fall through to `spawnProcess` of `blankScript`. Validation is config-driven by `blankFormat`.
2. **Result filter exception** — blank results have only 1 alternative but must pass through (normal filter requires >1).
3. **Tip isolation** — `blankTip` (if set) is the ONLY tip shown for regular cue-blank values. Selector/satellite blanks use the `tips:` block from `opencues.md` instead. Grammar/LLM tips cannot override any position with `metadata.blankName`. See `docs/features/tip-priority.md` for the full resolution order.
4. **Cycling runs synchronously** — `blankInvoke({ action: 'up' })` runs synchronously, then `blankInvoke({ action: 'get' })` is called for the new value before updating the display.
5. **Ownership model (critical)** — `metadata.blankName` must only be cleared by user edits, never by LLM results. Two separate code paths:
   - **User edit** (text-change detection in render cycle): if the word at a blank position changed, clear `metadata` — the user "unlocked" it. Also clear metadata for positions beyond the new text length (word removal).
   - **LLM merge** (resolver callback): if existing WordDef has `metadata.blankName` and the incoming result is NOT a blank result, skip the merge — preserve the cue-blank.
   - Getting this wrong causes either (a) grammar overwriting live cue-blank values, or (b) permanently stuck blank positions the user can't reclaim. See `docs/features/cue-blanks.md` § "Ownership Model" for the full explanation.
6. **Keyword clearing** — when `blankClearKeywords: true`, keyword context words are removed from the text during auto-populate (only the resolved value remains). When `blankClearOnEdit: true`, editing the populated value to something not in alts removes the spawned words entirely. Keywords can be multi-word phrases (e.g. `opencues settings` as one entry in `blankKeywords`).
