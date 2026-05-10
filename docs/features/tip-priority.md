---
last_updated: 2026-04-09
---

# Tip Priority

Every highlighted word can show a tip in the secondary display (status line). Tips come from multiple sources. When a word matches more than one source, a fixed priority order determines which tip wins.

---

## Priority Table

| Priority | Word type | Example | Tip shown | Source |
|---|---|---|---|---|
| 1 | Satellite (per-value) | `active` under selector `voice-mode` | "TTS reads tips aloud on navigation" | `CUES.md` `settings:` block, nested value line |
| 2 | Satellite (fallback) | `on` under selector `debug-mode`, no per-value tip defined | "Enable debug logging output" | `CUES.md` `settings:` block, setting-level line |
| 3 | Selector | `voice-mode` | "Gates TTS globally" | `CUES.md` `settings:` block, setting-level line |
| 4 | Cue-blank value | `72` after `volume` | "System volume" | Blank's `BLANK.md` `blankTip` field |
| 5 | Cue-blank keyword | `volume` (the trigger word) | "85" (live reading) | `blankInvoke get` output; falls back to `tip` in `BLANK.md` |
| 6 | Local cue (folder-based) | `ultrathink` | "Add 'ultrathink' to prompt for max reasoning" | `cues/<name>/CUE.md` body JSON via `cueMap` (built in `ConfigLoader`) |
| 7 | LLM-analyzed word | `happy` | "glad, joyful, content" | LLM response via opencues-core resolver |

---

## How Priority Is Enforced

### Display path (which tip is shown)

The navigation export code checks three branches in order. The first match wins; the rest are skipped:

1. **Blank-bound word** — the WordDef has `metadata.blankName` set (auto-populated by the blank pipeline)
   - Selector/satellite sub-branch (`metadata.selectorWord` or `metadata.satelliteWord`): reads `CUES.md` `settings:` block (priorities 1-3)
   - Regular cue-blank value: reads `cueTip` from the WordDef, set by `blankTip` in the blank's `BLANK.md` (priority 4)
2. **Cue-blank keyword** — the word text matches a registered `blankKeywords` entry
   - Calls `blankInvoke({ action: 'get' })` for a live reading; falls back to `tip` from `BLANK.md` (priority 5)
3. **General word** — no blank metadata, not a cue-blank keyword
   - Reads `cueTip` from `_dynDefs`, populated by local cue lookup or LLM analysis (priorities 6-7)
   - Local cues resolve instantly (~0ms); LLM results arrive asynchronously and overwrite if they carry a tip

The guard that prevents branch 3 from overriding branches 1-2 is the `!_cbDw` and `!_isCA` condition on the general branch. Blank-bound words and cue-blank keywords are never read from `_dynDefs` for display.

### Analysis path (which words get sent to the LLM)

The same word types are protected from unnecessary LLM analysis, but using different mechanisms that achieve the same result:

| Word type | How it's skipped | Mechanism |
|---|---|---|
| **Cue-blank keyword** | blank-keyword check | Explicit skip before the `_hasAlts` check |
| **Cue-blank value** (including selector/satellite) | `_hasAlts` check | WordDef already has `alts.length > 1` from auto-populate, so it's treated as already resolved |
| **Local cue match** | `_tipsHandled` check | `lookupMultiple` found a match in `_localCueMap`, so no LLM needed |
| **Common word** (the, a, is, ...) | Stopword regex | Hard-coded skip list |
| **Ignored word** | `_cuesIgnoreWords` set | User-authored `ignore:` array in `CUES.md` frontmatter |

The result is consistent: blank-bound words, cue-blank keywords, and locally-resolved words are never sent to the LLM, and their tips are never overwritten by LLM results.

### Cycling path (which tip is shown after cycling)

When a word is cycled, the tip is updated inline within each cycling branch:

- **Selector cycling**: reads `_openCuesTips[nextSetting]`
- **Satellite cycling**: reads `_openCuesSatTips[setting][newValue]`, falls back to `_openCuesTips[setting]`
- **Regular cue-blank cycling**: tip is unchanged (stays as `blankTip` from `BLANK.md`)
- **General word cycling**: `cueTip` stays from the WordDef; `altCueTips[newAlt]` replaces it in the export if present

---

## The `CUES.md` Settings Block

Settings, valid values, and tips are defined together in `CUES.md` frontmatter under a unified `settings:` block. Each setting is self-contained:

```yaml
---
version: 1
voice-mode: active
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud on navigation
      inactive: TTS is silenced
---
```

- **Setting name**: any indented line with a key and no value after the colon (e.g. `voice-mode:`)
- **`tip:`**: reserved key — selector tip shown when this setting is highlighted
- **`values:`**: reserved key — opens the valid-values block
- **Value entries**: any line inside `values:` with a key and value (e.g. `active: TTS reads tips aloud`)

Indentation depth does not matter — the parser detects structure by key names and whether a value is present after the colon, not by counting spaces.

The parser hydrates two globals on every hot-reload cycle:

| Global | Type | Contents |
|---|---|---|
| `_openCuesTips` | `Record<string, string>` | Setting name to selector tip (from `tip:` lines) |
| `_openCuesSatTips` | `Record<string, Record<string, string>>` | Setting name to { value: tip } (from value entries) |
| `_openCuesSettings` | `Record<string, string[]>` | Setting name to list of valid values (keys from value entries) |

Satellite tip resolution: `_openCuesSatTips[setting][value]` first, then `_openCuesTips[setting]` as fallback.

---

## Portability

### Standard (opencues-core)

- `CueResult.cueTip` carries the primary tip for any word
- `CueResult.altCueTips` maps each alternative to its own tip (for per-alt display during cycling)
- Cue-blanks use `blankTip` from the blank's config
- Selector/satellite tips are read from `CUES.md` frontmatter `settings:` block, not from per-cue `CUE.md` files

### Integration responsibilities

- Implement the three-branch display priority: blank-bound words first, then cue-blank keywords, then general words
- Ensure blank-bound words and cue-blank keywords are excluded from LLM analysis (either by explicit skip or by the `_hasAlts` guard)
- For selector/satellite words, read tips from the backing config's `settings:` block and hot-reload them
- Update the cycling tip inline within each cycling branch — don't rely on a separate refresh
- When no tip resolves for a word, suppress the secondary display entirely (don't show an empty tip)
