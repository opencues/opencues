---
last_updated: 2026-04-06
---

# Control-Bound Blanks

Control-bound blanks bridge the **blanks** system (underscore fill-in) with **cue-controls** (external script execution). When you type a blank (`_`) near a control keyword, the system reads the control's current value, auto-populates the blank, and lets you cycle it with Up/Down to change the actual system state.

---

## How It Works

1. **Type** text with a blank and a control keyword: `change volume _`
2. **Auto-populate**: The `_` is replaced with the control's current value (e.g., `64`)
3. **Navigate** to the value (Ctrl+Alt+Left/Right) — it's dimmed to show it's interactive
4. **Cycle** with Ctrl+Alt+Up/Down — each press runs the control's script to change the actual value

---

## Configuration

Control-bound blanks are configured in the control's `cue.md` frontmatter:

```yaml
---
name: volume
type: control
control: volume
tip: system volume control
script: ./volume.sh                   # word-control: up/down commands
upArgs: ["up", "6"]
downArgs: ["down", "6"]
blankKeywords: volume, sound, audio   # context words that trigger blank binding
blankStep: 6                          # increment/decrement per cycle press
blankAutoPopulate: true               # replace _ with current value automatically
blankScript: ./volume-blank.sh        # blank-control: get/set commands (optional — defaults to script)
blankRange: [0, 100]                  # min/max for validation (optional — default: [0, 100])
blankFormat: integer                  # integer | float | string (optional — default: integer)
blankTip: volume +/- 6               # tip for status line (optional — default: none)
blankProximity: 0                    # max words between keyword and _ (optional — default: 0)
---
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `blankKeywords` | comma-separated string | *(required)* | Context words that bind a nearby `_` to this control. |
| `blankStep` | number | from `upArgs`/`downArgs`, or 1 | Increment/decrement per cycle press. |
| `blankAutoPopulate` | boolean | `false` | Replace `_` with the current value automatically. |
| `blankRange` | JSON array `[min, max]` | `[0, 100]` | Validation range. Values below `min` are rejected during auto-populate. Scripts handle clamping. |
| `blankFormat` | `integer` \| `float` \| `string` | `integer` | How the state value is parsed. `integer`: parseInt, `float`: parseFloat, `string`: raw text. |
| `blankTip` | string | *(none)* | Tip shown in status line when the auto-populated value is highlighted. Separate from the word-control `tip`. If omitted, nothing shows. |
| `blankScript` | string | falls back to `script` | Script for blank `get`/`set` commands. Separate from the word-control `script` (which handles `up`/`down`). Allows two scripts with different APIs. |
| `blankProximity` | number | `0` | Max words allowed between keyword and `_`. `0` means adjacent (`volume _`). `1` allows one word gap (`volume is _`). Higher values allow more distance. |
| `stepValues` | JSON string[] | *(none)* | Ordered list of values to cycle through instead of script-based arithmetic. Auto-populates with first value. Multi-word values are span-tracked. No script needed. |
| `blankReadOnly` | boolean | `false` | If true, cycling (Up/Down) is disabled — display-only blank. Used for values fetched from external APIs (e.g., stock prices) where the user can view but not change the value. |

### Tips Behaviour

Control-bound blank positions are **protected from LLM/grammar tip overrides**. When you navigate to an auto-populated value:

- If `blankTip` is set → that tip shows in the status line
- If `blankTip` is omitted → nothing shows (the status line is empty)
- Grammar, blanks, and all other LLM sources **cannot** set tips or alternatives on a control-bound blank position — the `metadata.controlName` marker prevents any overwrite

This is intentional: the auto-populated value is a live system reading, not a word the LLM should suggest alternatives for.

### Ownership Model: User Edit vs LLM Overwrite

This is the most important behaviour to get right when porting control-bound blanks to a new integration.

A control-bound blank position has **two types of incoming changes**, and they must be handled differently:

| Change source | What happens | Why |
|---------------|-------------|-----|
| **User edit** (typing, deleting) | `metadata.controlName` is **cleared**. The position becomes a normal word. Grammar/LLM can now provide alternatives. | The user intentionally changed the word — they're done with the control-blank. |
| **LLM/grammar result** (resolver callback) | `metadata.controlName` is **preserved**. The grammar result is **skipped**. | The LLM is offering unsolicited alternatives for a position the user didn't ask to change. The control value must not be overwritten. |

**How to distinguish them:**

The two changes arrive through different code paths:

1. **User edits** flow through the text-change detection layer (the render cycle). When the displayed text changes, the integration compares old vs new text word-by-word. If a word at a control-blank position changed to something not in its alternatives, the metadata is cleared — the user "unlocked" that position.

2. **LLM results** flow through the resolver callback. When merging new results into the existing WordDef array, the integration checks if the existing WordDef has `metadata.controlName`. If yes AND the new result is NOT a control-blank result, the merge is skipped.

**The invariant:** Only the user can clear `metadata.controlName`. The LLM cannot. This ensures control-blank positions are stable until the user explicitly edits them away.

**What goes wrong if you get this wrong:**

- **If LLM can overwrite control-blanks:** The auto-populated volume value (e.g., "64") gets replaced by grammar alternatives ("sixty-four", "numerous"). The position loses its control-blank behaviour. Cycling no longer changes the actual volume.
- **If user edits can't clear control-blanks:** The position is permanently stuck as a control-blank. Even after deleting "64" and typing "hello", the position stays dimmed and cycling tries to run the volume script. The user has no way to reclaim the position.

**Edge case — word removal:** When the user deletes text and the word count decreases, WordDefs at indices beyond the new text length must also have their metadata cleared. The position no longer exists, so the control-blank must not persist there.

### Keyword Matching

The system scans words in the input (case-insensitive) against each control's `blankKeywords`, subject to `blankProximity`. The keyword must be within `blankProximity` words of the `_`. The first control with a matching keyword wins.

Examples with `blankKeywords: volume, sound, audio` and `blankProximity: 0` (default):
- `volume _` — matches (0 words between)
- `set audio _` — no match (1 word "audio" is adjacent to `_`, but "set" is between... actually "audio" is at index 1, `_` is at index 2, gap = 0) — **matches**
- `volume is _` — no match (1 word between "volume" and `_`, exceeds proximity 0)
- `the _ is loud` — no match (no keyword present)

With `blankProximity: 1`:
- `volume is _` — matches (1 word between, within limit)
- `volume was not _` — no match (2 words between, exceeds limit)

---

## Script Requirements

A control can use **two separate scripts** — one for the word-control (`script`) and one for the blank-control (`blankScript`). This keeps the APIs clean:

### Word-control script (`script`)

Used when the user navigates to the control word and cycles. Simple direction-based API:

| Command | Purpose | Example |
|---------|---------|---------|
| `up <amount>` | Increase by amount | `volume.sh up 6` |
| `down <amount>` | Decrease by amount | `volume.sh down 6` |

The script reads the state file, calculates the new value, writes it back, then applies the change (e.g., via key presses). Runs in the background (fire-and-forget).

### Blank-control script (`blankScript`)

Used for auto-populate and blank cycling. Value-based API:

| Command | Purpose | Example |
|---------|---------|---------|
| `get [keyword]` | Return current value to stdout | `volume-blank.sh get` → `64` |
| `set <value>` | Set exact value | `volume-blank.sh set 70` |

The `get` command queries the actual system state. An optional `keyword` argument is passed when the control matches by `blankKeywords` — this allows one script to serve multiple lookups (e.g., `stock-blank.sh get reddit` resolves "reddit" → ticker "RDDT" → fetch price). The `set` command applies an exact target value. Both run synchronously.

If `blankScript` is not set, `script` is used for both — but it must then support `get`/`set` in addition to `up`/`down`.

If `state.txt` doesn't exist (first access), the system falls back to running `blankScript get [keyword]` to fetch the initial value. This enables API-calling controls that don't pre-populate state.

---

## State File

Each folder-based control has a colocated state file at `controls/{name}/state.txt`. The file contains the current value as a single line — the format depends on `blankFormat`:

| `blankFormat` | State file content | Example |
|---------------|-------------------|---------|
| `integer` | Single integer | `64` |
| `float` | Decimal number | `3.14` |
| `string` | Raw text | `#ff6600` |

State files are gitignored (`controls/*/state.txt`). They are:
- **Written** by the script after each `up`/`down` operation
- **Read** by the auto-populate system to get the current value
- **Read** by the cycling handler after script execution

---

## Architecture

### Standard (portable — any integration must implement)

These are the core behaviours that any integration of control-bound blanks must implement. They are defined by cues-core and the config format, not by any specific editor.

**Detection**: `ControlBlankSource` (priority 95) scans context words against `blankKeywords`. Priority 95 is higher than blanks `ClassifiedSourceGroup` (90) and grammar (75), ensuring control keywords match before the blank is classified as MATH or FACTUAL.

**CueResult contract**: When matched, `ControlBlankSource` returns a `CueResult` with:
- `alternatives`: `[currentValue]` (if `blankAutoPopulate`) or `["_"]`
- `source`: `"control-blank"`
- `metadata.controlName`: the control identifier
- `metadata.blankScript`: resolved path to the blank script (falls back to `script`)
- `metadata.blankStep`, `metadata.blankRange`, `metadata.blankFormat`: config-driven behaviour
- `metadata.stateFile`: path to colocated state file
- `cueTip`: from `blankTip` (or null)

**State I/O**: The `readControlState(controlName, matchedKeyword?, contextWords?)` callback (injected by the integration) reads the state file and returns a raw string. If `state.txt` is missing, it falls back to running `blankScript get [matchedKeyword] [contextWords...]`. The optional `matchedKeyword` allows one script to serve multiple lookups; `contextWords` provides the full sentence context (minus `_` and keyword) for scripts that need location, time, or other parameters from the input. Validation is config-driven: `blankRange[0]` for numeric min, `blankFormat` for parsing.

**Tip isolation**: Control-bound blank positions must NOT show tips from grammar/LLM sources. Only `blankTip` (if set) should display. The `metadata.controlName` marker identifies these positions.

**Cache invalidation**: When `_` reappears at a position that previously had a control-blank value, the old WordDef must be cleared and the resolver must re-run to get a fresh value.

#### Core components (in cues-core)

| Component | File | Role |
|-----------|------|------|
| `ControlBlankSource` | `packages/cues-core/src/sources/control-blank-source.ts` | CueSource: keyword matching, state read, CueResult |
| `ControlConfig` | `packages/cues-core/src/cues-md.ts` | All `blank*` fields + `stateFile` |
| `buildSourcesFromConfig` | `packages/cues-core/src/sources/build-sources.ts` | Wires ControlBlankSource when controls have `blankKeywords` |

### Integration responsibilities (what each editor must implement)

Any integration consuming cues-core needs to handle these for control-bound blanks:

| Responsibility | What to implement |
|----------------|-------------------|
| **`readControlState` callback** | Read the colocated `state.txt` and return raw string. On miss, fall back to running `blankScript get [keyword] [context...]`. Passed to `buildSourcesFromConfig`. |
| **Auto-populate** | When the resolver returns a control-blank result, replace `_` in the displayed text with the value. Timing depends on the editor's render cycle. |
| **Cycling** | On Up/Down at a control-blank position (identified by `metadata.controlName`), run the script with `upArgs`/`downArgs`, read new value from state file, update display. |
| **Result filter** | Allow control-blank results through even with 1 alternative (normal filters require >1). |
| **Navigation** | Make control-blank positions navigable (they may have only 1 alt). |
| **Dimming** | Dim control-blank positions to show they're interactive. |
| **Tip suppression** | Block grammar/LLM tips from overwriting control-blank positions. Only show `blankTip`. |
| **Cache invalidation** | Clear old control-blank WordDefs when `_` reappears. |

For Claude Code's implementation of these, see `integrations/claude-code/docs/cue-controls.md` § "Control-Bound Blanks".

---

## Example: Volume Control

A script-based control-bound blank that reads and sets the system volume. Demonstrates the two-script pattern (word-control + blank-control) with shared state.

```
controls/volume/
  cue.md              # Config: word-control + blank-control fields
  volume.sh           # Word-control: up/down via key presses (fast, shows OSD)
  volume-blank.sh     # Blank-control: get/set via Core Audio API (exact)
  VolCtl.cs           # C# source for Windows Core Audio API (compiled by setup.sh)
  state.txt           # Shared runtime state (gitignored)
```

**Key design choices:**
- **Two scripts** — `volume.sh` for word-control (debounced, fire-and-forget), `volume-blank.sh` for blank-control (synchronous, exact value).
- **Shared state file** — both scripts read/write `state.txt` for coordination.
- **`blankStep: 6`** — each Up/Down press changes volume by 6.
- **`blankAutoPopulate: true`** — `_` is replaced with the actual system volume.

**Usage:** Type `volume _` → blank fills with current volume (e.g., `64`). Navigate to the number, Up/Down changes volume by 6.

---

## Example: Stock Prices (External API)

A read-only control-blank that fetches stock prices from an external API. Demonstrates the `blankReadOnly`, `matchedKeyword`, and `tickers.json` mapping patterns.

```
controls/stocks/
  cue.md              # Config: blankKeywords for company names + tickers
  stock-blank.sh      # Blank-control: get <keyword> → resolve ticker → fetch price
  tickers.json        # Keyword-to-ticker mapping (reddit → RDDT, nvidia → NVDA)
```

**Key design choices:**
- **One folder for all stocks** — `blankKeywords` lists all known company names and tickers, `tickers.json` maps them to symbols.
- **`blankReadOnly: true`** — stock prices can't be changed, so cycling is disabled.
- **`blankProximity: 2`** — allows `Reddit Stock _` (keyword "reddit" is 2 words from `_`).
- **`blankFormat: string`** — prices are text, not numbers to be incremented.
- **`matchedKeyword` pipeline** — `ControlBlankSource` captures which keyword triggered the match ("reddit") and passes it to `readControlState`, which passes it to the script as `get reddit`.
- **Shared cache** — reuses `/tmp/ccline/stock_*.json` from the statusline component for zero redundant API calls.
- **Graceful degradation** — without `FINNHUB_API_KEY`, the script returns nothing and the blank stays as `_`.

**Usage:** Type `Reddit Stock _` → blank fills with current RDDT price. To add a new stock, add one entry to `tickers.json` and one keyword to `blankKeywords`.

---

## Example: Weather (Context-Driven API)

A read-only control-blank that fetches weather for any city or country. Demonstrates the `contextWords` pipeline — the script receives the full sentence context and extracts both location and time modifier.

```
controls/weather/
  cue.md              # Config: trigger keywords (weather, forecast, temp)
  weather-blank.sh    # Blank-control: geocodes location, fetches from Open-Meteo API
```

**Key design choices:**
- **Trigger keywords only** — `blankKeywords: weather, forecast, temp, temperature`. City/country names are NOT keywords — they're extracted from context by the script.
- **Any location** — the script geocodes whatever location word it finds in context via Open-Meteo's geocoding API. Works for cities (`Tokyo`), countries (`Uganda`), or neighborhoods (`Highgate`).
- **Reverse scan** — location is extracted by scanning context words from the end, skipping weather/time terms. In natural language the location is almost always the last meaningful word before `_` (e.g., "What is the weather in **London** _").
- **Time modifiers from context** — `tomorrow`, `weekend`, `weekly`/`7day`/`days` are detected from context words, not from `blankKeywords`. This means `forecast` is the trigger, and time/location are context.
- **`contextWords` pipeline** — `readControlState` passes all context words (minus `_` and the matched keyword) as extra args to the script. The script scans them for location and time modifiers.
- **Open-Meteo API** — free, no API key needed. Geocoding resolves any location, forecast API provides current + 7-day data.
- **5-minute cache** — results cached per location + mode combination.

**Usage:**
- `London weather _` → `19°C Clear`
- `Tokyo forecast tomorrow _` → `23°C Cloudy`
- `Uganda forecast weekend _` → `Sat 31°C Overcast, Sun 31°C Overcast`
- `Kenya forecast weekly _` → 7-day forecast
- `weather _` → default city (London)

---

## Adding a New Control-Bound Blank

1. Create a control folder: `controls/{name}/`
2. Add `cue.md` with `type: control` and blank fields (`blankKeywords`, `blankStep`, `blankAutoPopulate`)
3. Add a blank script that handles `get` and `set <value>`
4. Optionally add a separate word-control script for `up`/`down` (or use one script for both)
5. Set `blankScript: ./your-blank-script.sh` if using separate scripts
6. Run `setup.sh` to rebuild
7. Type `{keyword} _` to test
