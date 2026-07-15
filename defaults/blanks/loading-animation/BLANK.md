---
name: loading-animation
type: blank
tip: Define the loading animation inline
blankKeywords: loading animation
# Single anchored shape: everything after the keyword phrase up to the
# trigger `_` is the command (parsed by LoadingAnimationBlank). There
# is deliberately NO bare `loading animation _` shape: custom frame
# lists usually START with `_` (`_,-,‾,-`), and a bare shape would fire
# the instant that first underscore was typed. Use `show` for a read.
# The full-command capture consumes the span, so the confirmation
# replaces the command.
blankShapes: [{"pattern":"^loading animation\\s+(.+?)\\s*_$","action":"get","valueGroup":1}]
blankFormat: string
blankClearOnEdit: true
blankDismissible: true
as-context: off
---

Implementation: built-in `LoadingAnimationBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/loading-animation.ts`). Every
host wires it via `createDefaultBlanksRegistry` (needs the host's
`opencuesMdIO`). Deterministic — no LLM: the blank parses the inline
definition and upserts the existing `blank-loading-*` scalars in
`~/.cues/OPENCUES.md` (same write path as the `opencues` settings
blank). The animator reads those scalars live, so the very next `_`
you trigger plays the new animation.

Grammar (comma-separated lists, no spaces inside a list — commas are
load-bearing because frames often start with `_`):

- `loading animation _,-,‾,- _` — frames only (1-5 glyphs, each 1-3
  chars). Writes `blank-loading-frames` and flips
  `blank-loading-animation: custom`.
- `loading animation _,-,‾,- red,orange,yellow _` — frames + colours.
  Colour i paints frame i. One list feeds BOTH colour scalars:
  ANSI names + 0-255 indices land in `blank-loading-colors-ansi`,
  hex (+ named colours mapped to hex) in `blank-loading-colors-rgb` —
  terminal and full-colour hosts stay in sync from one definition.
- `loading animation ▖,▘,▝,▗ #ff5f5f,#ffd75f 75 _` — plus the per-frame
  interval in ms (clamped 30-2000).
- `loading animation red,blue _` — recolour whatever animation is
  active, frames untouched.
- `loading animation 300 _` — interval only. (A bare number is always
  the interval — a lone 256-colour index isn't expressible; write it
  alongside a name, e.g. `196,red`.)
- `loading animation bounce _` — switch preset (`bounce` /
  `braille-rotate` / `flipper` / `off`). Combines with colours or an
  interval (`loading animation bounce 75 _`), never with frames.
- `loading animation show _` — current config, e.g.
  `custom · frames _,-,‾,- · rgb #ef4444,#f59e0b · 150ms`.

Every limit is named in the confirmation, never silent: frames beyond
5 are truncated (and say so), the interval clamp is reported, unused
trailing colours are counted, and a colour list one host class can't
render says which side falls back to the default palette. Errors fill
as `[err] …` feedback — only the `_` is replaced, so the typed command
survives for correction.

Token order is free (`loading animation 75 red,blue _` works) —
classification is by shape: preset word, colour CSV (every item a
colour), bare number (interval), anything else = frames CSV.

Note: because the shape leads the sentence, prose like "the loading
animation is slow _" never routes here (doesn't start with the
keyword), but a sentence STARTING with "loading animation" and ending
in `_` is claimed and answered — the leading phrase is the routing
signal, mirroring `weather`/`location`.
