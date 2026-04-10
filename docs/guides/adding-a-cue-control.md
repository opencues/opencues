---
last_updated: 2026-04-08
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
| `blankSuffix` | No | string | Suffix appended to the displayed blank value (e.g. `%` shows `50%`). Stripped before arithmetic; script always receives and returns plain numbers. |

**When to use each approach:**
- **Folder-based** (`controls/{name}/`) — preferred for anything with a script. Keeps the config and script colocated and self-contained.
- **Monolithic** (`controls.md`) — only useful for zero-script, config-only controls (e.g., a step control with just `stepSuffixes`). Scripts can't be colocated here.

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
# controls/mycontrol/mycontrol.sh
# Called as: bash controls/mycontrol/mycontrol.sh <get|up|down> [amount]
#   $1 = command ("get", "up", or "down")
#   $2 = amount (e.g., "5") — only used for up/down

DIRECTION="$1"
AMOUNT="${2:-10}"

# Live read: query actual system value (for `get` case only)
get_value() {
  my-system-query-command 2>/dev/null || echo "50"
}

case "$DIRECTION" in
  get)
    echo "mycontrol: $(get_value)"
    exit 0
    ;;
esac

# Apply change — let the system command handle delta internally
# Do NOT call get_value() here: it adds latency and causes a race with
# the integration's 200ms post-cycle `get` call.
my-system-command "$DIRECTION" "$AMOUNT"
```

### Script conventions

- **`get` command**: Implement a `get` case that outputs a human-readable tip (e.g. `"volume: 64%"`). The integration calls this on navigation and ~200ms after each cycle to update the status line.
- **No live-read in the apply path**: Do not call your live-read function before `up`/`down`. It adds latency and can cause a timing race where the integration's `get` call fires before the change completes. Let the underlying system command handle delta internally.
- **No `&` backgrounding**: Run the system command synchronously (no trailing `&`). The integration calls `get` 200ms after spawning — if the command is still running in the background, `get` reads a stale value.
- **Debouncing**: Word-based controls are debounced (50ms). Control-bound blanks (`blankScript`) run synchronously per keypress.

## 3. How it works at runtime

1. User types "volume" in their prompt and navigates to it
2. User presses Ctrl+Alt+Up or Ctrl+Alt+Down
3. The CLI looks up `"volume"` in `_cueControlOverrides`
4. Spawns: `bash ~/.claude/actions/volume.sh up 5` (detached — integration doesn't wait)
5. Script applies change synchronously, exits
6. Integration calls `bash volume.sh get` ~200ms later → status line updates with new value

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
blankDismissible: true
---
```

Type `affirmation _` → blank fills with "I am strong". Up/Down cycles: "I am brave" → "I am worthy" → "I am enough" → `_` to dismiss.

## Adding a read-only API control

Read-only controls fetch data from external APIs and display it in a blank. The user can view but not cycle the value.

**`controls/stocks/cue.md`:**
```yaml
---
name: stocks
type: control
control: stocks
blankKeywords: reddit, rddt, nvidia, nvda, apple, aapl
blankAutoPopulate: true
blankFormat: string
blankScript: ./stock-blank.sh
blankTip: Stock price
blankReadOnly: true
blankProximity: 2
---
```

**Key fields:**
- `blankReadOnly: true` — disables cycling (Up/Down is a no-op)
- `blankFormat: string` — value is text, not a number
- `blankProximity: 2` — allows `Reddit Stock _` (keyword 2 words from blank)

The script receives `get <keyword> [context words...]` where `keyword` is the matched `blankKeywords` entry, and context words are the other words from the input (excluding `_` and the keyword). A `tickers.json` mapping file resolves keywords to API parameters. See `controls/stocks/` for a complete example using the Finnhub API.

For controls that need richer context (e.g., a location AND a time modifier), the script scans the context words. See `controls/weather/` for an example — the script extracts location (any city/country via geocoding) and time (`tomorrow`, `weekend`, `weekly`) from context words.

## Adding a dynamic list control

Dynamic list controls fetch live data and let the user scroll through items. The key pattern: if `blankScript get` returns **multiple lines**, each line becomes a cycling alternative — same as `stepValues` but populated from a script.

**`controls/hackernews/cue.md`:**
```yaml
---
name: hackernews
type: control
control: hackernews
blankKeywords: hn, hackernews
blankAutoPopulate: true
blankFormat: string
blankScript: ./hn-blank.sh
blankTip: Hacker News
blankReadOnly: true
blankDismissible: true
blankProximity: 3
---
```

**Key fields:**
- `blankDismissible: true` — appends `_` as the last cycling option so the user can dismiss the list.
- The script returns one title per line — `ControlBlankSource` splits on newlines and creates alternatives.

Type `HN posts _` → auto-populates with top post. Up/Down scrolls through all posts. Cycle past the last → `_` to dismiss.

## Checklist

- [ ] Control folder created: `controls/{name}/cue.md` + script
- [ ] Script is executable (`chmod +x`)
- [ ] Script handles `get [keyword]`, `up <amount>`, `down <amount>` commands as needed
- [ ] Script queries live system value (no file caching)
- [ ] For control-bound blanks: `blankKeywords`, `blankAutoPopulate` set in `cue.md`
- [ ] For read-only blanks: `blankReadOnly: true` set in `cue.md`
- [ ] For keyword expansion: `blankKeywordExpansions.<keyword>: Display Name` set in `cue.md` (optional)
- [ ] For keyword clearing: `blankClearKeywords: true` to remove keywords from text on auto-populate (optional)
- [ ] For edit clearing: `blankClearOnEdit: true` to remove spawned words when user edits them (optional)
- [ ] For consume-all: `blankConsumeAll: true` + `blankClearKeywords: true` to clear entire input on auto-populate. Requires dedicated cycling storage — see `docs/guides/creating-a-cue-type.md`
- [ ] Restart Claude Code

> **No need to run `setup.sh`** — `.md` config files hot-reload within ~2s. `setup.sh` is only needed when editing the TypeScript patch files in `integrations/claude-code/patches/`.
