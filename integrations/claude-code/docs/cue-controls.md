---
last_updated: 2026-03-27
---

# Cue-Controls — Claude Code

Implements feature [11](../../../docs/features/cue-controls.md). See that doc for the concept.

**Patch files:** `patches/wordHighlight.ts` (navigation + dimming), `patches/dynamicHighlight.ts` (cycling + script spawn)

Cue-controls are words with built-in cycling behavior that bypasses the normal alternatives pipeline. They never show tips or alts in the status line.

## Overview

There are three kinds of cue-control:

- **Custom cue-controls** — navigate to a word (like "volume") and press Ctrl+Alt+Up or Down to spawn an external script instead of modifying the word. This enables controlling system functions directly from the Claude Code input.
- **Control-bound blanks** — blank positions bound to a control via `blankKeywords`. The blank value is synced with the control's state file.
- **Step controls** — words matching config-driven patterns (via `stepPattern` or `stepSuffixes`) are incremented/decremented by a configurable step size. Supports suffixes like `f`, `px`, `em`, `%`. See `cycling.md` for config fields.
- **List controls** — control-bound blanks with `stepValues` that cycle through an ordered list of values. Type a keyword + `_`, the blank auto-populates with the first value, Up/Down cycles through the list. Multi-word values are span-tracked. No script needed.

The unified check `globalThis._isCueControl(word)` identifies custom controls (via `_cueControlOverrides`) and step controls (via `_stepPatterns`). It's used by the tips lookup (`lookupMultiple` with `skipFn`) and the status line export to exclude cue-controls from tips/alts display.

## How It Works

```
User types: "set volume to max"
           ↓
Navigate to "volume" (Ctrl+Alt+Left)
           ↓
Press Ctrl+Alt+Up
           ↓
cue-control check (FIRST priority)
  → Word "volume" found in cueControlOverrides
  → Spawn: ~/.claude/actions/volume.sh up 5
  → Return (skip step control/cycling logic)
           ↓
Volume increases
```

## Priority Order

Cue-controls are checked **FIRST** in `_cycleAlt()`, before any other logic:

1. **Cue-control (custom)** → spawn script, return
2. **Control-bound blanks** → sync script call, replace blank value, return
3. **Step control** → config-driven increment/decrement, return
4. **Alternatives** → cycle through alternatives
5. **Linked words** → co-dependent words cycle together

All Up/Down handlers (Ink key handlers and raw sequence handlers) delegate to `_cycleAlt` in `dynamicHighlight.ts`.

## Configuration

### In `~/.tweakcc/config.json`

```json
{
  "settings": {
    "misc": {
      "cueControlOverrides": {
        "volume": {
          "control": "volume",
          "upArgs": ["up", "5"],
          "downArgs": ["down", "5"]
        },
        "brightness": {
          "control": "brightness",
          "upArgs": ["up", "10"],
          "downArgs": ["down", "10"]
        }
      }
    }
  }
}
```

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `control` | string | Control identifier, used for default script path |
| `tip` | string? | Label shown in status line when highlighted |
| `script` | string? | Custom script path. Use `./script.sh` for folder-colocated scripts |
| `upArgs` | string[] | Arguments passed when Up is pressed |
| `downArgs` | string[] | Arguments passed when Down is pressed |
| `speak` | boolean? | Read the tip aloud via TTS when navigated to (default: false) |

### Script Resolution

Script path is resolved in this order:
1. `script` field value (supports `./` relative to folder for folder-based controls)
2. `~/.claude/actions/{control}.sh` (default)

### Folder-Based Controls

Controls can be self-contained folders instead of entries in `controls.md`:

```
controls/volume/
├── cue.md        # Control config in YAML frontmatter
└── volume.sh     # Colocated script (script: ./volume.sh)
```

See `docs/guides/adding-a-cue-control.md` for the full folder format.

## Script Implementation

### Location

```
~/.claude/actions/
├── volume.sh      # Volume control
├── brightness.sh  # Brightness control (future)
└── ...
```

### Script Interface

Scripts receive arguments as defined in config:
```bash
# For upArgs: ["up", "5"]
~/.claude/actions/volume.sh up 5

# For downArgs: ["down", "5"]
~/.claude/actions/volume.sh down 5
```

### Volume Script (WSL Optimized)

```bash
#!/bin/bash
# ~/.claude/actions/volume.sh
# Usage: volume.sh <up|down> <percent>

DIRECTION="$1"
AMOUNT="${2:-5}"
PRESSES=$((AMOUNT / 2))
[[ $PRESSES -lt 1 ]] && PRESSES=1

case "$DIRECTION" in
  up)
    if [[ -f /mnt/c/Windows/nircmd.exe ]]; then
      # Instant - best option (~5ms)
      /mnt/c/Windows/nircmd.exe changesysvolume $((AMOUNT * 655)) &
    else
      # VBScript fallback (~120ms)
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

### VBScript Helpers (Required for WSL without nircmd)

**You must create these files manually.** Without them, `wscript.exe` will fail with "cannot find script file". This is the most common setup issue on WSL.

```bash
# From WSL:
echo 'Set s=CreateObject("WScript.Shell"):s.SendKeys chr(175)' > /mnt/c/Windows/Temp/volup.vbs
echo 'Set s=CreateObject("WScript.Shell"):s.SendKeys chr(174)' > /mnt/c/Windows/Temp/voldown.vbs
```

Verify they exist:
```bash
cat /mnt/c/Windows/Temp/volup.vbs
# Expected: Set s=CreateObject("WScript.Shell"):s.SendKeys chr(175)
```

## Performance

| Method | Latency | Notes |
|--------|---------|-------|
| nircmd | ~5ms | Best - instant, no focus needed |
| VBScript (wscript) | ~120ms | Good - needs Windows app focused |
| PowerShell | ~1300ms | Slow - avoid |

### Installing nircmd (Recommended)

```powershell
# Run in PowerShell as Admin:
iwr "https://www.nirsoft.net/utils/nircmd-x64.zip" -Out "$env:TEMP\n.zip"
Expand-Archive "$env:TEMP\n.zip" "$env:TEMP\n" -Force
copy "$env:TEMP\n\nircmd.exe" C:\Windows\
```

## Visual Behavior

cue-controls follow the same visual pattern as step-controlled values:

| State | Appearance |
|-------|------------|
| Not highlighted | Dimmed (dark gray) |
| Highlighted | Bold white |

Cue-controls are always navigable.

## Prerequisites

cue-controls require `enableWordHighlight: true` in config. The `cueControlOverrides` config is serialized into cli.js by the wordHighlight patch — if wordHighlight is disabled, the globalThis variable is never set and cue-controls silently do nothing.

## Adding New cue-controls

1. **Add to config** (`~/.tweakcc/config.json`):
   ```json
   "brightness": {
     "control": "brightness",
     "upArgs": ["up", "10"],
     "downArgs": ["down", "10"]
   }
   ```

2. **Create script** (`~/.claude/actions/brightness.sh`):
   ```bash
   #!/bin/bash
   DIRECTION="$1"
   AMOUNT="${2:-10}"
   # Your brightness control logic here
   ```

3. **Make executable**:
   ```bash
   chmod +x ~/.claude/actions/brightness.sh
   ```

4. **Re-apply patches**:
   ```bash
   cd ~/tweakcc
   npm run build
   TWEAKCC_CC_INSTALLATION_PATH="..." node dist/index.mjs --apply
   ```

## Troubleshooting

### Script Not Running

1. Check script exists and is executable:
   ```bash
   ls -la ~/.claude/actions/volume.sh
   ```

2. Test script directly:
   ```bash
   ~/.claude/actions/volume.sh up 5
   ```

3. Check for Windows line endings (WSL):
   ```bash
   sed -i 's/\r$//' ~/.claude/actions/volume.sh
   ```

### "Cannot find script file" Error (WSL)

The VBS helper files must be created manually — they are NOT auto-generated. This is the most common cause of volume not working on WSL. See **VBScript Helpers** section above for the creation commands.

### Volume Not Changing (WSL)

1. **Create VBS helpers first** — see above section
2. **SendKeys requires focused Windows app** - click on a browser/app first
3. **Install nircmd** for focus-independent control (bypasses VBS entirely)
4. **Verify VBS helpers exist**:
   ```bash
   ls -la /mnt/c/Windows/Temp/volup.vbs /mnt/c/Windows/Temp/voldown.vbs
   ```

### cue-control Not Navigable

1. Verify word is in config (case-insensitive match)
2. Re-apply patches after config change
3. Check `globalThis._cueControlOverrides` in browser console

## Control-Bound Blanks

Control-bound blanks bridge blanks (`_`) with cue-controls. Typing `change volume _` auto-populates the blank with the current volume and cycling changes the actual system state.

See `docs/features/control-blanks.md` for full configuration reference.

### Implementation notes (Claude Code specific)

**Auto-populate mechanism**: The resolver callback sets `globalThis._pendingAutoPopulate`. This is consumed in the render-cycle IIFE in `wordHighlight.ts` (not in the resolver callback) because `onChange` must be called from a fresh React render context — stale closure references from `setTimeout` or async callbacks don't update the input.

**State file reads**: The `readControlState` callback reads the colocated `controls/{name}/state.txt`. Must use `${requireFuncName}("fs")`, never bare `require("fs")` — see `architecture.md` § Development Notes.

**Cycling**: The cycling handler calculates the target value (current + blankStep, clamped to blankRange), then calls `blankScript set <value>` via `execSync`. Uses `metadata.blankScript` — separate from the word-control `script` which handles `up`/`down`. Word-based controls use debounced `spawn` with direction args (fire-and-forget). Blank-controls are value-based and synchronous.

**Merge protection**: Grammar/LLM results cannot overwrite a control-blank WordDef (checked via `metadata.controlName`), but fresh control-blank results CAN replace stale ones.

**Cache invalidation**: When `_` reappears in the text, all control-blank WordDefs are cleared and re-analysis is forced, ensuring a fresh value read.

## Compiled Executables

`setup.sh` auto-compiles `.cs` files from both `patches/actions/` and `controls/*/` to `~/.claude/actions/` via the Windows .NET csc.exe compiler.

| Executable | Source | Purpose |
|------------|--------|---------|
| `VolCtl.exe` | `controls/volume/VolCtl.cs` | Volume via Core Audio API (`get`, `set`) |
| `BrightCtl.exe` | `patches/actions/BrightCtl.cs` | Brightness via powrprof.dll |
| `SpeakCtl.exe` | `patches/actions/SpeakCtl.cs` | TTS via System.Speech |

**VolCtl.exe** uses the Windows Core Audio API (via COM vtable calls) for:
- `get` — queries actual system volume as 0-100 integer
- `set <value>` — sets exact volume using `VolumeStepUp`/`VolumeStepDown`

COM initialization uses `COINIT_APARTMENTTHREADED` with MTA fallback — required for reliable operation when spawned from Node.js child processes.

SpeakCtl.exe requires `/reference:System.Speech.dll` — setup.sh handles this with a special case for the `SpeakCtl` base name.

## Related

- `docs/features/control-blanks.md` — full control-bound blanks feature reference
- `config.md` — all configuration options
- `architecture.md` — architecture overview + development notes
- `alternatives.md` — TTS details and external highlight preservation
