---
name: volume
type: blank
tip: system volume
icon: 🔊
speak: true
blankKeywords: volume
blankStep: 6
blankAutoPopulate: true
blankSuffix: %
# A bare keyword get keeps its label (shape-derived; the blankReplace dial
# was deleted, June 2026) — the "volume" prefix stays so readers know what
# 70% is measuring.
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
