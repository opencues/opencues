---
name: project-blanks
domain: project
version: 1
---

# blanks.md
#
# Blanks: words that trigger external actions instead of cycling
# text alternatives. "volume" runs a volume script. "weather _" auto-
# populates with current weather. Etc.
#
# ─────────────────────────────────────────────────────────────────────
# TWO FORMS
# ─────────────────────────────────────────────────────────────────────
#
# 1. Folder-based (PREFERRED for anything with a script or multi-field config):
#
#    .opencues/blanks/<name>/
#      cue.md        — blank config in YAML frontmatter
#      <name>.sh     — optional colocated script (OS-bound blanks only)
#
#    Scaffold one with: `opencues new blank <name> --project`
#
# 2. Monolithic (THIS FILE — only useful for minimal zero-script blanks):
#
#    Single `## Blanks` block with JSON declarations. Good for simple
#    step blanks that just transform matched words; not good for
#    anything needing a script or long frontmatter.
#
# Folder-based entries merge with monolithic ones — folder wins on
# name conflicts.
#
# ─────────────────────────────────────────────────────────────────────
# BLANK TYPES
# ─────────────────────────────────────────────────────────────────────
#
# Word-blank: word triggers a script on Ctrl+Alt+Up/Down
#   Fields: control, tip, script, upArgs, downArgs, speak
#
# Typed blank: typing `_` near keyword auto-populates with current value
#   Fields: blankKeywords, blankAutoPopulate, blankScript, blankRange,
#           blankFormat, blankSuffix, blankStep, blankReadOnly,
#           blankDismissible, blankProximity, blankTip
#
# Step blank: cycles numeric values (e.g. "2.5f" → "3f") — no script
#   Fields: stepPattern OR stepSuffixes, step, stepMin, stepMax, stepFormat
#
# List blank: cycles a fixed list on a typed-blank position
#   Fields: stepValues (JSON array of strings)
#
# LLM/HTTP blank: implemented as TS class in @opencues/runtime
#   See docs/guides/adding-a-cue-blank.md — these live in
#   packages/opencues-runtime/src/blanks/<name>.ts, not in a cue.md
#
# ─────────────────────────────────────────────────────────────────────
# EXAMPLE: folder-based word-blank (with colocated script)
# ─────────────────────────────────────────────────────────────────────
#
# Anything that runs a script MUST live in its own folder so the script
# can sit next to the cue.md and be referenced with a relative path.
# Layout for a "volume" blank:
#
#   .opencues/blanks/volume/
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
#   opencues new blank volume --project

# ─────────────────────────────────────────────────────────────────────
# EXAMPLE: monolithic declaration (zero-script blanks only)
# ─────────────────────────────────────────────────────────────────────
#
# Use the inline `## Blanks` block for blanks that have NO script
# and short config — typically step or list blanks. Anything needing
# a script belongs in a folder (see above).

# ## Blanks
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

# For complete field reference see docs/features/cue-blanks.md and
# docs/guides/adding-a-cue-blank.md.
