---
name: volume
type: blank
tip: system volume
speak: true
blankKeywords: volume
# blankShapes: declarative intent gate (June 2026 — replaces the coarse
# blankProximity gate for this blank). The runtime walks each shape's
# pattern against the input up to and including `_`; first match wins.
# Anything not matching a shape drops the claim — fluid-blank takes the
# slot. Authors must order narrowest-first.
#
# Patterns are matched case-insensitively (`i` flag) with dotall (`s`).
# The literal `_` anchors the trigger position.
#
#   Shape 1 — bare GET:                volume _
#   Shape 2 — direct SET:              volume 70 _    /  volume 70% _
#   Shape 3 — verb-prefixed SET:       set volume to 70 _    /  set volume 70 _
#   Shape 4 — step direction:          volume up _    /  volume down _
#
# Anything else (prose like "the volume was great _", "the volume
# button is broken _", "please increase the volume _") matches no
# shape and the blank declines — fluid-blank takes the slot for a
# free-form lookup. That's the misfire-reduction win.
blankShapes: [{"pattern":"^volume\\s*_$","action":"get"},{"pattern":"^volume\\s+(\\d+)\\s*%?\\s*_$","action":"set","valueGroup":1},{"pattern":"^set\\s+volume\\s+(?:to\\s+)?(\\d+)\\s*%?\\s*_$","action":"set","valueGroup":1}]
# `volume up _` / `volume down _` step shapes deferred — needs script
# step branch that knows about blankStep. Cycling via Ctrl+Alt+↑/↓ on
# the substituted satellite still works the existing way.
# blankProximity retired in favour of blankShapes — the shape patterns
# define their own distance and intent. Kept here at 3 as a comment so
# pre-shape readers know the legacy behaviour.
# blankProximity: 3
blankStep: 6
blankAutoPopulate: true
# Tab-separated emission: the script now outputs `volume\t70%` so the
# runtime's existing blankSatellite path (blank-fill.ts:611) splices it
# as a single one-click-wipeable span (clearOnEdit). Replaces the prior
# raw-numeric + blankSuffix path.
blankSatellite: true
blankClearOnEdit: true
# blankConsumeContext: wipe the full summon (keyword + words between
# keyword and `_`) when the substitute fires. Combined with shapes,
# this gives `set volume to 70 _` → `volume 70%` (the "set" and "to"
# verbs vanish along with `70` and `_`).
blankConsumeContext: true
# blankReplace / blankSuffix retired — the selector-satellite emission
# carries the label + value as one wipeable unit; no in-buffer suffix
# to append separately.
blankScript: ./volume-blank.sh
# Sandbox: declared OFF because volume-blank.sh needs:
#   - /mnt/c/ access (WSL) to reach VolCtl.exe (Windows Core Audio)
#   - nircmd.exe fallback in /mnt/c/Windows/
# Both are outside CUE_ROOT and intentionally so. A future bind-mount
# capability or sandbox-exec equivalent could let this run inside the
# sandbox; v1 keeps it unsandboxed with the path sandbox + audit log
# as the remaining defences.
sandbox: off
# Blank-as-context: deliberately OFF. Volume is an ACTION blank
# (set/get system audio level), not an ambient data source. Surfacing
# it in fluid-blank's catalog would invite the LLM to substitute the
# current volume into prose that mentions "volume", which makes no
# user-facing sense ("draft an email about the volume _" → "70%").
as-context: off
---
