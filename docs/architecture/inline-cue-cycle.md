# `_`-cycle — pressing `_` inside a painted cue note rotates it

> **Status: PROTOTYPE (built on CC).** Wired in `Cycling.stepUnderscore`
> (`packages/opencues-runtime/src/modules/cycling.ts`) on branch
> `feat/inline-cues`; verified on a live CC host (rotate forward + wrap +
> consume; blank path intact off-cue). Chrome inherits it automatically
> (same runtime, `inline-note` capability). The note format is now specified
> (the emoji / countdown / `(underscore to cycle)` hint vocabulary — see
> `inline-cues.md` § The note vocabulary), so the note DOES advertise `_`:
> the hint rides every cycleable note until the user's first cycle this session.
> Companion to `docs/architecture/inline-cues.md` (the note itself).

## The mechanic

When the caret is inside a cue whose **inline note is painted**, pressing `_`
rotates that cue to its next state — the same rotation `Ctrl+Alt+↑` performs,
but on the one key users already learn for OpenCues. It **complements** the
arrow gesture; it does not replace it.

The point is discoverability and reach: `Ctrl+Alt+arrow` is an invisible,
modifier-heavy, host-fragile chord (it's the very constraint that forced the
no-cycling / universal-integration profile to exist). `_` is a bare keystroke,
and the note on screen is a *visible* affordance we can point at.

## Locked decisions

1. **Complement, not replace.** Arrows stay the power path (bidirectional,
   works on note-less targets). `_` is the discoverable forward shortcut.
2. **Strictly gated on the note being painted.** The note is what lets a user
   infer that dropping `_` on the span will rotate it. No note on screen → `_`
   keeps its normal blank meaning. This makes the affordance and the action the
   same object — nothing hidden to remember.
3. **`_` is consumed** (not inserted) inside a painted note; it **wraps
   forward** (…→ alt2 → alt1 → original → …, so the wrap *is* the revert); one
   undo step per press. Arrows remain bidirectional.
4. **Additive spec change, no new scalar.** Core `_` = "place a blank" is
   untouched; the new meaning lives only inside a painted note — a context that
   didn't exist before, so nothing old reinterprets. It rides
   `inline-cues-mode` + the `inline-note` capability; it degrades exactly where
   the note does.

## The precedence rule collapses to one line

Because it's note-gated, there is no separate cue-vs-blank arbitration:

> **Caret inside a span whose inline note is painted → `_` cycles it (consumed).
> Otherwise → `_` is a blank.**

That single condition already encodes: the def has alternatives + a `cueTip`,
the caret is in the span, `inline-cues-mode: inline`, and the host actually
painted it (`inline-note` capability). If any is false, no note is on screen, so
`_` falls through.

## Coverage map

`_`-cycle is available exactly where the note paints; arrows are the fallback
everywhere else (and the only path for backward + note-less targets).

### By host — does the note paint? (the `_`-cycle gate)

| Host / surface | Note paints? | `_`-cycle | Arrows | Coverage |
|---|---|---|---|---|
| **CC (claude-code)** | ✅ wired | ✅ | ✅ | both |
| **Chrome — contenteditable** | ✅ wired (overlay) | ✅ | ✅ | both |
| **OpenCode** | ⬜ wireable, not wired | ❌ today | ✅ | arrows-only until note wired |
| **Gemini CLI** | ⬜ wireable, not wired | ❌ today | ✅ | arrows-only |
| **Shell (oc-shell)** | ⬜ wireable, not wired | ❌ today | ✅ | arrows-only |
| **Windows overlay** | ⬜ wireable, not wired | ❌ today | ✅ per-field | arrows-only |
| **Chrome — normal `<input>`/`<textarea>`** | ❌ no paint surface | ❌ | ❌ (`supportsCycling:false`) | **neither — cues pruned** |

Today `_`-cycle lives on exactly two surfaces (**CC + chrome contenteditable**).
OC/gemini/shell/windows are "old means necessary" *only because the note isn't
wired there yet* — each has a painter (OpenTUI extmarks / native overlay) that
could carry a note, at which point `_`-cycle lights up for free. Chrome plain
inputs are the one place it's fundamentally impossible.

### By target type — does it have a note?

Since the uniform note model (July 2026) EVERY note-bearing gray span is
`_`-cycle eligible — the gate is simply "does a note show here", so as targets
gained notes they gained `_`-cycle for free:

| Target | Has inline note? | `_`-cycle eligible | Arrows |
|---|---|---|---|
| **Sentence-cue** | ✅ `cueTip` | ✅ (rotate rewrites) | ✅ |
| **Contradiction cue** | ✅ `cueTip` | ✅ (**accept the fix**) | ✅ |
| **Transform / fluid blank span** | ✅ (`↳ N | <dest> | <dest>` — its destinations) | ✅ (**walks the transform HISTORY**) | ✅ |
| **Word-cue (incl. spelling)** | ✅ (its suggestions) | ✅ (rotate suggestions) | ✅ |
| **List / script blank (volume…), filled** | ✅ (its tip / options) | ✅ (rotate values, `SpanFillState`) | ✅ |
| **Selector/satellite (settings)** | ✅ (cursor-aware tip) | ✅ (cursor-aware: names on selector, values on satellite) | ✅ |
| **Bare blank keyword (before `_`)** | ❌ (pure trigger) | ❌ (`_` is its *trigger*) | ❌ |

### Where the old means (arrows) are *necessary* — the fallback set

1. **Backward / precise stepping** — `_` only wraps forward. Always, every surface.
2. **Note-less targets** — only the bare blank keyword before its `_` fires (a
   pure trigger, no note). Every other gray span now carries a note and so
   `_`-cycles; arrows remain the backward/power path.
3. **Note-less hosts** — OC/gemini/shell/windows until wired; and
   `inline-cues-mode: secondary` (note in statusline, not painted → `_` stays a
   blank).
4. **No-cycle profile** — chrome plain inputs: neither works, cues pruned.

## The strategic insight — split `supportsCycling`

`supportsCycling` currently **bundles two capabilities** — "can paint" and "can
intercept `Ctrl+Alt+arrow`" — and prunes cues when either is missing. `_`-cycle
wants them **split**: a host that can *paint a note* and *pass a bare `_`* but
*can't* do modifier-arrows could offer cues via `_` alone. That decouples
"cyclable" from "has a modifier-chord gesture" — the exact constraint that
created the universal-integration profile — so `_`-cycle is a path to cues on
constrained hosts arrows can never reach. Not urgent; it's the reason the
mechanic is more than a convenience.

## Open questions

1. **Indicator style — SETTLED (2026-08).** The note now advertises `_` on two
   axes: a **countdown** (`inlineNoteCount(def)` — options remaining, `N → 1`,
   wrapping — the state-counter lean, realised) and a right-aligned
   **`(underscore to cycle)` hint** that rides until the user's first cycle this
   session (`hasCycledEver()` / `markCycledEver()`), then drops off. Full
   vocabulary in `inline-cues.md` § The note vocabulary.
2. **Scope boundary (settled → widened July 2026).** The original v1 was
   note-bearing cues only (sentence + contradiction). With the uniform note
   model every gray span carries a note, so `_`-cycle now covers word-cues,
   filled list/script blanks, and selector-satellite too — see below.

## Generalized to any note-bearing span (built)

The mechanic is no longer sentence-cue-specific. The gate mirrors DimRender's
note computation EXACTLY — the note on screen IS the affordance, so `_`-cycle
fires precisely where a note is painted. Two families:

**DynDef-backed** (the `stepUnderscore` loop) — `inlineNoteText(def)` in
`state/dyn-defs.ts` is the SOLE predicate, shared with DimRender so they can't
drift. A def is note-bearing when it:

- carries a `cueTip` (sentence-cue / contradiction — an advisory), **or**
- is a **history-bearing LLM blank** (`transform-blank` / `fluid-blank`) with
  >1 alternative. Those accumulate a **walkable history** in `alternatives` via
  `findChainableLlmDef` (translate → 日本語, make formal → …), so `_` **steps
  back through your transformations** — a rotation that GROWS with use, richer
  than a cue's fixed set. The note previews the **destinations** it steps to
  (`N | <dest> | <dest>`, each ≤2-word-snippeted), **or**
- is a **plain word-cue** (no blankName, no cueTip) with >1 alternative — `_`
  rotates its suggestions (incl. spelling corrections).

**Non-DynDef states** (handled after the loop, same cursor-gate as dim-render's
note computation, since they aren't DynDefs the loop iterates):

- **`SpanFillState`** (filled list/script blanks — volume, brightness,
  affirmations): `_` anywhere in the fill span rotates its values
  (`cycleSpanFill`).
- **`SelectorSatelliteState`** (settings): **cursor-aware** — `_` on the
  selector cycles setting names, on the satellite cycles that setting's values
  (`cycleSelectorSatellite`, driven by the caret's word index) — matching the
  cursor-aware note.

Both reuse the SAME cycle helpers `Ctrl+Alt+↑` uses; `_` just derives the target
index from the caret (the note gate) instead of from `hlState`.

**Auto-select is `cueTip`-only.** A cue's span promotes dim→highlight on
cursor-in-span; a transform/fluid **keeps its dim** (a whole-buffer transform
flipping the entire buffer to a bright highlight would be jarring). The note
appears either way; only the highlight is scoped.

**Provisional until edited.** Editing a substitution invalidates its span
(`defSpanLive` fails) → note vanishes, `_` frees back to a blank, AND the chain
breaks (fresh def). So an edit both *commits* the result and *ends* the walkable
history. One rule for cues and blanks alike; it also resolves the whole-buffer
`_`-greediness (type past the span or edit it and `_` is a blank again).

Verified on a live CC host: a real transform gets a `↳ transform` note and `_`
walks its history.

## Parked

- **State cache** *(ask Wilfred later-later)* — a cache so you can return to a
  PREVIOUS OpenCues state when you land back on the same text (re-attach the
  prior def/history to identical buffer content instead of it being gone). Not
  designed yet.
- **Horizontal note** — a future paint *variant* (note beside the span rather
  than under it). Since paint-presence is the gate, it simply becomes another
  surface where `_`-cycle turns on. To be designed later.

## Implementation sketch (when greenlit)

Small: the `_` keystroke handler (resolver's `onUnderscoreKey` / the explicit-`_`
arm) consults the same "is a note painted at the caret" check `DimRender` already
computes (cursor ∈ a live `cueTip` span, `inline-cues-mode: inline`,
`inline-note` capability), and on a hit forwards to the existing `applyAltCycle`
(forward, wrapping) and **consumes** the `_` instead of inserting it. The
chrome trust-gate must classify a cycle-`_` as lower-risk than a blank-`_` (a
local swap of already-visible text — no LLM, no exec).
