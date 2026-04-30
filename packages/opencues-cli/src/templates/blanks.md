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
# BLANK SHAPES
# ─────────────────────────────────────────────────────────────────────
#
# A blank is a `_`-triggered slot. The user types your keyword followed
# by `_`, and your script / runtime class fills the slot. There are
# four shapes:
#
# 1. Typed blank with script
#    Fields: blankKeywords, blankScript, blankAutoPopulate, blankFormat,
#            blankSuffix, blankStep, blankReadOnly, blankProximity,
#            blankTip, blankDismissible
#    Example: defaults/blanks/volume/cue.md
#
# 2. List blank (no script — fixed cycle list)
#    Fields: blankKeywords, stepValues, tip, blankDismissible
#    Example: defaults/blanks/affirmations/cue.md
#
# 3. Selector + Satellite (two-word span)
#    Adds: blankSatellite, blankSatelliteSeparator, blankClearKeywords,
#          blankClearOnEdit
#    Example: defaults/blanks/opencues/cue.md
#
# 4. Runtime-class blank (LLM/HTTP-backed — TS class, no script)
#    Implementation: packages/opencues-runtime/src/blanks/<name>.ts
#    cue.md just declares blankKeywords + blankReadOnly + blankFormat
#    Examples: defaults/blanks/{stocks,weather,hackernews,prompt}/cue.md
#
# ─────────────────────────────────────────────────────────────────────
# EXAMPLE: folder-based blank with a colocated script
# ─────────────────────────────────────────────────────────────────────
#
# Anything that runs a script MUST live in its own folder so the script
# can sit next to the cue.md and be referenced with a relative path.
# Layout for a "volume" blank:
#
#   .opencues/blanks/volume/
#     cue.md              ← frontmatter below
#     volume-blank.sh     ← responds to `get` and `set <value>`
#
# cue.md frontmatter:
#
#   ---
#   name: volume
#   type: blank
#   tip: system volume
#   speak: true
#   blankKeywords: volume, vol
#   blankScript: ./volume-blank.sh
#   blankAutoPopulate: true
#   blankFormat: integer
#   blankSuffix: %
#   blankStep: 5
#   ---
#
# Scaffold this layout with:
#   opencues new blank volume --project

# For complete field reference see docs/features/cue-blanks.md and
# docs/guides/adding-a-cue-blank.md.
