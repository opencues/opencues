---
name: brightness
type: blank
tip: screen brightness
speak: true
blankKeywords: brightness
blankStep: 10
blankAutoPopulate: true
blankSuffix: %
blankScript: ./brightness-blank.sh
# Sandbox: declared OFF — script calls system brightness controls
# (xrandr / Win32 / macOS via /mnt/c on WSL) that need filesystem
# access outside CUE_ROOT. Same trust posture as volume.
sandbox: off
---
