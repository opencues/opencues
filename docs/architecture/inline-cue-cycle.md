# `_`-cycle — pressing `_` inside a painted cue note rotates it

> **Status: proposed / design — NOT built.** Design captured on branch
> `feat/inline-cues`. Companion to `docs/architecture/inline-cues.md` (the note
> itself). Greenlight pending; this doc is the map + the locked decisions so the
> build is unambiguous when it starts.

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

| Target | Has inline note (`cueTip`)? | `_`-cycle eligible | Arrows |
|---|---|---|---|
| **Sentence-cue** | ✅ | ✅ (rotate rewrites) | ✅ |
| **Contradiction cue** | ✅ | ✅ (**accept the fix**) | ✅ |
| **Word-cue** | ❌ (dim + statusline) | ❌ — arrows only | ✅ |
| **Selector/satellite (settings)** | ❌ | ❌ — arrows only | ✅ |
| **List / script blank (volume…)** | ❌ (`_` is its *trigger*) | ❌ | arrows cycle |
| **Fluid / transform blank span** | ❌ | ❌ | down-arrow reverts |

### Where the old means (arrows) are *necessary* — the fallback set

1. **Backward / precise stepping** — `_` only wraps forward. Always, every surface.
2. **Note-less targets** — word-cues, settings, blanks. Arrows only, any host.
   (v1 boundary; word-cues could gain a note later and join.)
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

## Open questions (settle before build)

1. **Does the note advertise `_`, or is presence enough?** The one real UI call.
   Options, lightest → loudest:
   - **presence-only** — note stays `↳ more-formal`; teach it once in docs.
   - **state counter** — `↳ more-formal (1/3)` — implies steppability, doubles as
     post-press feedback (`1/3 → 2/3`) without naming a keycap. *(Current lean.)*
   - **explicit hint** — `↳ more-formal · _` — names the key on the flag.
2. **Scope boundary.** v1 = note-bearing cues only (sentence + contradiction).
   Word-cues stay arrow-only until they get a note.

## Parked

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
