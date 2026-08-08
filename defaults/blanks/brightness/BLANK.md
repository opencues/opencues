---
name: brightness
type: blank
tip: screen brightness
icon: 🔆
speak: true
blankKeywords: brightness
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
