---
last_updated: 2026-04-06
---

# Cue-Controls

Cue-controls are words with built-in cycling behavior that bypasses the normal alternatives pipeline. They never show tips or alts in the secondary display (unless they have a `blankTip`). There are two kinds:

- **Custom cue-controls** — trigger external scripts instead of modifying text (e.g., "volume" runs a volume control script). Configured per-word with custom arguments for up/down directions.
- **Number cue-controls** — any word matching `/^-?\d+(\.\d+)?$/` is automatically a cue-control. Up increments, Down decrements (floored at the original value).

Cue-controls are checked **first** in the cycling function (`_cycleAlt`) before any alternative or linked-word cycling.

---

## How It Works

1. **Detection** — `_isCueControl(word)` returns true if the word matches the number regex or exists in `globalThis._cueControlOverrides` (case-insensitive lookup)
2. **On cycle (Up/Down)** — the cycling function checks `_actOvr[word.toLowerCase()]`. If a match exists, it spawns the configured script with direction-specific arguments. If no match but the word is a number, it increments or decrements the numeral
3. **In-memory state** — after the first press, the current value is read from the state file and cached in `globalThis._cueControlValues[control]`. Subsequent presses update the in-memory value only, avoiding file I/O on the hot path
4. **Debounced spawn** — rapid key presses (e.g., holding Up) only spawn the script once per 50ms via `globalThis._cueControlTimers`. The timer fires with the final accumulated value
5. **Clamping** — Word-based cue-control cycling hardcodes clamping to 0-100. The `blankRange` field is only used by `ControlBlankSource` for validation during auto-populate, not by the word-control cycling handler

---

## Configuration

`ControlConfig` (defined in `cues-md.ts`) has these fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `control` | string | (required) | Control identifier (e.g., "volume", "brightness") |
| `tip` | string | control name | Tip text shown in the secondary display when focused |
| `script` | string | `~/.claude/actions/{control}.sh` | Path to the script to spawn |
| `upArgs` | string[] | `["up"]` | Arguments passed when cycling up |
| `downArgs` | string[] | `["down"]` | Arguments passed when cycling down |
| `speak` | boolean | false | Read the tip aloud via TTS on navigation |
| `stateFile` | string | `/tmp/cue-control-{control}.txt` | File storing the current value (read on first press) |
| `blankKeywords` | string[] | (none) | Context words that bind a blank (`_`) to this control |
| `blankStep` | number | (from args) | Increment/decrement step size for control-bound blanks |
| `blankAutoPopulate` | boolean | false | Auto-fill blank with current control value on analysis |
| `blankRange` | [number, number] | `[0, 100]` | Min/max for validation during auto-populate (used by `ControlBlankSource`) |
| `blankTip` | string | (none) | Tip shown when the auto-populated blank value is highlighted |

Controls can be defined in two ways:
- **`controls.md`** — a JSON code block mapping control names to `ControlConfig` objects
- **Folder-based** — `controls/{name}/cue.md` with YAML frontmatter (`type: control`, plus config fields). Scripts are colocated in the same folder

Both are parsed into the same `ControlConfig` structure and merged into `_cueControlOverrides` at config load time.

---

## Script Protocol

When the user cycles a custom cue-control, the integration spawns:

```
bash {script} {args...}
```

- **Up:** `bash volume.sh up 10` (where `["up", "10"]` comes from `upArgs`)
- **Down:** `bash volume.sh down 10` (where `["down", "10"]` comes from `downArgs`)

**Spawn behavior:**
- **Detached, fire-and-forget** — `child_process.spawn` with `{detached: true, stdio: "ignore"}` and `.unref()`. The script runs independently; its exit code is not checked
- **Debounced** — if the user presses Up three times in 50ms, only one spawn fires with the final arguments
- **Path resolution** — `~` is expanded to `$HOME`. The default script path is `~/.claude/actions/{control}.sh`
- **WSL** — scripts run in the Linux environment. To control Windows applications, use `powershell.exe` or compiled `.exe` helpers inside the script

---

## Portability

### Standard (cues-core)

- `ControlConfig` type defines all control fields: `control`, `tip`, `script`, `upArgs`, `downArgs`, `speak`, `stateFile`, and blank-related fields
- `parseSingleCueMd` parses `cue.md` frontmatter into a typed `ControlConfig`
- `discoverFolderConfigs` finds `controls/{name}/cue.md` files and returns parsed configs
- `controls.md` JSON block parsing produces the same `ControlConfig` structure
- Number cue-control detection (regex match) is a simple pattern any integration can reuse

### Integration responsibilities

- Spawn external scripts with the correct arguments (up/down direction, current value)
- Use detached spawning for word-controls (fire-and-forget) vs. synchronous execution for control-blanks
- Read and write state files to track current control values between cycles
- Debounce rapid cycling to avoid spawning scripts on every keystroke
- Implement TTS invocation when `speak: true` is set on a control
- Display control tips in the secondary display (status line, tooltip, etc.)
- Handle platform differences for script execution (e.g., WSL path translation)
