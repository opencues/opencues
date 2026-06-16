---
name: volume
type: blank
tip: system volume
speak: true
blankKeywords: volume
# Allow up to 3 words between the keyword and `_` — so natural
# phrasings like `volume is _`, `volume was _`, `volume right now _`
# all fire the blank. Matches the proximity set on the network
# blanks (weather, countries, hackernews). Default proximity is 0
# (keyword must be directly adjacent to `_`), which would miss
# every copula form.
blankProximity: 3
blankStep: 6
blankAutoPopulate: true
blankSuffix: %
# Raw numeric answer ("70%") is context-free; keep the "volume" prefix
# in the buffer so readers know what 70% is measuring.
blankReplace: keep
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
