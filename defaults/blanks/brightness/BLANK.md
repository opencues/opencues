---
name: brightness
type: blank
tip: screen brightness
speak: true
blankKeywords: brightness
blankStep: 10
blankAutoPopulate: true
blankSuffix: %
# Raw "70%" is context-free; keep the "brightness" prefix so readers
# can tell volume / battery / brightness apart.
blankReplace: keep
blankScript: ./brightness-blank.sh
# Auto-detect excludes chrome for `.sh` scripts. Override: with
# chrome-host installed the host runs scripts on chrome's behalf
# (path-sandboxed against CUE_ROOT). Without it the call exits 127.
on-host: [chrome, claude-code, gemini-cli, opencode]
# Sandbox: declared OFF — script calls system brightness controls
# (xrandr / Win32 / macOS via /mnt/c on WSL) that need filesystem
# access outside CUE_ROOT. Same trust posture as volume.
sandbox: off
---
