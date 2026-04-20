---
name: project-controls
domain: project
version: 1
---

# controls.md
#
# Cue-controls: words that trigger external actions instead of cycling
# text alternatives. "volume" runs a volume script. "weather _" auto-
# populates with current weather. Etc.
#
# ─────────────────────────────────────────────────────────────────────
# TWO FORMS
# ─────────────────────────────────────────────────────────────────────
#
# 1. Folder-based (PREFERRED for anything with a script or multi-field config):
#
#    .opencues/controls/<name>/
#      cue.md        — control config in YAML frontmatter
#      <name>.sh     — optional colocated script (OS-bound controls only)
#
#    Scaffold one with: `opencues new control <name> --project`
#
# 2. Monolithic (THIS FILE — only useful for minimal zero-script controls):
#
#    Single `## Controls` block with JSON declarations. Good for simple
#    step controls that just transform matched words; not good for
#    anything needing a script or long frontmatter.
#
# Folder-based entries merge with monolithic ones — folder wins on
# name conflicts.
#
# ─────────────────────────────────────────────────────────────────────
# CONTROL TYPES
# ─────────────────────────────────────────────────────────────────────
#
# Word-control: word triggers a script on Ctrl+Alt+Up/Down
#   Fields: control, tip, script, upArgs, downArgs, speak
#
# Blank-control: typing `_` near keyword auto-populates with current value
#   Fields: blankKeywords, blankAutoPopulate, blankScript, blankRange,
#           blankFormat, blankSuffix, blankStep, blankReadOnly,
#           blankDismissible, blankProximity, blankTip
#
# Step control: cycles numeric values (e.g. "2.5f" → "3f") — no script
#   Fields: stepPattern OR stepSuffixes, step, stepMin, stepMax, stepFormat
#
# List control: cycles a fixed list on a blank-control position
#   Fields: stepValues (JSON array of strings)
#
# LLM/HTTP control: implemented as TS class in @opencues/runtime
#   See docs/guides/adding-a-cue-control.md — these live in
#   packages/opencues-runtime/src/controls/<name>.ts, not in a cue.md
#
# ─────────────────────────────────────────────────────────────────────
# EXAMPLE: monolithic declaration
# ─────────────────────────────────────────────────────────────────────
#
# Good for cases with NO scripts and short config. Most controls should
# go in .opencues/controls/<name>/cue.md folders instead.

# ## Controls
#
# ```json
# {
#   "volume": {
#     "control": "volume",
#     "tip": "system volume ± 5",
#     "speak": true,
#     "upArgs": ["up", "5"],
#     "downArgs": ["down", "5"]
#   },
#   "units": {
#     "control": "units",
#     "tip": "step numeric values with unit suffixes",
#     "stepSuffixes": "px em rem % vh vw",
#     "step": 1,
#     "stepMin": 0
#   }
# }
# ```

# ─────────────────────────────────────────────────────────────────────
# EXAMPLE: minimal step control inline (no folder needed)
# ─────────────────────────────────────────────────────────────────────
#
# Steps ANY `Nf` or `N.Nf` value by 0.5 (e.g. "8.5f" → "9.0f"):

# ## Controls
#
# ```json
# {
#   "f-values": {
#     "control": "f-values",
#     "stepSuffixes": "f",
#     "step": 0.5,
#     "stepFormat": "float"
#   }
# }
# ```

# For complete field reference see docs/features/cue-controls.md and
# docs/guides/adding-a-cue-control.md.
