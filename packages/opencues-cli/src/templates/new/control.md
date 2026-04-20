---
# ─────────────────────────────────────────────────────────────────────
# Cue-control: {{NAME}}
# Created by `opencues new control {{NAME}}`.
# ─────────────────────────────────────────────────────────────────────
#
# A folder-based control. Pick ONE shape below by uncommenting the
# relevant block and deleting the others. Colocate any scripts in this
# same folder (e.g. ./{{NAME}}.sh) and reference with a relative path.
#
# For LLM/HTTP-backed controls, do NOT configure here — implement as a
# TS class under `packages/opencues-runtime/src/controls/<name>.ts` and
# register in each host's controlInvoke map. See
# docs/guides/adding-a-cue-control.md.

name: {{NAME}}
type: control
control: {{NAME}}

# ─────────────────────────────────────────────────────────────────────
# SHAPE 1: Word-control — cycling triggers external action
# ─────────────────────────────────────────────────────────────────────
# The word "{{NAME}}" in text becomes cyclable. Ctrl+Alt+Up/Down runs
# the script with the given args. Good for: volume, brightness, any
# system adjustment.
#
# Fields:
#   script:    path to script, relative to this cue.md
#   upArgs:    JSON array of args passed on Up-cycle
#   downArgs:  JSON array of args passed on Down-cycle
#   tip:       statusline tip when the word is highlighted
#   speak:     bool — read tip via TTS on navigation (default false)

# tip: "{{NAME}} control"
# speak: false
# script: ./{{NAME}}.sh
# upArgs: ["up", "5"]
# downArgs: ["down", "5"]

# ─────────────────────────────────────────────────────────────────────
# SHAPE 2: Blank-control — typing `_` near keyword auto-populates
# ─────────────────────────────────────────────────────────────────────
# When the user types `_` within `blankProximity` words of a keyword,
# the runtime calls `blankScript` (or uses `stepValues`) to populate
# the blank with the current value.
#
# Fields (all optional except blankKeywords):
#   blankKeywords:        comma-separated triggers (required)
#   blankAutoPopulate:    fill `_` immediately (default true)
#   blankScript:          script that returns the current value
#                         (called with no args; prints value to stdout)
#   blankRange:           "min-max" — clamps the value
#   blankFormat:          number | string (default string)
#   blankSuffix:          appended to numeric values (e.g. "%", "px")
#   blankStep:            step size for cycling (numeric blanks only)
#   blankReadOnly:        disable cycling (live API data, e.g. stocks)
#   blankDismissible:     allow `_` to be cleared to nothing (default false)
#   blankProximity:       max words between keyword + `_` (default 3)
#   blankTip:             statusline tip when the blank is highlighted
#   blankKeywordExpansions.<kw>: <expansion>   — per-keyword aliases
#                         (e.g. blankKeywordExpansions.nvda: Nvidia)

# blankKeywords: {{NAME}}
# blankAutoPopulate: true
# blankFormat: string
# blankTip: "{{NAME}} value"
# blankProximity: 3
# blankScript: ./{{NAME}}-blank.sh

# ─────────────────────────────────────────────────────────────────────
# SHAPE 3: Step control — numeric cycling, no script
# ─────────────────────────────────────────────────────────────────────
# Cycles numeric values with suffixes (e.g. "8.5f" → "9.0f" → "9.5f").
# No script needed; runtime handles the arithmetic.
#
# Fields (use stepPattern OR stepSuffixes, not both):
#   stepPattern:   regex with captures — (\d+)(px|em|rem)
#   stepSuffixes:  space-separated list — "px em rem %"
#   step:          increment (default 1)
#   stepMin:       lower bound (optional)
#   stepMax:       upper bound (optional)
#   stepFormat:    int | float (default int)
#   stepTip:       tip shown when a cyclable value is highlighted

# stepSuffixes: f
# step: 0.5
# stepMin: 0
# stepFormat: float
# stepTip: "±0.5f"

# ─────────────────────────────────────────────────────────────────────
# SHAPE 4: List control — cycles a fixed list on a blank position
# ─────────────────────────────────────────────────────────────────────
# Combines a blank-control keyword trigger with a fixed cycle list.
# e.g. "affirmation" keyword + `_` cycles "I am strong" / "I am brave".
#
# Fields:
#   blankKeywords: comma-separated triggers
#   stepValues:    JSON array of strings to cycle through
#   tip:           statusline tip on highlight
#   blankDismissible: allow clearing (default false)

# blankKeywords: {{NAME}}
# stepValues: ["first", "second", "third"]
# tip: "{{NAME}} options"
# blankDismissible: true
---
