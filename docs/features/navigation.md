---
last_updated: 2026-07-04
---

# Word Navigation

Word navigation lets users move a highlight cursor between interactive words in the input. It is the **horizontal** axis of the system — Left/Right to select a word, then **cycling** (feature 2) handles the vertical axis to change the selected word's value.

---

## How It Works

Implemented by the `Navigation` module (`packages/opencues-runtime/src/modules/navigation.ts`), which owns a shared `HighlightState` object.

1. **Press** Ctrl+Alt+Left or Ctrl+Alt+Right to activate navigation and highlight a word (modifier combo is configurable via `nav-keymap` — see [Cursor Navigate](cursor-navigate.md)).
2. **Compute targets**: on every keystroke, `Navigation.computeTargets()` walks the whitespace-split word list and returns the indices that are navigable (see Navigation Targets below).
3. **Walk from the right**: targets are stepped "from the right" — first activation lands on the rightmost target. Ctrl+Alt+Left moves further from the right (toward the start); Ctrl+Alt+Right moves closer to the right. Neither wraps.
4. **Deactivate**: pressing Ctrl+Alt+Right when already at the rightmost target, or pressing Escape, clears the highlight. A plain text edit deactivates too, unless `cursor-navigate: active` is on (see below), in which case the highlight follows the cursor instead of clearing.

---

## Navigation Targets

`computeTargets()` builds the candidate list, then layers span and selector/satellite handling on top:

- **cueMap match** — the word (lowercased) is a **word-cue** key (from `CUE.md` sources). A bare **blank keyword** (`volume`, `weather`, … from `BLANK.md`) is deliberately **NOT** a target: it's a pure `_` trigger, not navigable, and shows no tip until its `_` fires and registers a DynDef. (Nav reads `cueMap`, not the wider `navigableWords` = cueMap ∪ blank-keywords — using the wide set silently made bare keywords navigable, which broke the "gray/nav/tip only for real affordances" rule.)
- **DynDef entry** — `DynDefs.get(wordIndex)` returns a def for that position (LLM alternatives, blank-fill substitution, selector/satellite, span fill — anything currently tracked as cycleable). This is how a blank becomes navigable: only *after* it's summoned and filled.
- If **no word matches either** and cueMap is genuinely loaded (non-empty), the result is **silence** — an empty target list, not a fallback to "every word." No cue source has an opinion, so nothing is navigable.
- The out-of-the-box fallback (whole word list navigable) fires only when the ENTIRE config is empty — `navigableWords` (cueMap ∪ blank-keywords) has no entries **and** there are no DynDefs (fresh install, or a test scaffold with no `ConfigLoader`). Keying the fallback on cueMap alone would wrongly make every word navigable whenever a user had blanks but no word-cues.

On top of that base set:
- **Multi-word spans** — only the span's origin index is navigable; inner positions ("Bezos" in "Jeff Bezos") are dropped so a multi-word value counts as one nav stop.
- **Selector + satellite** — both halves of an active selector/satellite pair are force-included (even if neither word is in cueMap), with their own inner positions (for multi-word settings/values) dropped the same way.

Plain words with no cue, no blank binding, and no active DynDef are NOT navigable — there is no word-cycling on plain text; all external state is `_`-gated or cue-gated.

---

## Keys

| Key | Action |
|-----|--------|
| Ctrl+Alt+Left | Activate navigation (if inactive, lands on the rightmost target) or move one target further from the right |
| Ctrl+Alt+Right | Move one target closer to the right, or deactivate if already at the rightmost target |
| Ctrl+Alt+Up | Cycle to next alternative (or invoke cue-blank `up` action if blank-bound) |
| Ctrl+Alt+Down | Cycle to previous alternative (or invoke cue-blank `down` action if blank-bound) |
| Escape | Clear the highlight |
| Any text change | Clears the highlight, UNLESS `cursor-navigate: active`, in which case the highlight follows the cursor to whichever navigable word it lands in (or clears if the cursor is in whitespace) |

The modifier combo (`ctrl+alt` by default) is resolved per-keystroke by `resolveNavKeymap()` and configurable via the `nav-keymap` scalar, so flipping it in `OPENCUES.md` hot-reloads without re-subscribing.

---

## Highlight State

Navigation state lives in a shared `HighlightState` object (`packages/opencues-runtime/src/state/highlight-state.ts`), not a per-host global:

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Whether a word is currently highlighted |
| `wordIndex` | number \| null | The actual word index (into the whitespace-split array) that's highlighted — not an offset into a separate target-index array |
| `text` | string | Snapshot of the input text at the last activate/update |

`HighlightState` exposes an `onChange` subscription so other modules (notably Statusline) can react synchronously the same tick a highlight activates or deactivates.

---

## Portability

### Standard (opencues-core)

- `CueResult`/`WordDef`-equivalent data provides alternatives + metadata for every word in the input
- Navigation targets are words with cue/DynDef coverage, per the rules above
- The resolver returns the classified word list; navigability itself is a runtime-layer decision (`Navigation.computeTargets`), not something opencues-core computes directly

### Integration responsibilities

- Supply a `HostAdapter` with key subscription (`onKey`), text-change (`onTextChange`), and cursor-change (`onCursorChange`) hooks — `Navigation` does the rest
- Render the highlight at `HighlightState.wordIndex` when `active` is true
- Move the editor cursor/viewport to the focused word's position if the host wants visual cursor-follow
- Communicate the focused word to the cycling and visual-cues subsystems (in the shared runtime, this is automatic — `Cycling` and `DimRender` both read the same `HighlightState`)
