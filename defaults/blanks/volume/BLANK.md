---
name: volume
type: blank
tip: system volume
speak: true
blankKeywords: volume
blankStep: 6
blankAutoPopulate: true
blankSuffix: %
blankScript: ./volume-blank.sh
# Sandbox: declared OFF because volume-blank.sh needs:
#   - /mnt/c/ access (WSL) to reach VolCtl.exe (Windows Core Audio)
#   - nircmd.exe fallback in /mnt/c/Windows/
# Both are outside CUE_ROOT and intentionally so. A future bind-mount
# capability or sandbox-exec equivalent could let this run inside the
# sandbox; v1 keeps it unsandboxed with the path sandbox + audit log
# as the remaining defences.
sandbox: off
---
