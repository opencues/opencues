---
name: volume
type: blank
tip: system volume
speak: true
blankKeywords: volume
blankStep: 6
blankAutoPopulate: true
blankSuffix: %
# Raw numeric answer ("70%") is context-free; keep the "volume" prefix
# in the buffer so readers know what 70% is measuring.
blankReplace: keep
blankScript: ./volume-blank.sh
# Auto-detect excludes chrome for `.sh` scripts. Override: with
# chrome-host installed the host runs scripts on chrome's behalf
# (path-sandboxed against CUE_ROOT). Without it the call exits 127 —
# acceptable failure mode; we'd rather surface "needs chrome-host"
# than hide the blank from the list entirely.
on-host: [chrome, claude-code, gemini-cli, opencode]
# Sandbox: declared OFF because volume-blank.sh needs:
#   - /mnt/c/ access (WSL) to reach VolCtl.exe (Windows Core Audio)
#   - nircmd.exe fallback in /mnt/c/Windows/
# Both are outside CUE_ROOT and intentionally so. A future bind-mount
# capability or sandbox-exec equivalent could let this run inside the
# sandbox; v1 keeps it unsandboxed with the path sandbox + audit log
# as the remaining defences.
sandbox: off
---
