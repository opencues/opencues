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
| `script` | No | string | Custom script path (overrides the default `~/.claude/actions/{control}.sh`) |
| `upArgs` | No | string[] | Arguments passed on Up. Default: `["up"]` |
| `downArgs` | No | string[] | Arguments passed on Down. Default: `["down"]` |

## 2. Write the control script

Create a script at `~/.claude/actions/{control}.sh`. The script receives the arguments from `upArgs` or `downArgs`:

```bash
#!/bin/bash
# ~/.claude/actions/volume.sh
# Called as: bash ~/.claude/actions/volume.sh up 5
#   $1 = direction ("up" or "down")
#   $2 = amount (e.g., "5")

DIRECTION="$1"
AMOUNT="${2:-10}"
STATE_FILE="/tmp/cue-control-volume.txt"

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

- **State file**: Read/write to `/tmp/cue-control-{control}.txt`. The CLI also reads this file to track current values, so write it immediately.
- **State format**: A single integer (0-100).
- **Non-blocking**: Background any slow system calls with `&`. The CLI spawns scripts with `detached: true, stdio: "ignore"` and doesn't wait for them.
- **Debouncing**: The CLI debounces rapid keypresses (50ms), so your script won't be called on every single keypress during fast cycling.

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

## Checklist

- [ ] Control defined in `controls.md` under `## Controls`
- [ ] Script exists at `~/.claude/actions/{control}.sh` (or custom `script` path)
- [ ] Script is executable (`chmod +x`)
- [ ] State file written to `/tmp/cue-control-{control}.txt` if stateful
- [ ] Slow operations backgrounded with `&`
