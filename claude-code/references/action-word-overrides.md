---
last_updated: 2026-03-27
---

# Action Word Overrides — Full Reference

> Extracted from CLAUDE.md. For the summary, see the main CLAUDE.md Feature 4 section.

## Prerequisites

Requires `enableWordHighlight: true` in config. The wordHighlight patch serializes `actionWordOverrides` into `globalThis._actionWordOverrides` at build time — without it, the variable is never set.

### WSL Setup (Required)

The volume script uses either nircmd or VBScript. If nircmd is not installed, **you must create the VBS helper files manually** — without them, `wscript.exe` will fail with "cannot find script file":

```bash
# From WSL:
echo 'Set s=CreateObject("WScript.Shell"):s.SendKeys chr(175)' > /mnt/c/Windows/Temp/volup.vbs
echo 'Set s=CreateObject("WScript.Shell"):s.SendKeys chr(174)' > /mnt/c/Windows/Temp/voldown.vbs
```

Or install nircmd (recommended) to bypass VBS entirely — see **Performance** section below.

## How It Works

- Config flows: `config.json` → `index.ts` → `wordHighlight.ts` (serializes to globalThis) → `dynamicHighlight.ts` (reads at runtime)
- `wordHighlight.ts` owns the globalThis assignment and navigation/rendering
- `dynamicHighlight.ts` checks action words FIRST in all 4 Up/Down handlers, spawns scripts
- Scripts are located in `~/.claude/actions/{action}.sh`
- Action words appear dimmed (gray) like numbers, highlighted white when selected
- The word is NOT modified (unlike numbers). It triggers an external action script.

## Config

In `~/.tweakcc/config.json` → `settings.misc`:
```json
"actionWordOverrides": {
  "volume": {
    "action": "volume",
    "upArgs": ["up", "5"],
    "downArgs": ["down", "5"]
  }
}
```

## External Script: `~/.claude/actions/volume.sh` (WSL-optimized)

```bash
#!/bin/bash
DIRECTION="$1"
AMOUNT="${2:-5}"
PRESSES=$((AMOUNT / 2))
[[ $PRESSES -lt 1 ]] && PRESSES=1

case "$DIRECTION" in
  up)
    if [[ -f /mnt/c/Windows/nircmd.exe ]]; then
      # Instant (~5ms) - best option
      /mnt/c/Windows/nircmd.exe changesysvolume $((AMOUNT * 655)) &
    else
      # VBScript fallback (~120ms) - needs Windows app focused
      for ((i=0; i<PRESSES; i++)); do
        wscript.exe //nologo "C:\\Windows\\Temp\\volup.vbs" &
      done
    fi
    ;;
  down)
    if [[ -f /mnt/c/Windows/nircmd.exe ]]; then
      /mnt/c/Windows/nircmd.exe changesysvolume -$((AMOUNT * 655)) &
    else
      for ((i=0; i<PRESSES; i++)); do
        wscript.exe //nologo "C:\\Windows\\Temp\\voldown.vbs" &
      done
    fi
    ;;
esac
```

**VBScript helpers** (create these for WSL without nircmd):
```
C:\Windows\Temp\volup.vbs:   Set s=CreateObject("WScript.Shell"):s.SendKeys chr(175)
C:\Windows\Temp\voldown.vbs: Set s=CreateObject("WScript.Shell"):s.SendKeys chr(174)
```

## Performance (WSL)

| Method | Latency | Notes |
|--------|---------|-------|
| nircmd | ~5ms | Best - instant, no focus needed |
| VBScript | ~120ms | Good - needs Windows app focused |
| PowerShell | ~1300ms | Avoid - too slow |

**Install nircmd** (recommended for instant response):
```powershell
# PowerShell as Admin:
iwr "https://www.nirsoft.net/utils/nircmd-x64.zip" -Out "$env:TEMP\n.zip"
Expand-Archive "$env:TEMP\n.zip" "$env:TEMP\n" -Force
copy "$env:TEMP\n\nircmd.exe" C:\Windows\
```

## Adding New Action Words

1. Add to `actionWordOverrides` in config with `action`, `upArgs`, `downArgs`
2. Create script at `~/.claude/actions/{action}.sh`
3. Make script executable: `chmod +x ~/.claude/actions/{action}.sh`
4. Re-apply patches

**Future extensions**: brightness, speed, zoom - any word with custom Up/Down behavior.

**Details**: See `docs/action-word-overrides.md` for full implementation guide.
