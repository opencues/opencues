---
last_updated: 2026-04-03
---

# Adding a Cue-Control

Cue-controls are words that trigger external scripts instead of cycling through text alternatives. For example, "volume" triggers a volume control script when the user presses Up/Down on it.

## 1. Define the control in controls.md

Add an entry to the `## Controls` JSON block in your `controls.md` file:

```markdown
## Controls

```json
{
  "volume": {
    "control": "volume",
    "tip": "system volume control",
    "upArgs": ["up", "5"],
    "downArgs": ["down", "5"]
  }
}
```
```

### ControlConfig fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `control` | Yes | string | Identifier. Also used to construct the default script path: `~/.claude/actions/{control}.sh` |
| `tip` | No | string | Label shown in the status line when the word is highlighted |
| `script` | No | string | Custom script path (overrides the default). Use `./script.sh` for folder-colocated scripts |
| `upArgs` | No | string[] | Arguments passed on Up. Default: `["up"]` |
| `downArgs` | No | string[] | Arguments passed on Down. Default: `["down"]` |
| `speak` | No | boolean | Read the tip aloud via TTS when navigated to (default: false) |

## Alternative: Folder-based control

Instead of `controls.md`, create a self-contained folder with the config and script together:

```
controls/volume/
├── cue.md        # Control config in YAML frontmatter
└── volume.sh     # Script colocated (script: ./volume.sh)
```

**`controls/volume/cue.md`:**
```markdown
---
name: volume
type: control
control: volume
tip: system volume control
speak: true
script: ./volume.sh
upArgs: ["up", "6"]
downArgs: ["down", "6"]
---
```

Relative `script` paths (starting with `./`) are resolved against the folder. Folder configs merge with `controls.md` — folder wins on name conflict.

## 2. Write the control script

Create a script at `~/.claude/actions/{control}.sh` (or colocate it in the control folder). The script receives the arguments from `upArgs` or `downArgs`:

```bash
#!/bin/bash
# controls/volume/volume.sh
# Called as: bash controls/volume/volume.sh up 5
#   $1 = direction ("up", "down", or "get")
#   $2 = amount (e.g., "5")

DIRECTION="$1"
AMOUNT="${2:-10}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/state.txt"

# Read current state (default 50)
CURRENT=50
[ -f "$STATE_FILE" ] && CURRENT=$(tr -dc '0-9' < "$STATE_FILE")
CURRENT=${CURRENT:-50}

# Calculate new value (clamped 0-100)
case "$DIRECTION" in
  up)   NEW=$((CURRENT + AMOUNT)); [ "$NEW" -gt 100 ] && NEW=100 ;;
  down) NEW=$((CURRENT - AMOUNT)); [ "$NEW" -lt 0 ] && NEW=0 ;;
esac

# Write state immediately (so the CLI can read it)
echo "$NEW" > "$STATE_FILE"

# Do the actual work (backgrounded, non-blocking)
my-system-command "$DIRECTION" "$AMOUNT" &
```

### Script conventions

- **State file**: Read/write to `controls/{name}/state.txt` (colocated with `cue.md`). The CLI reads this file for auto-populate and value tracking, so write it immediately.
- **State format**: A single value per line. Format depends on `blankFormat`: integer (default), float, or raw string.
- **Non-blocking**: For word-based controls, background slow system calls with `&`. For control-bound blanks, the script runs synchronously so the state file is ready when the CLI reads it back.
- **Debouncing**: Word-based controls are debounced (50ms). Control-bound blanks run synchronously per keypress.

## 3. How it works at runtime

1. User types "volume" in their prompt and navigates to it
2. User presses Ctrl+Alt+Up or Ctrl+Alt+Down
3. The CLI looks up `"volume"` in `_cueControlOverrides`
4. Spawns: `bash ~/.claude/actions/volume.sh up 5`
5. Script runs in background, updates state file
6. Status line shows current value (e.g., "volume (55%)")

## Example: minimal control

A cue-control that opens a URL:

```json
{
  "docs": {
    "control": "docs",
    "tip": "open project docs",
    "upArgs": ["open"],
    "downArgs": ["open"]
  }
}
```

```bash
#!/bin/bash
# ~/.claude/actions/docs.sh
xdg-open "https://docs.example.com" &
```

## Adding a step control

Step controls are a type of cue-control that increments/decrements values matching a pattern — no external script needed for arithmetic stepping.

**`controls/units/cue.md`:**
```yaml
---
type: control
name: units
stepSuffixes: px em rem f % vh vw
step: 1
stepMin: 0
---
```

This makes `10px`, `2em`, `1.5f`, `50%`, etc. steppable. Each suffix auto-generates a regex pattern like `^\d+(\.\d+)?px$`.

### Step control config fields

| Field | Type | Description |
|-------|------|-------------|
| `stepPattern` | string | Regex matching steppable values (alternative to `stepSuffixes`) |
| `stepSuffixes` | string | Space-separated suffixes — auto-generates patterns per suffix |
| `step` | number | Arithmetic step size (default: 1) |
| `stepMin` | number | Floor — Down will not go below this |
| `stepMax` | number | Ceiling — Up will not go above this |
| `stepFormat` | string | Output format: `integer`, `float`, or auto |
| `stepSuffix` | string | Single suffix to strip/re-append (use `stepSuffixes` for multiple) |
| `stepScript` | string | Script called with `(current_value, direction)` — overrides arithmetic |
| `stepValues` | string[] | Ordered list of values to cycle through on a control-bound blank (JSON array) |

Use separate control folders for different step sizes (e.g., `controls/units/` for step 1, `controls/fine-units/` for step 0.1).

## Adding a list control

List controls cycle through an ordered set of values on a control-bound blank — no script, no arithmetic. Type a keyword + `_` and the blank auto-populates with the first value; Up/Down cycles through the list. Multi-word values are span-tracked automatically.

**`controls/affirmations/cue.md`:**
```yaml
---
type: control
name: affirmations
blankKeywords: affirmation, affirm
stepValues: ["I am strong", "I am brave", "I am worthy", "I am enough"]
tip: Daily affirmations
---
```

Type `affirmation _` → blank fills with "I am strong". Up/Down cycles: "I am brave" → "I am worthy" → "I am enough" → wraps.

## Checklist

- [ ] Control folder created: `controls/{name}/cue.md` + script
- [ ] Script is executable (`chmod +x`)
- [ ] Script handles `get`, `up <amount>`, `down <amount>` commands
- [ ] State file written to `controls/{name}/state.txt` if stateful
- [ ] For control-bound blanks: `blankKeywords`, `blankStep`, `blankAutoPopulate` set in `cue.md`
- [ ] Run `setup.sh` to rebuild
