---
last_updated: 2026-04-22
---

# Local Cues

Alternatives computed locally on your machine, returning near-instantly (~0ms). A local cue source provides both alternatives (for cycling) and cue-tips (for the secondary display) without any LLM round-trip.

---

## How It Works

1. **Load**: At startup, each `cues/<name>/CUE.md` with a body JSON code block is parsed by `parseSingleCueMd()`. The body's JSON shape matches `LocalCueData`; the runtime aggregates these per-folder entries. (For standalone use, `parseLocalCueFile()` parses the same shape from a bare JSON string.)
2. **Build map**: `buildLookupMap(localCueData)` constructs an O(1) hash map in two passes (see Lookup below). The runtime stores it as `ConfigLoader.cueMap`.
3. **Resolve**: On each analysis trigger, `lookupMultiple()` runs first against the hash map. Words with matches get instant alternatives and cue-tips. Words without matches are collected in `missingIndices` for LLM fallback
4. **Merge**: `mergeWordDefs()` combines local results with LLM results. Local entries (source `"tips"`) are protected from overwrite (see Merge Behaviour)
5. **Hot-reload**: Folder configs are re-discovered on the next config-load cycle and `cueMap` is rebuilt from scratch — deletions take effect immediately.

Words in the same sentence can have different sources: "quick" served by the LLM, "ultrathink" served locally.

---

## Data Format (LocalCueData)

`LocalCueData` is an array of `LocalCueSection` objects. Each section has an `id` and contains entries in one or both formats:

### Groups format

Synonym groups share a tip. Alternatives point to other concepts:

```json
{
  "id": "parallel-execution",
  "groups": [{
    "synonyms": ["agents", "sub-agents", "spawn"],
    "tip": "Spawn parallel workers via Task tool",
    "alts": ["swarm", "background"],
    "speak": true
  }]
}
```

All synonyms in the group map to the same lookup result. The `alts` array contains words from other sections (cross-references resolved at build time).

### Words format

Individual word entries:

```json
{
  "id": "extended-thinking",
  "words": {
    "ultrathink": {
      "tip": "Add 'ultrathink' for max reasoning",
      "alts": ["Tab", "deep thinking"],
      "speak": true
    }
  }
}
```

### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `speak` | boolean | `undefined` (falsy, treated as no TTS) | When true, the tip is read aloud via TTS on navigation |
| `alts` | string[] | required | Alternative words the user can cycle to |
| `tip` | string | required | Cue-tip text shown in the secondary display |

---

## Lookup (O(1) Hash Map)

`buildLookupMap()` builds the hash map in two passes for O(n) total construction:

**Pass 1** -- Primary entries:
- For each group, create one `LocalCueLookupResult` and map every synonym (lowercased) to it
- For each word entry, map the key (lowercased) to its result
- Queue all `alts` arrays for cross-reference resolution

**Pass 2** -- Alt cue-tips:
- For each queued entry, look up each alt in the map (`O(1)` per lookup) and copy its `cueTip` into the entry's `altCueTips` record

At runtime, `lookupMultiple()` iterates the input words and calls `map.get(word.toLowerCase())` for each. It returns:

| Field | Type | Description |
|-------|------|-------------|
| `found` | `WordDef[]` | Words with local matches, fully populated with `alts`, `cueTip`, `altCueTips`, `speak`, and `source: 'tips'` |
| `missingIndices` | `number[]` | Word positions with no local match, passed to LLM sources |

Words matching `skipPattern` (e.g., `_` for blanks) are silently skipped. Words rejected by `skipFn` (e.g., cue-blank keywords) are added to `missingIndices`.

---

## Merge Behaviour

`mergeWordDefs()` combines existing definitions with new ones. The rule is: **new fills gaps, never overwrites existing non-null fields**.

```typescript
if (!existingDef.alts && newDef.alts) existingDef.alts = newDef.alts;
if (!existingDef.cueTip && newDef.cueTip) existingDef.cueTip = newDef.cueTip;
if (!existingDef.altCueTips && newDef.altCueTips) existingDef.altCueTips = newDef.altCueTips;
if (!existingDef.source && newDef.source) existingDef.source = newDef.source;
if (!existingDef.metadata && newDef.metadata) existingDef.metadata = newDef.metadata;
```

Because local results run first and populate `alts`, `cueTip`, and `source`, LLM results arriving later cannot overwrite them. This means tips are curated -- the LLM never replaces a locally defined tip or alternative set.

Additionally, the integration layer (`@opencues/runtime`) enforces this at merge time: when processing LLM results, it checks `if (_oldW2 && _oldW2.source === "tips") continue;` to skip LLM results entirely for tip-sourced words.

---

## Portability

### Standard (opencues-core)

- `LocalCueSource` implements `CueSource` with `lookupWords()` for batch word lookup via the `getCues()` method
- `buildLookupMap()` constructs an O(1) hash map from the tips data at load time
- `lookupMultiple()` returns found `WordDef[]` and `missingIndices` for LLM fallback
- `LocalCueData` format supports both `groups` (shared tip, synonym sets) and `words` (individual entries)
- `speak: true` flag is preserved per entry and propagated to `WordDef.speak`
- Local results have `source: "tips"` and are protected from LLM overwrite during merge
- `parseLocalCueFile()` handles both plain array and wrapper object formats

### Integration responsibilities

- Discover `cues/<name>/CUE.md` folders at startup; aggregate parsed `LocalCueData` from any folder whose body is a JSON words map, and pass to `buildLookupMap()` (or, for standalone tips data, parse directly with `parseLocalCueFile()`)
- Store the resulting map (the runtime exposes it as `ConfigLoader.cueMap`) for use during navigation and cycling
- Run local lookup before LLM sources so that local results are in place before merge
- Merge local and LLM results using `mergeWordDefs()`, ensuring tip-sourced words are never overwritten
- Handle per-alternative cue-tips by reading the `altCueTips` record when the user cycles to a different alt
- Trigger TTS for words where `speak` is true when the user navigates to them
- Support hot-reload by re-discovering folder configs and rebuilding the map when any source folder changes
