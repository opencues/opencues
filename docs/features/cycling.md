---
last_updated: 2026-07-04
---

# Word Cycling

Word cycling replaces the focused word with an alternative. It is the **vertical** axis of the system — once a word is selected via navigation (feature 1), Up/Down changes what that word is.

---

## How It Works

Implemented by the `Cycling` module (`packages/opencues-runtime/src/modules/cycling.ts`).

1. **Press** Ctrl+Alt+Up or Ctrl+Alt+Down while a word is highlighted (`HighlightState.active`).
2. **Priority check**: `Cycling.step()` evaluates the highlighted word against a **five-level priority chain** (see Cycling Priority below), highest first. The first level that applies handles the press; the rest are skipped.
3. **Text replacement**: the matched handler computes the new text and calls the host's `setText`, which repositions the cursor per the length delta.
4. **State update**: the relevant state object (`DynDefs`, `SpanFillState`, `SelectorSatelliteState`, or a plain `WordDef` in `DynDefs`) is updated to reflect the new position/value. `HighlightState`'s `onChange` subscribers (notably Statusline) react synchronously the same tick.

---

## Cycling Priority

Checked in this order — the first match wins:

### -1. Selector + satellite

**Condition**: a `SelectorSatelliteState.current` entry exists and the highlighted word falls on either half of the pair.

The "opencues settings" pattern: highlighting the selector half cycles setting names; highlighting the satellite half cycles that setting's value. Both write back through the blank's script/class via `blankInvoke`.

### 0. Span fill

**Condition**: `SpanFillState.current` is set and the highlight falls within it.

Takes precedence over list/static cycling when the highlight sits inside a consume-all span (e.g. an agent-improved prompt) or a multi-word `stepValues` span (e.g. affirmations spanning several words) — cycles through the stashed alts for that span.

### 1. List blank (`stepValues`)

**Condition**: the highlighted word resolves to a blank whose config declares `stepValues`.

The blank auto-populates with the first value; Up/Down rotates through the list in place. Multi-word values are span-tracked automatically. No script is needed.

All list-based blanks support `blankDismissible: true` — appends `_` as the last cycling option so the user can dismiss the value.

Example list blank (`defaults/blanks/affirmations/BLANK.md`):
```yaml
---
type: blank
name: affirmations
blankKeywords: affirmation, affirm
stepValues: ["I am strong", "I am brave", "I am worthy", "I am enough"]
tip: Daily affirmations
blankDismissible: true
---
```
Type `affirmation _` → blank auto-populates with "I am strong", Up/Down cycles through the list. Cycle past the last value → `_` to dismiss.

### 2. Blank-fill DynDef (`blankStep`)

**Condition**: the highlighted word has a `DynDef` with `blankName` set (an auto-populated value from a keyword-bound blank), and that blank declares `blankStep`.

`blankInvoke('<name>', { action: 'up'|'down' })` runs (script, in-process class, or dynamic multi-line `get` output — same handling either way), and the resulting live value replaces the word. `blankStep` sets the step size; `blankSuffix` the display unit.

### 3. Static alternatives

**Condition**: none of the above matched, and the word has (or can be built into) a `DynDef` with more than one alternative — an LLM word-cue, or a fallback tip-only def built on the fly from cueMap.

- `currentAltIndex` tracks position in the alternatives array (`alts[0]` is always the original word).
- Cycling wraps in both directions: `(currentAltIndex + direction + alts.length) % alts.length`.
- **Multi-word spans**: if the highlighted index is an inner position of an existing span, cycling redirects to the span's origin instead, so the whole span rotates as one unit.

---

## Portability

### Standard (opencues-core)

- `CueResult.alternatives` array provides the ordered list of replacements (`alts[0]` is always the original word)
- `CueResult.metadata.blankName` identifies blank-bound words
- opencues-core does not define the cycling priority order itself — that's a runtime-layer decision (`Cycling.step()`'s five-level chain above)

### Integration responsibilities

- Supply a `HostAdapter` (`setText`, `onKey`, `blankInvoke`) — `Cycling` does the rest in the shared runtime
- Render the updated text and reposition the cursor per the length delta the setText call implies
- Map Up/Down (or equivalent) input events, with the configured `nav-keymap` modifier combo, to `Cycling.step(event, direction)`
