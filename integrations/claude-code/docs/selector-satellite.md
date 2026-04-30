---
last_updated: 2026-04-08
---

# Selector + Satellite Blanks — Claude Code

Implements feature [17](../../../docs/features/selector-satellite.md). See that doc for the concept.

**Patch files:** `patches/dynamicHighlight.ts` (config parser, cycling paths, `_pendingAutoPopulate` extension, render-pass suppression, pair-cleanup cascade, TTS cycling gate), `patches/wordHighlight.ts` (auto-populate insertion branch, TTS navigation gate)

**Cues-core changes:** `packages/opencues-core/src/sources/control-blank-source.ts` (satellite branch), `packages/opencues-core/src/cues-md.ts` (`blankSatellite` field on `BlankConfig` + `SingleCueFrontmatter`)

## CC-Specific: The `opencues.md` Parser

`_reloadCuesConfig` grew a hand-rolled line walker that reads `opencues.md` from `process.cwd()` and hydrates globals from the unified `settings:` block:

| Global | Type | Contents |
|---|---|---|
| `globalThis._openCuesSettings` | `Record<string, string[]>` | Valid-value lists keyed by setting name (keys from `values:` sub-blocks). |
| `globalThis._openCuesCurrent` | `Record<string, string>` | Current live values (from top-level frontmatter keys). |
| `globalThis._openCuesTips` | `Record<string, string>` | Selector tips (from `tip:` lines). |
| `globalThis._openCuesSatTips` | `Record<string, Record<string, string>>` | Per-value satellite tips (from value entries under `values:`). |
| `globalThis._openCuesVersion` | `number` | Format version (from `version:` key). |

All hot-reload every ~2s on the standard config cycle. `_openCuesCurrent` additionally takes **immediate in-memory writes during satellite cycling** so changes apply before the disk round-trip.

The parser is deliberately not a regex. An earlier version used `new RegExp("^---\\r?\\n([\\s\\S]*?)\\r?\\n---")` to extract the frontmatter, and the escape-sequence interactions between the TypeScript template literal, the patched `cli.js` string, and the JavaScript regex engine produced a pattern that silently failed to match any frontmatter at all. The replacement walks lines with a `_inFm` toggle on the `---` fence. Inside `settings:`, structure is detected by key names and whether a value is present after the colon — not by counting indent depth. A line with no value after the colon sets `_curSetKey` (setting name); `tip:` and `values:` are reserved keys; any other key with a value inside an active `values:` block is a value entry. Top-level lines (not indented) outside the `settings:` block go into `_openCuesCurrent`; `version:` is parsed separately. This makes the parser tolerant of any indentation style.

## CC-Specific: Multi-Word Selector and Satellite

Either half can be multi-word. The opencues-core source (`BlankSource`) splits on the first **tab character** rather than a space, so script output like `"output-format\tplain text"` parses correctly into `selectorText = "output-format"` + `satelliteText = "plain text"`. A setting key with spaces in YAML — e.g. `"high quality": [fast, slow]` — also works because the YAML parser splits on `:` not whitespace.

Each half is represented as a WordDef whose `word` field holds the **joined text** (e.g. `"plain text"`, including internal spaces) and whose `spanLength` is set to the word count when > 1. `_dynSpans` is populated for every position in the span, with `originalIndex` pointing at the span's first index. This is the same span infrastructure used by multi-word LLM alternatives (e.g. `"Jeff Bezos"`) — selector+satellite rides on top of it.

All cycling and auto-populate paths use the `spanLength` field to compute span extents and do whole-span text replacements. Word-count changes between old and new values (e.g. cycling `plain text` → `structured json` shrinks from 2 words to 2 words — same; but cycling `voice-mode` → `debug-mode` when satellites differ in word count) trigger downstream index shifts: all WordDefs at index ≥ the old end-of-pair position get their `index`, `metadata.childIndex`, and `metadata.parentIndex` shifted by `newTotal − oldTotal`. `_dynSpans` entries are shifted symmetrically.

## CC-Specific: Auto-Populate Insertion Branch

The auto-populate trigger in the resolver callback was extended with three fields:

```js
globalThis._pendingAutoPopulate = {
  index, value,
  keywordExpansion: metadata.blankKeywordExpansion || null,
  satellite: metadata.satelliteValue || null,  // NEW
  controlName: metadata.blankName || null,   // NEW
  blankScript: metadata.blankScript || null,   // NEW
};
```

When `wordHighlight.ts`'s onChange handler sees `_ap.satellite != null`, it takes a separate branch from the regular single-word replacement. The operation is: replace one `_` with two words. That shifts every downstream index by +1 and requires:

1. **Text splice** — `_apBase.slice(0, _apStart) + selector + " " + satellite + _apBase.slice(_apStart + 1)`.
2. **`_dynLastAnalyzed` / `_dynPrevWords` updated** to the post-insertion word array so the re-entrant onChange doesn't re-trigger analysis.
3. **WordDef index shift** — every existing entry with `index > _apN` gets `index += 1`.
4. **Cross-reference shift** — any shifted WordDef with `metadata.childIndex > _apN` or `metadata.parentIndex > _apN` gets those pointers incremented too. This keeps nested selector+satellite pairs downstream of the insertion point intact.
5. **`_dynSpans` shift** — keys > `_apN` rewritten to `key + 1`.
6. **Alts derivation** from `_openCuesSettings`:
   ```js
   var _apSelVals = Object.keys(_openCuesSettings);        // setting names for selector
   var _apSatVals = _openCuesSettings[selector] || [sat];  // valid values for satellite
   ```
   Graceful degradation: if `_openCuesSettings` is empty (parse failure / not yet loaded), both lists fall back to a single element and cycling becomes a no-op.
7. **Tip resolution** from `_openCuesTips` / `_openCuesSatTips` (parsed from `opencues.md` `tips:` block):
   ```js
   var _apSelTip = (_openCuesTips && _openCuesTips[selector]) || null;
   var _apSatTip = (_openCuesSatTips && _openCuesSatTips[selector] && _openCuesSatTips[selector][sat])
                || (_openCuesTips && _openCuesTips[selector]) || null;
   ```
   Tips are read directly from the hot-reloaded globals — no metadata passthrough needed.
8. **Selector WordDef created/replaced at index N** with `metadata: { controlName, blankScript, selectorWord: true, childIndex: N+1, currentSetting: selector }`.
9. **Satellite WordDef pushed at index N+1** with `metadata: { controlName, blankScript, satelliteWord: true, parentIndex: N }`.
10. **Cursor placed** at the end of the satellite; `onChangeParam` called with the new text + ZWS toggle.

No `_dynSpans` entry is created — the pair are independent words, not a span.

## CC-Specific: `_cbDef` Exclusion

The existing blank cycling (the numeric/step-based path for `volume _`, `brightness _`, etc.) previously grabbed any WordDef with `metadata.blankName && !listControl`. It was narrowed:

```js
var _cbDef = _dynDefs.words.find(w =>
  w.index === _hlIdx &&
  w.metadata && w.metadata.blankName &&
  !w.metadata.listControl &&
  !w.metadata.selectorWord &&  // NEW
  !w.metadata.satelliteWord    // NEW
);
```

Otherwise the numeric path would claim the satellite and try to parse `"active"` as a float.

## CC-Specific: Cycling Paths in `_cycleAlt`

Two new branches were added inside `_cycleAlt`, after the `_cbDef` check and before the step-control/generic-dyn-alt paths. Both live inside `if (globalThis._dynDefs && globalThis._dynDefs.words)`.

### Selector branch (`metadata.selectorWord === true`)

1. Compute next setting from `Object.keys(_openCuesSettings)` using `_selDef.metadata.currentSetting` as the current position, wrap on `_dir`.
2. `execFileSync("bash", [scriptPath, "get", nextSetting])` — fall back to `_openCuesSettings[nextSetting][0]` on error.
3. Walk forward from the selector's position in `_hlText` to find the satellite's current word by string search. If found, build the new text by splicing **both** replacements in a single pass:
   ```js
   _newSelText = _selText.slice(0, _selWStart)
               + nextSet
               + _selText.slice(_selWEnd, _satWStart)
               + _ocNewVal
               + _selText.slice(_satWEnd);
   ```
   If the satellite can't be located (user deleted it, cleanup hasn't fired yet), fall through to selector-only replacement.
4. Update the selector's `word` and `metadata.currentSetting`.
5. Update the satellite's `word`, `alts` (← `_openCuesSettings[nextSet]`), and `currentAltIndex`.
6. Write the highlight-state export JSON and return `{ text, lenDiff, wStart, newLen }`. `lenDiff` accounts for both words combined.

### Satellite branch (`metadata.satelliteWord === true`)

1. Look up the parent via `metadata.parentIndex`, read `parent.metadata.currentSetting`. If missing, return null.
2. Advance in `_openCuesSettings[currentSetting]`.
3. `execFileSync("bash", [scriptPath, "set", currentSetting, newValue])` (errors swallowed).
4. `globalThis._openCuesCurrent[currentSetting] = newValue` — **immediate in-memory update**, the key to responsive gate toggling.
5. Replace only the satellite word in text.
6. Update `_satBound.word` and `currentAltIndex`, write highlight-state export, return.

## CC-Specific: Pair Cleanup Cascade in `writeDynamicClearOnChange`

The per-word clearing path (`clearCode` in the patch) was extended to cascade metadata clearing through the selector↔satellite pointers.

### In-place edit case

When `_oldW[_wi] !== _newW[_wi]` and the new word isn't in `alts`, the existing code clears `_def.metadata`. The extension captures the metadata into `_clearedMeta` first, then after deletion:

```js
if (_clearedMeta) {
  var _pIdx = null;
  if (_clearedMeta.satelliteWord && typeof _clearedMeta.parentIndex === "number")
    _pIdx = _clearedMeta.parentIndex;
  else if (_clearedMeta.selectorWord && typeof _clearedMeta.childIndex === "number")
    _pIdx = _clearedMeta.childIndex;
  if (_pIdx !== null) {
    var _pDef = _dynDefs.words.find(d => d.index === _pIdx);
    if (_pDef) {
      _pDef.alts = null; _pDef.currentAltIndex = 0;
      delete _pDef.metadata;
      if (_dynSpans) delete _dynSpans[_pIdx];
    }
  }
}
```

### Trailing deletion case

The same cascade runs in the `_newW.length < _oldW.length` branch, so deleting the satellite by backspacing through the end of the input also clears the selector.

Valid cycles (new word IS in `alts`) don't hit this branch — they take the in-place `currentAltIndex` update path above it. The pair stays intact through cycles; it only tears down on actual edits.

## CC-Specific: Keyword-Context Suppression (Two Render Passes)

Two independent rendering passes decide what's navigable vs. dimmed. Both needed the same check:

**1. Navigation filter** (`writeDynamicNavigation` in `dynamicHighlight.ts`). Regex-replaces every `_allW.forEach(...)=> _targetIdx.push(i)` loop originally emitted by `wordHighlight.ts`'s key handlers, extending their filter with `_hasTipAlt`, `_hasDynAlt`, `_isInSpan`, and now `_isCtxKw`. Populates `_targetIdx` — the list of word indices that Ctrl+Alt+Left/Right can jump to.

**2. Dim-ranges renderer** (`writeDynamicRendering` in `dynamicHighlight.ts`). Rewrites the `else if` cascade that pushes into `_numRanges` — the list of character ranges painted dark-gray in the rendered output.

The check is the same in both places: while any WordDef has `metadata.selectorWord === true`, words at indices to its left whose lowercase matches the owning blank's `blankKeywords` are suppressed.

```js
var _isCtxKw = false;
if (_dynDefs && _dynDefs.words) {
  for (var _cki = 0; _cki < _dynDefs.words.length; _cki++) {
    var _ckd = _dynDefs.words[_cki];
    if (_ckd && _ckd.metadata && _ckd.metadata.selectorWord && i < _ckd.index) {
      var _ckCtrl = (_cueBlankOverrides || {})[_ckd.metadata.blankName];
      if (_ckCtrl && _ckCtrl.blankKeywords) {
        for (var _ckj = 0; _ckj < _ckCtrl.blankKeywords.length; _ckj++) {
          if (_ckCtrl.blankKeywords[_ckj] === _wLow) { _isCtxKw = true; break; }
        }
        if (_isCtxKw) break;
      }
    }
  }
}
```

In the dim cascade, the whole `_numRanges.push` tree was wrapped in an IIFE that returns `false` early if `_isCtxKw`, skipping every dim branch (step patterns, cue controls, tip alts, dyn defs, spans).

No global state is mutated — the check is predicated purely on the live `_dynDefs.words` contents and the declared `blankKeywords` in `_cueBlankOverrides`. When pair cleanup clears the `selectorWord` flag, the check stops matching on the next render and keyword words become interactive again.

An earlier draft added the keyword words to `globalThis._cuesIgnoreWords` (the `## Ignore` feature's Set). That was wrong — `_cuesIgnoreWords` is a user-authored list, not a runtime scratch space, and mutating it caused those words to be silently ignored in unrelated contexts. Reverted in favour of the dynamic filter.

## CC-Specific: TTS Gate Points

The `voice-mode` reference wiring touches two call sites:

**1. Cycling TTS** (`dynamicHighlight.ts`, inside `_cycleAlt`'s generic dyn-alt cycling branch):

```js
if (_dWord.speak && !(globalThis._openCuesCurrent &&
                      globalThis._openCuesCurrent["voice-mode"] === "inactive")) {
  // spawn speak process
}
```

**2. Navigation TTS** (`wordHighlight.ts`, in the selection-highlight path triggered by Ctrl+Alt+arrow):

```js
var _ttsVoiceOff = globalThis._openCuesCurrent &&
                   globalThis._openCuesCurrent["voice-mode"] === "inactive";
if (_hlExport.cueTip && !_ttsVoiceOff) { /* existing logic */ }
```

Because satellite cycling updates `_openCuesCurrent` in memory immediately, flipping `active` → `inactive` silences the very next spawn — no restart, no wait for hot-reload. This is the same pattern any future setting should follow: read `globalThis._openCuesCurrent[key]` at the point of action.

## CC-Specific: New Globals

| Global | Populated by | Consumed by |
|---|---|---|
| `_openCuesSettings` | `_reloadCuesConfig` (keys from `values:` sub-blocks in `opencues.md` `settings:`) | Selector cycling (key list), satellite alts derivation (values per key), auto-populate insertion (initial alts) |
| `_openCuesCurrent` | `_reloadCuesConfig` (parse of top-level keys) + immediate in-memory write on satellite cycle | Any runtime gate (TTS; future consumers) |
| `_openCuesTips` | `_reloadCuesConfig` (`tip:` lines in `opencues.md` `settings:`) | Selector tip display, satellite tip fallback |
| `_openCuesSatTips` | `_reloadCuesConfig` (value entries under `values:` in `opencues.md` `settings:`) | Per-value satellite tip display |
| `_openCuesVersion` | `_reloadCuesConfig` (`version:` top-level key) | Format version marker |

Tips are the single source for selector/satellite tip display. See [Tip Priority](../../../docs/features/tip-priority.md) for how they interact with other tip sources (control blanks, cue-blank keywords, local cues, LLM).

## CC-Specific: New Metadata Fields on WordDef

| Field | On | Meaning |
|---|---|---|
| `metadata.selectorWord: true` | selector | Marks the WordDef as the selector half. Drives cycling dispatch, keyword suppression, and `_cbDef` exclusion. |
| `metadata.satelliteWord: true` | satellite | Marks the WordDef as the satellite half. Drives cycling dispatch and `_cbDef` exclusion. |
| `metadata.childIndex: number` | selector | Points at the satellite. Updated on index shift during insertion. |
| `metadata.parentIndex: number` | satellite | Points back at the selector. Updated on index shift during insertion. |
| `metadata.currentSetting: string` | selector | Authoritative logical state (which setting the selector represents). Distinct from `word`, which is the display text. Read by satellite cycling to know which setting to write. |
| `metadata.selectorControl: true` | `CueResult` from `BlankSource` | Internal handoff flag from the resolver to auto-populate. Converted to `selectorWord: true` on the runtime WordDef. |
| `metadata.satelliteValue: string` | `CueResult` from `BlankSource` | Carries the satellite's initial value through the resolver callback to `_pendingAutoPopulate`. |
| `metadata.blankClearOnEdit: boolean` | both | If true, pair cleanup removes the spawned words from text (via `_pendingClearOnEdit`). |

## CC-Specific: New Fields on `BlankConfig` / `SingleCueFrontmatter`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `blankSatellite` | `boolean` | `false` | Signals that script output should be split into selector + satellite rather than treated as a single value. Parsed by `parseExtendedFrontmatter` and copied onto `BlankConfig` in `parseSingleCueMd`. |
| `blankSatelliteSeparator` | `string` | `'\t'` (tab) | The delimiter between selector and satellite in the script's `get` output. Can be any string (single or multi-character). `BlankSource` splits on the first occurrence via `rawValue.indexOf(satSep)`. Surrounding quotes are stripped during frontmatter parsing (`value.replace(/^['"\|['"]$/g, '')`). Common values: `'\t'`, `' \| '`, `' :: '`. |
| `blankClearKeywords` | `boolean` | `false` | Remove keyword context words from text on auto-populate. Keywords can be multi-word phrases. |
| `blankClearOnEdit` | `boolean` | `false` | Remove spawned selector/satellite words when user edits to something not in alts. Schedules removal via `globalThis._pendingClearOnEdit`. |
