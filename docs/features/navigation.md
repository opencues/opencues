---
last_updated: 2026-04-06
---

# Word Navigation

Word navigation lets users move a highlight cursor between interactive words in the input. It is the **horizontal** axis of the system — Left/Right to select a word, then **cycling** (feature 2) handles the vertical axis to change the selected word's value.

---

## How It Works

1. **Press** Ctrl+Alt+Left or Ctrl+Alt+Right to activate navigation and highlight a word
2. **Filter**: The system splits the input on whitespace, then builds `_targetIdx` — an array of word indices that pass the navigation filter (see Navigation Targets below)
3. **Index**: Words are indexed right-to-left — the rightmost navigable word is index 0. Left increments the index (moves toward the start), Right decrements it (moves toward the end)
4. **Deactivate**: Pressing Right when already at the rightmost target, pressing Escape, or typing any character clears the highlight and resets `_hlState`

---

## Navigation Targets

A word is navigable if it passes the `filterCode` check. The base filter (from `wordHighlight.ts`) uses `_isCueControl(word)` which checks:

- **Cue-control words** — present in `globalThis._cueControlOverrides` (a map of control keyword names)
- **Step-pattern matches** — word matches any pattern in `globalThis._stepPatterns` (auto-generated from `stepSuffixes` or explicit `stepPattern` in control configs)

The `dynamicHighlight.ts` patch (`writeDynamicNavigation`) extends this filter. After patching, a word at index `i` is also navigable if:

- **Local cue tip** (`_hasTipAlt`) — word exists in `globalThis._localCueMap` (case-insensitive lookup)
- **Dynamic alternative** (`_hasDynAlt`) — `globalThis._dynDefs.words` has an entry at that index with either `alts.length > 1` (and the current word appears in the alts list) or `metadata.control` set
- **Span original** — the word is the original position of a multi-word span (e.g., "Jeff" in "Jeff Bezos"). Note: `_isInSpan` and `_isSpanOriginal` evaluate to the same thing in practice — both select only the original position of a span; non-original span positions like "Bezos" are skipped

The combined filter pushes index `i` into `_targetIdx` if any of the above conditions are true and the word is not a non-original span position.

---

## Keys

| Key | Action |
|-----|--------|
| Ctrl+Alt+Left | Activate navigation (if inactive) or move highlight one target toward the start of the line |
| Ctrl+Alt+Right | Move highlight one target toward the end of the line, or deactivate if already at the rightmost target |
| Ctrl+Alt+Up | Step increment (config-driven via step controls) or cycle to next alternative |
| Ctrl+Alt+Down | Step decrement (config-driven, bounded by `stepMin`) or cycle to previous alternative |
| Escape | Clear highlight and reset `_hlState` |
| Any text change | Clear highlight and reset `_hlState` (detected by comparing `_hlText !== _oldText`) |

If `highlightWrap` is enabled in config, Left and Right wrap around using modulo arithmetic instead of deactivating at the edges.

Both the Ink key-property path (`leftArrow`/`rightArrow` with `ctrl` + `meta`/`option`/`alt`) and raw escape sequences (`\x1B[1;7D` for Left, `\x1B[1;7C` for Right, modifier 7) are handled to cover different terminal emulators.

---

## Highlight State

All navigation state lives in `globalThis._hlState`, an object with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Whether a word is currently highlighted |
| `index` | number \| null | Position within the `_targetIdx` array (0 = rightmost target) |
| `wordIndex` | number \| null | Actual index into the whitespace-split word array — computed as `_targetIdx[_targetIdx.length - 1 - index]` |
| `text` | string | Snapshot of the input text when navigation was activated |
The state is reset to `{active:false, index:null, wordIndex:null, text:""}` on Escape, on Right past the last target, or when the input text changes.

---

## Portability

### Standard (cues-core)

- `WordDef` provides `index`, `word`, and `alts` for every word in the input
- Navigation targets are words where `alts.length > 1`, step-pattern matches, cue-controls, or words with `metadata.controlName`
- `CueResolver.analyze()` returns the full word list with classification already applied
- No navigation state is tracked in cues-core; it only identifies which words are navigable

### Integration responsibilities

- Map keyboard shortcuts (or mouse/touch events) to move between navigable words
- Filter the `WordDef[]` array to determine the ordered set of navigation targets
- Track which word is currently focused (`highlightIndex` or equivalent)
- Move the editor cursor or viewport to the focused word's position
- Distinguish navigation targets by type (alt word, step control, cue-control) if the UI treats them differently
- Communicate the focused word to the cycling and visual-cues subsystems
