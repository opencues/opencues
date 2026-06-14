---
name: brightness
type: blank
tip: screen brightness
speak: true
blankKeywords: brightness
# blankShapes: declarative intent gate (mirrors volume). Drops prose
# mentions of "brightness" from claiming the slot.
#   Shape 1 — bare GET:                brightness _
#   Shape 2 — direct SET:              brightness 70 _    /  brightness 70% _
#   Shape 3 — verb-prefixed SET:       set brightness to 70 _    /  set brightness 70 _
blankShapes: [{"pattern":"^brightness\\s*_$","action":"get"},{"pattern":"^brightness\\s+(\\d+)\\s*%?\\s*_$","action":"set","valueGroup":1},{"pattern":"^set\\s+brightness\\s+(?:to\\s+)?(\\d+)\\s*%?\\s*_$","action":"set","valueGroup":1}]
blankStep: 10
blankAutoPopulate: true
blankSatellite: true
blankClearOnEdit: true
blankConsumeContext: true
blankScript: ./brightness-blank.sh
# Sandbox: declared OFF — script calls system brightness controls
# (xrandr / Win32 / macOS via /mnt/c on WSL) that need filesystem
# access outside CUE_ROOT. Same trust posture as volume.
sandbox: off
# Blank-as-context: deliberately OFF. Action blank — same reasoning
# as volume; surfacing current brightness in ambient prose makes no
# user-facing sense.
as-context: off
---
