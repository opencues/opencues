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
| `control` | Yes | string | Identifier. Also used to construct the default script path: `~/.claude/opencues/scripts/{control}.sh` |
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

Create a script at `~/.claude/opencues/scripts/{control}.sh` (or colocate it in the control folder). The script receives the arguments from `upArgs` or `downArgs`:

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
4. Spawns: `bash ~/.claude/opencues/scripts/volume.sh up 5` (detached — integration doesn't wait)
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
# ~/.claude/opencues/scripts/docs.sh
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

## Adding an LLM/HTTP control

Controls that fetch data from web APIs or call LLMs are implemented as **TypeScript classes inside `@opencues/runtime`** (post the controls hoist refactor). Examples already in the runtime: `StocksControl`, `WeatherControl`, `HackerNewsControl`, `AnswerControl`, `PromptImproverControl`, `OpenCuesSettingsControl`.

This applies to both read-only API controls (e.g. stocks, weather) and dynamic list controls (e.g. Hacker News titles). The shape:

1. **Add a class** to `packages/opencues-runtime/src/controls/<name>.ts` implementing the `Control` interface from `./types`. Typically you implement `get(keyword, contextWords) → Promise<string>` (and optionally `set(value, keyword)` if it's writable). Return newline-separated output for dynamic lists.
2. **Export it** from `packages/opencues-runtime/src/controls/index.ts`.
3. **Register it** in each host's controls map:
   - CC: `integrations/claude-code/patches/opencuesRuntime.ts` — add a `__ocReg.set("<name>", new __ocCtl.YourControl({ ... }))` line in the `controlInvoke:` factory block
   - OC: `integrations/opencode/patches/opencuesBootstrap.ts:105-116` — add to `controlsRegistry`
   - Chrome: `integrations/chrome/src/controls/index.ts`
4. **Add the control's `cue.md`** under `controls/<name>/cue.md` declaring `blankKeywords`, `blankFormat`, `blankAutoPopulate`, etc. — same as before. The `blankScript:` field is **omitted** for hoisted controls; the host's `controlInvoke` dispatches by control name.

**Example `cue.md` (no blankScript field):**
```yaml
---
name: stocks
type: control
control: stocks
blankKeywords: reddit, rddt, nvidia, nvda, apple, aapl
blankAutoPopulate: true
blankFormat: string
blankTip: Stock price
blankReadOnly: true
blankProximity: 2
---
```

`@opencues/runtime`'s `BlankFill` module sees the cue.md, looks up `controlInvoke('stocks', { action: 'get', args: [keyword, ...contextWords] })`, the host's registry resolves `'stocks'` to the `StocksControl` instance, and the class's `get()` returns the price.

For dynamic list controls (Hacker News pattern): the class returns multiple newline-separated lines, the runtime treats each as a cycling alternative. Add `blankDismissible: true` to the cue.md to append `_` as the last option (lets users dismiss back to a blank).

For OS-level controls (e.g. `volume`, `brightness`): keep using shell scripts. They wrap platform-specific OS APIs that have no portable JavaScript replacement. The script lives next to the cue.md (`controls/volume/volume.sh` etc.) and `cue.md` declares `blankScript: ./volume-blank.sh` as before.

## Cycling pitfalls: numeric stepping vs list cycling

The control-blank cycling cascade has two paths, and a control must route to the correct one:

1. **Numeric stepping** — parses the displayed word as a number, adds/subtracts `blankStep`, calls `blankScript set <value>`. Used by volume, brightness.
2. **List cycling** — cycles through `alts[]` array by index. Used by hackernews, affirmations, and any control with `blankDismissible: true`.

**The routing rule:** if the control's metadata has `listControl: true`, it uses the list path. Otherwise it uses the numeric path.

**The pitfall:** if a control returns a value that *looks* like a number (e.g., `10.9°C`) but isn't meant to be stepped, the numeric path will parse it and increment it (`10.9°C` → `11.9` → `12.9`). This happens when:
- The control has `blankFormat: string` but NOT `listControl: true`
- The value contains digits that `parseFloat()` can extract

**The fix:** controls that return non-numeric string values AND have multiple alts (e.g., `blankDismissible: true`) must have `listControl: true` in their metadata. This is now automatic: `blankDismissible: true` in the config sets `listControl: true` on the WordDef's metadata in `ControlBlankSource`. But if you're manually constructing WordDefs for a custom control, remember to set it explicitly.

**When to use each:**
| Config | Cycling path | Example |
|--------|-------------|---------|
| `blankStep` or numeric `blankFormat` only | Numeric stepping | volume (`50%` → `56%`) |
| `blankDismissible: true` | List cycling (automatic) | weather (`10°C Drizzle` ↔ `_`) |
| `stepValues: [...]` | List cycling (automatic) | affirmations |
| Multi-line script output | List cycling (automatic) | hackernews |
| `blankReadOnly: true` only | No cycling (returns null) | stocks |

### Span invalidation: only word changes kill the span

For list/consume-all controls (`blankDismissible`, multi-line output), the resolved value is stored as a span covering one or more word positions. The runtime only invalidates this span when the **words at those positions change** — it does not invalidate on trailing spaces, punctuation appended elsewhere, or other non-word edits. This is intentional so the user can keep typing around a resolved blank without losing it.

**Implication for custom controls:** if you're building a control that should survive normal typing, this behaviour is already there. If your control's resolved value should be cleared the moment the user edits *anywhere* in the line, use `blankClearOnEdit: true` instead.

### `def.word` after auto-populate

When a blank auto-populates, the WordDef was created at `_` time, so `def.word = "_"`. The runtime patches `def.word` to the resolved value immediately after populate so that per-word invalidation can correctly match the span. It also prepends the resolved value to `def.alts` (via `alts.unshift`) so that cycling starts from the correct position.

**Implication for custom controls:** if you manually construct a WordDef outside of `ControlBlankSource` → auto-populate (e.g., in a custom integration), ensure `def.word` reflects the currently displayed value, not the keyword that triggered it. Otherwise the def will be silently discarded on the next keystroke.

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
