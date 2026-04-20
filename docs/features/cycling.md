---
last_updated: 2026-04-06
---

# Word Cycling

Word cycling replaces the focused word with an alternative. It is the **vertical** axis of the system — once a word is selected via navigation (feature 1), Up/Down changes what that word is.

---

## How It Works

1. **Press** Ctrl+Alt+Up or Ctrl+Alt+Down while a word is highlighted
2. **Priority check**: The `_cycleAlt` function evaluates the highlighted word against a four-level priority chain (see Cycling Priority below). The first level that matches handles the press; the rest are skipped.
3. **Text replacement**: The matched handler computes a new word, splices it into `globalThis._hlText` at the correct character offset, and returns `{text, lenDiff, wStart, newLen}` so the input zone can reposition the cursor.
4. **State update**: `globalThis._hlState.text` is updated to match the new text. For level 4 (alternative cycling), the highlight export JSON is written to `/tmp/opencues-highlight-state-<pid>.json` for the status line. Levels 1-3 call `_triggerStatusLineRefresh()` but do not write the export JSON.

---

## Cycling Priority

The four levels are checked in order. The first match wins.

### 1. Custom cue-controls

**Condition**: `globalThis._cueControlOverrides[word.toLowerCase()]` exists.

Triggers an external script (e.g., `volume.sh`). The script path comes from the control's config (`script`, `scriptPath`, or defaults to `~/.claude/actions/<controlName>.sh`). Up passes `upArgs` (default `["up"]`), Down passes `downArgs` (default `["down"]`). For in-memory value calculation, defaults are `['up','10']`/`['down','10']` (step of 10). For the spawned script args, defaults are `['up']`/`['down']`.

Script execution is debounced: rapid presses queue a single spawn after 50 ms with the direction string (up/down), not the computed numeric value. The numeric value is tracked in-memory only. In-memory state (`globalThis._cueControlValues`) tracks the current value to avoid file I/O on the hot path. Returns `{refresh: true}` — no text replacement, the integration triggers a full input refresh instead.

### 2. Control-bound blanks

**Condition**: The word's `_dynDefs` entry has `metadata.control` set (a blank position bound to a control via `blankKeywords`).

Two modes:

- **Script-based** (default): Runs the control's script synchronously (`execSync`, 3 s timeout) then calls `blankScript get` for the new live value. The `blankFormat` field determines how the value is parsed for display.
- **List-based** (`stepValues`): When the control has a `stepValues` array, the blank auto-populates with the first value and Up/Down cycles through the list via normal alternative cycling. Multi-word values are span-tracked automatically. No script is needed.
- **Dynamic list** (multi-line script output): When `blankScript get` returns multiple lines, each line becomes a cycling alternative. Same behavior as `stepValues` but populated from live data (e.g., RSS feeds, API results).
- **Consume-all** (`blankConsumeAll: true`): Clears the entire input and replaces it with a multi-word result. Cycling swaps the full text as a span. Requires dedicated cycling storage because the standard WordDef array is overwritten by analysis. See [Consume-All Blanks](consume-all-blanks.md).

All list-based controls (static `stepValues`, dynamic multi-line, and consume-all) support `blankDismissible: true` — appends `_` as the last cycling option so the user can dismiss the value. Dismissed positions are tracked to prevent auto-populate from re-firing.

Example list control (`controls/affirmations/cue.md`):
```yaml
---
type: control
name: affirmations
blankKeywords: affirmation, affirm
stepValues: ["I am strong", "I am brave", "I am worthy", "I am enough"]
tip: Daily affirmations
blankDismissible: true
---
```
Type `affirmation _` → blank auto-populates with "I am strong", Up/Down cycles through the list. Cycle past the last value → `_` to dismiss.

### 3. Step controls

**Condition**: The word matches a `stepPattern` (from a control's `cue.md`) or a pattern auto-generated from `stepSuffixes` AND there are no dynamic alternatives at this position (`_hasAltsCycle` is falsy). The alternatives check ensures that if a value has LLM-provided alts (e.g., from a blank fill-in), alt cycling (level 4) handles it instead.

Step controls are fully config-driven via `controls/` folder `cue.md` files. There is no hardcoded number behavior.

- **Config fields**: `stepPattern`, `step`, `stepMin`, `stepMax`, `stepFormat`, `stepSuffix`, `stepSuffixes`, `stepScript`
- **`stepSuffixes`**: space-separated suffixes (e.g., `f px em %`) — auto-generates patterns like `^\d+(\.\d+)?px$` for each suffix
- **`stepSuffix`**: suffix stripped before arithmetic and re-appended after (e.g., `1.5f` → strip `f` → `1.5 + 0.5` → `2` → `2f`)
- **`stepScript`**: escape hatch — script called with `(current_value, direction)` to compute next value, overrides arithmetic
- **`stepMin`/`stepMax`**: explicit bounds — Down will not go below `stepMin`, Up will not go above `stepMax`
- **`stepFormat`**: `integer` (rounds), `float` (preserves decimals), or auto (uses natural JS formatting)

Example config (`controls/numbers/cue.md`):
```yaml
---
type: control
name: numbers
stepSuffixes: f px em
step: 0.5
stepMin: 0
---
```

### 4. Consume-all cycling

**Condition**: `globalThis._consumeAllAlts` exists AND the current word (resolved via span) matches `_consumeAllAlts.index`.

Used by controls with `blankConsumeAll: true` that replace the entire input with multi-word cycling alternatives. Uses dedicated storage independent of `_dynDefs` because the standard WordDef array is overwritten by tips/grammar analysis. Span-aware: replaces the full span, updates `_dynSpans`, and prevents re-analysis by updating `_dynLastAnalyzed`/`_dynPrevWords`. Supports `blankDismissible` (cycling to `_` tracks dismissal). See [Consume-All Blanks](consume-all-blanks.md).

### 5. Alternative cycling

**Condition**: A `_dWord` entry exists in `globalThis._dynDefs.words` with `alts.length > 1`. If no entry exists but the word is in `globalThis._localCueMap` (tip-lookup fallback), a `_tipDef` is created on the fly and pushed into `_dynDefs.words`.

- `currentAltIndex` tracks position in the alts array. `alts[0]` is always the original word.
- Next index: `(currentAltIndex + dir + alts.length) % alts.length` — wraps in both directions.
- **Span-aware replacement**: If the word is part of a multi-word span (tracked in `globalThis._dynSpans`), the replacement splices across all span positions. After replacement, `_dynSpans` is updated: multi-word results register entries for each sub-word; single-word results clear the span entries.
- **TTS**: If `_dWord.speak` is true, the alt's tip is spoken via `SpeakCtl.exe` or `speak.sh` after an 80 ms debounce.
- **Underscore re-analysis**: If `_` appears in the updated text and the surrounding context changed, a fresh LLM analysis is queued.

---

## Step Bounds

Step controls use explicit `stepMin` and `stepMax` fields for bounds rather than tracking original values.

- **Down** cannot go below `stepMin` (if set)
- **Up** cannot go above `stepMax` (if set)
- Bounds are declarative — set in the control's `cue.md` frontmatter
- No per-word state tracking is needed — bounds are global for the control

Example: with `step: 0.5, stepMin: 0`, highlight `2f`, press Down 5 times: `1.5f`, `1f`, `0.5f`, `0f`, `0f` (floors at 0).

---

## Linked Word Cycling

When a word definition has a `linked` array (indices of co-dependent words), cycling one word simultaneously updates all linked words to the same `currentAltIndex`.

The linked-word update loop:

1. Compute `_nextAlt` for the primary word
2. For each index in `_dWord.linked`:
   - Find the linked word's definition in `_dWords`
   - If it has an alt at `_nextAlt`, set `_lDef.currentAltIndex = _nextAlt` and replace its text in the already-modified `_newText`
   - Track replacements in `_updW` (a map of index to new word) so subsequent linked replacements use correct character offsets
3. All replacements happen in a single pass before `_hlText` is finalized

Linked groups are resolved and merged across sources by `CueResolver` in cues-core. The integration only needs to apply the indices it receives.

---

## Portability

### Standard (cues-core)

- `CueResult.alternatives` array provides the ordered list of replacements (`alts[0]` is always the original word)
- `CueResult.linked` array contains indices of co-dependent words that must cycle together
- Priority order is defined by the standard: cue-controls > control-blanks > step controls > alternative cycling
- `CueResult.metadata.control` identifies custom cue-controls; `CueResult.metadata.stepControl` identifies step controls
- Linked-word groups are resolved and merged across sources by the resolver

### Integration responsibilities

- Perform the actual text replacement in the editor buffer when the user cycles
- Maintain `currentAltIndex` per word and handle wrap-around (`alts.length`)
- Enforce `stepMin`/`stepMax` bounds for step controls
- Execute external scripts for custom cue-controls (path from control config)
- When cycling a linked word, update ALL linked words' `currentAltIndex` and replace their text simultaneously
- Map Up/Down (or equivalent) input events to cycle direction
