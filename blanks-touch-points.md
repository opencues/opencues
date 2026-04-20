# Blanks Touch-Points

Complete map of every place "blanks" (the `_` placeholder system) are referenced, for assessing standalone extraction.

---

## 1. opencues-core Source

### Blank-Only Files (clean extraction)

| File | Lines | What |
|------|-------|------|
| `sources/classified-source-group.ts` | Entire (191 lines) | Blank mode classification — regex → keywords → LLM classifier. Picks one mode per input. |
| `sources/control-blank-source.ts` | Entire (257 lines) | Control-bound blanks — keyword matching, auto-populate, step/list/satellite/dynamic list paths. |

### Shared Files (blank logic mixed with word logic)

| File | Blank-Specific Lines | What |
|------|---------------------|------|
| `cues-md.ts` | ~100-148 (ControlConfig), ~499-540 (SingleCueFrontmatter), ~585-610 (parsing), ~666-692 (wiring) | 19 `blank*` fields on interfaces + parsing + assembly. Word-alt fields are separate. |
| `sources/config-source.ts` | ~86-91 (supports), ~105-107 (max_tokens), ~138-150 (formatInput) | `scope` filtering, `BLANK` formatting, parser-specific settings. Rest is shared. |
| `sources/build-sources.ts` | ~117-161 | ClassifiedSourceGroup construction + ControlBlankSource construction. Word combining is ~89-115. |
| `sources/parsers.ts` | ~135-148 | `parseAlternatives()` — blank positions get alts without prepending original word. |
| `types.ts` | ~62-63 | `blankIndices?: number[]` on CueContext. Generic otherwise. |

### Tests

| File | Status |
|------|--------|
| `sources/classifier.test.ts` | Blank-only (196 tests) |
| `sources/parsers.test.ts` | ~144 lines blank-specific, rest shared |
| `sources/build-sources.test.ts` | Mixed — blank handling interspersed |

---

## 2. Claude Code Patches

| File | Blank-Specific Lines | What |
|------|---------------------|------|
| `dynamicHighlight.ts` | ~137-139 (load blanks.md), ~153 (`_blanksMdParsed`), ~160 (`_blanksEnabled`), ~225-228 (build with blanks), ~328-350 (control-blank cycling), ~1050-1057 (`_pendingAutoPopulate`), ~1417-1426 (`_pendingClearOnEdit`) | Config loading, resolver build, blank cycling, auto-populate trigger, pair cleanup. |
| `wordHighlight.ts` | ~670-729 (auto-populate + keyword clearing), ~560-574 (control-blank status display), ~770-779 (selector+satellite WordDef assembly) | Auto-populate insertion, keyword expansion, blankClearKeywords, blankClearOnEdit consumer. |

---

## 3. Config Files

| File | Status |
|------|--------|
| `blanks.md` | Entire file — 10 blank modes + classifier |
| `controls/volume/cue.md` | `blank*` fields (blankKeywords, blankStep, blankAutoPopulate, blankSuffix, blankScript) |
| `controls/brightness/cue.md` | `blank*` fields |
| `controls/stocks/cue.md` | `blank*` fields (blankReadOnly, blankClearKeywords, blankProximity) |
| `controls/weather/cue.md` | `blank*` fields |
| `controls/hackernews/cue.md` | `blank*` fields (blankDismissible) |
| `controls/opencues/cue.md` | `blank*` fields (blankSatellite, blankClearKeywords, blankClearOnEdit) |
| `controls/*/volume-blank.sh` etc. | 6 blank-specific scripts (get/set commands) |

---

## 4. Documentation

### Blank-Only Docs
| File | Content |
|------|---------|
| `docs/features/fill-in-the-blank.md` | Blank detection, classification, parsing, scope |
| `docs/features/control-blanks.md` | Control-bound blank config and behaviour |
| `docs/features/selector-satellite.md` | Selector+satellite pair mechanics |

### Docs That Reference Blanks
| File | How |
|------|-----|
| `docs/features/tip-priority.md` | Control blank tips in priority table |
| `docs/features/secondary-display.md` | Control blank display format |
| `docs/features/hot-reload-config.md` | blanks.md in hot-reload list |
| `docs/features/cue-controls.md` | `blank*` fields in config table |
| `docs/glossary.md` | "Control-Bound Blank" definition |
| `docs/guides/quickstart.md` | Blank examples |
| `docs/guides/adding-a-cue-control.md` | Blank config in checklist |
| `docs/guides/porting-to-new-integration.md` | Blank integration points |
| `docs/guides/parser-types.md` | Blank parser types |
| `README.md` | Blank feature descriptions, blanks.md section |
| `CONTRIBUTING.md` | Adding blank modes guide |
| `CLAUDE.md` | blanks.md in repo structure |
| `CHANGELOG.md` | Feature 8, 12, 17 |

---

## 5. Entanglement Summary

### Clean Boundaries (easy to extract)
- `ClassifiedSourceGroup` — standalone class, zero word-alt dependencies
- `ControlBlankSource` — standalone class
- `blanks.md` — entire file is blank-specific
- Blank `cue.md` fields — can be parsed/ignored independently
- Blank scripts — optional, only invoked for control-bound blanks
- 3 feature docs — can be excluded from a non-blank release

### Moderate Entanglement (needs refactoring)
- `ConfigSource` — `supports()` has dual-path scope logic; `formatInput()` sends `BLANK` for blank modes
- `buildSourcesFromConfig()` — word combining (lines 89-115) and blank classifying (lines 117-161) are separate blocks but in one function
- `parseAlternatives()` — blank positions skip prepending the original word
- Claude Code auto-populate — 60 lines in wordHighlight.ts, condition-guarded

### No Entanglement (shared infrastructure, no changes needed)
- `Resolver` — fully generic, no blank-specific code
- `types.ts` — WordDef/CueResult are generic containers
- `NodeHttpAdapter` — transport layer, source-agnostic

---

## 6. Extraction Approach

**Option A: Feature flag** — add `blanksEnabled: false` to disable blank sources in `buildSourcesFromConfig`. Cheapest. Blanks code stays in tree but doesn't run. ~2 hours.

**Option B: Conditional build** — `buildSourcesFromConfig` skips ClassifiedSourceGroup and ControlBlankSource when `blanksCfg` is null. Already partially implemented (the `if` guards exist). ~4 hours to clean up edge cases.

**Option C: Full extraction** — move blank-specific code to `packages/cues-blanks/`. ConfigSource needs subclassing or scope removal. ~20-30 hours.

**Recommendation:** Option B for release — ship without `blanks.md` and the blank sources won't construct. The code is already structured this way. Add blanks back by dropping in `blanks.md` + controls.
