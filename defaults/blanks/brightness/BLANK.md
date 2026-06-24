---
name: brightness
type: blank
tip: screen brightness
speak: true
blankKeywords: brightness
# Match volume's proximity (3) so an inline value is reachable:
# "brightness 70 _" keeps the keyword within range of the `_` (the "70"
# sits between them). Without this (proximity 0) only the adjacent
# "brightness _" matched, and "brightness 70 _" fell through to fluid-blank.
blankProximity: 3
blankStep: 10
blankAutoPopulate: true
blankSuffix: %
# Raw "70%" is context-free; keep the "brightness" prefix so readers
# can tell volume / battery / brightness apart.
blankReplace: keep
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
