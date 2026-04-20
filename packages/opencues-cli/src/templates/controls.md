# Project cue-controls
#
# Cue-controls are words that trigger external actions (volume, brightness,
# API fetches, LLM tools). Folder-based controls under `controls/<name>/`
# are the preferred form — this monolithic file is for ad-hoc overrides.
#
# Most users define controls as folders:
#
#   .opencues/controls/<name>/cue.md     # frontmatter declaring the control
#   .opencues/controls/<name>/<name>.sh  # OS-bound script (optional; LLM/HTTP
#                                        # controls are TS classes in @opencues/runtime)
#
# Use `opencues new control <name>` to scaffold one.
