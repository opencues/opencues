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
# EXAMPLE: folder-based word-control (with colocated script)
# ─────────────────────────────────────────────────────────────────────
#
# Anything that runs a script MUST live in its own folder so the script
# can sit next to the cue.md and be referenced with a relative path.
# Layout for a "volume" control:
#
#   .opencues/controls/volume/
#     cue.md        ← frontmatter below
#     volume.sh     ← script invoked with upArgs / downArgs
#
# cue.md frontmatter:
#
#   ---
#   name: volume
#   type: control
#   control: volume
#   tip: system volume ± 5
#   speak: true
#   script: ./volume.sh        # path is relative to volume/cue.md
#   upArgs: ["up", "5"]
#   downArgs: ["down", "5"]
#   ---
#
# Scaffold this layout with:
#   opencues new control volume --project

# ─────────────────────────────────────────────────────────────────────
# EXAMPLE: monolithic declaration (zero-script controls only)
# ─────────────────────────────────────────────────────────────────────
#
# Use the inline `## Controls` block for controls that have NO script
# and short config — typically step or list controls. Anything needing
# a script belongs in a folder (see above).

# ## Controls
#
# ```json
# {
#   "units": {
#     "control": "units",
#     "tip": "step numeric values with unit suffixes",
#     "stepSuffixes": "px em rem % vh vw",
#     "step": 1,
#     "stepMin": 0
#   },
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
