---
name: brightness
type: blank
tip: screen brightness
icon: 🔆
speak: true
blankKeywords: brightness
# The prose road (`make it louder _`, `weather in oslo _`): this blank's closed values, each the shape action it
# takes, and whether a level (`number`) or a place / name (`named`) written in the draft may be captured.
device: true
values: up=step up; down=step down; current=get
number: true
blankStep: 10
blankAutoPopulate: true
blankSuffix: %
# A bare keyword get keeps its label (shape-derived; the blankReplace dial
# was deleted, June 2026) — the "brightness" prefix stays so readers can
# tell volume / battery / brightness apart.
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
