---
last_updated: 2026-04-08
---

# Cue-Controls

Cue-controls are words with built-in cycling behavior that bypasses the normal alternatives pipeline. They never show tips or alts in the secondary display (unless they have a `blankTip`). There are six kinds:

- **Custom cue-controls** — trigger external scripts instead of modifying text (e.g., "volume" runs a volume control script). Configured per-word with custom arguments for up/down directions.
- **Control-bound blanks** — blank positions (`_`) bound to a control via `blankKeywords`. The blank auto-populates with the live value from `blankScript get` and updates on each cycle.
- **Step controls** — words matching config-driven patterns (via `stepPattern` or `stepSuffixes` in `controls/` folder `cue.md` files) are incremented/decremented by a configurable step size, bounded by `stepMin`/`stepMax`. Supports suffixes like `f`, `px`, `em`.
- **List controls** — control-bound blanks with `stepValues` that cycle through an ordered list of values (e.g., affirmations). No script needed — uses normal alt cycling. Multi-word values are span-tracked.
- **Dynamic list controls** — control-bound blanks where `blankScript get` returns multiple lines, each becoming a cycling alternative (e.g., RSS feed titles from Hacker News). Same cycling behavior as `stepValues` but populated from live data.
- **Read-only controls** — control-bound blanks with `blankReadOnly: true` that fetch data from external APIs (e.g., stock prices via Finnhub). Auto-populate only, cycling disabled. The matched keyword is passed to the script for multi-lookup controls.

Cue-controls are checked **first** in the cycling function (`_cycleAlt`) before any alternative or linked-word cycling.

---

## How It Works

1. **Detection** — `_isCueControl(word)` returns true if the word exists in `globalThis._cueControlOverrides` (case-insensitive lookup) or matches any pattern in `globalThis._stepPatterns`
2. **On cycle (Up/Down)** — the cycling function checks `_actOvr[word.toLowerCase()]`. If a match exists, it spawns the configured script with direction-specific arguments. If no match but a step control pattern matches, it increments or decrements using the control's `step`/`stepMin`/`stepMax` config
3. **Debounced spawn** — rapid key presses (e.g., holding Up) only spawn the script once per 50ms via `globalThis._cueControlTimers`. The timer fires with the final accumulated value
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
| `blankKeywords` | string[] | (none) | Context words that bind a blank (`_`) to this control |
| `blankStep` | number | (from args) | Increment/decrement step size for control-bound blanks |
| `blankAutoPopulate` | boolean | false | Auto-fill blank with current control value on analysis |
| `blankRange` | [number, number] | `[0, 100]` | Min/max for validation during auto-populate (used by `ControlBlankSource`) |
| `blankTip` | string | (none) | Tip shown when the auto-populated blank value is highlighted |
| `blankSuffix` | string | (none) | Suffix appended to the displayed value (e.g. `%` shows `50%`). Stripped before arithmetic. Script always receives plain numbers. |
| `blankKeywordExpansions` | object | (none) | Map from keyword (lowercase) to display name. When auto-populate fires, the matched keyword word is replaced with its expansion (e.g. `rddt` → `Reddit`). |
| `blankClearKeywords` | boolean | `false` | Remove keyword context words from text on auto-populate. Only the resolved value remains. |
| `blankClearOnEdit` | boolean | `false` | Remove spawned words when user edits to something not in alts (selector/satellite pair cleanup). |

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

**Dynamic tip via `script get`:**

If the script responds to a `get` command, the integration calls `bash {script} get` on navigation and uses the output as the live status line tip — overriding the static `tip:` field. After each cycle (up/down), `get` is called again ~200ms later and the status line updates with the new value.

```bash
case "$1" in
  get)  echo "volume: $(query_system_volume)%" ; exit 0 ;;
  up)   ... ;;
  down) ... ;;
esac
```

- If `get` exits without output or fails, the static `tip:` field is used as fallback
- To disable the dynamic tip, remove the `get` case from the script (or have it exit 1)
- TTS (`speak: true`) fires once on navigation, not on each cycle update

---

## Portability

### Standard (cues-core)

- `ControlConfig` type defines all control fields: `control`, `tip`, `script`, `upArgs`, `downArgs`, `speak`, and blank-related fields
- `parseSingleCueMd` parses `cue.md` frontmatter into a typed `ControlConfig`
- `discoverFolderConfigs` finds `controls/{name}/cue.md` files and returns parsed configs
- `controls.md` JSON block parsing produces the same `ControlConfig` structure
- Step control patterns are auto-generated from `stepSuffixes` or explicit `stepPattern` — any integration can reuse the pattern-matching approach

### Integration responsibilities

- Spawn external scripts with the correct arguments (up/down direction, current value)
- Use detached spawning for word-controls (fire-and-forget) vs. synchronous execution for control-blanks
- Debounce rapid cycling to avoid spawning scripts on every keystroke
- Implement TTS invocation when `speak: true` is set on a control
- Display control tips in the secondary display (status line, tooltip, etc.)
- Handle platform differences for script execution (e.g., WSL path translation)
