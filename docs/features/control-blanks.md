---
last_updated: 2026-04-08
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
blankSuffix: %                        # suffix appended to displayed value — script always uses plain numbers
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
| `blankDismissible` | boolean | `false` | If true, `_` is appended as the last cycling option so the user can dismiss the value. Once dismissed, auto-populate will not re-fire until the text changes. |
| `blankSuffix` | string | *(none)* | Suffix appended to the displayed value (e.g. `%` shows `50%`). Stripped before arithmetic, re-appended after cycling. The script always receives and returns plain numbers. |
| `blankKeywordExpansions` | object | *(none)* | Map from keyword (lowercase) to display name. When a blank auto-populates, the matched keyword in the text is replaced with its expansion (e.g. `rddt` → `Reddit`). Supports dot-notation (`blankKeywordExpansions.rddt: Reddit`) or JSON (`blankKeywordExpansions: {"rddt":"Reddit"}`). |
| `blankClearKeywords` | boolean | `false` | If true, keyword context words are removed from the text when the blank auto-populates. Only the resolved value remains (e.g. `opencues settings _` → `voice-mode active`). Keywords can be multi-word phrases (e.g. `opencues settings` as one keyword). |
| `blankClearOnEdit` | boolean | `false` | If true, editing the auto-populated value to something not in alts removes the spawned words from the text entirely. For selector/satellite pairs, both the selector and satellite are removed. |
| `blankConsumeAll` | boolean | `false` | If true, ALL non-blank word indices are added to `blankKeywordIndices`. Combined with `blankClearKeywords: true`, this clears the entire input on auto-populate — not just keywords. Used for controls where the surrounding text is the input (e.g., a prompt to improve). See [Consume-All Blanks](consume-all-blanks.md). |

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

The system scans words in the input (case-insensitive) against each control's `blankKeywords`, checking **all occurrences** of each keyword, subject to `blankProximity`. The keyword must be within `blankProximity` words of the `_` — if a keyword appears multiple times, any occurrence within range is sufficient. The first control with a matching keyword wins.

Gap = number of words strictly between the keyword and `_` (not counting either). Examples with `blankKeywords: volume, sound, audio`:

With `blankProximity: 0` (default, adjacent only):
- `volume _` — matches (gap = 0)
- `set audio _` — matches (`audio` and `_` are adjacent, gap = 0; words before the keyword don't count)
- `volume is _` — no match (gap = 1, exceeds limit)
- `the _ is loud` — no match (no keyword present)

With `blankProximity: 1`:
- `volume is _` — matches (gap = 1, within limit)
- `volume was not _` — no match (gap = 2, exceeds limit)

Multiple occurrences — with `blankKeywords: weather` and `blankProximity: 0`:
- `spanish weather 15°C is warmer than london weather _` — matches (the second `weather` is adjacent to `_`)

---

## Script Requirements

A control can use **two separate scripts** — one for the word-control (`script`) and one for the blank-control (`blankScript`). This keeps the APIs clean:

### Word-control script (`script`)

Used when the user navigates to the control word and cycles. Simple direction-based API:

| Command | Purpose | Example |
|---------|---------|---------|
| `up <amount>` | Increase by amount | `volume.sh up 6` |
| `down <amount>` | Decrease by amount | `volume.sh down 6` |

The script queries the current live value, calculates the new value, then applies the change (e.g., via key presses). Runs in the background (fire-and-forget).

### Blank-control script (`blankScript`)

Used for auto-populate and blank cycling. Value-based API:

| Command | Purpose | Example |
|---------|---------|---------|
| `get [keyword]` | Return current value to stdout | `volume-blank.sh get` → `64` |
| `set <value>` | Set exact value | `volume-blank.sh set 70` |

The `get` command queries the actual system state. An optional `keyword` argument is passed when the control matches by `blankKeywords` — this allows one script to serve multiple lookups (e.g., `stock-blank.sh get reddit` resolves "reddit" → ticker "RDDT" → fetch price). The `set` command applies an exact target value. Both run synchronously.

If `blankScript` is not set, `script` is used for both — but it must then support `get`/`set` in addition to `up`/`down`.

Auto-populate always calls `blankScript get` for the current value — no file caching. Scripts are expected to query the system directly.

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
- `cueTip`: from `blankTip` (or null)

**State I/O**: The `readControlState(controlName, matchedKeyword?, contextWords?)` callback (injected by the integration) calls `blankScript get [matchedKeyword] [contextWords...]` and returns the raw string output. The optional `matchedKeyword` allows one script to serve multiple lookups; `contextWords` provides the full sentence context (minus `_` and keyword) for scripts that need location, time, or other parameters from the input. Validation is config-driven: `blankRange[0]` for numeric min, `blankFormat` for parsing.

**Tip isolation**: Control-bound blank positions must NOT show tips from grammar/LLM sources. Only `blankTip` (if set) should display. The `metadata.controlName` marker identifies these positions. Selector/satellite blanks also have `metadata.controlName` but use the `opencues.md` `tips:` block instead of `blankTip` — see [Tip Priority](tip-priority.md).

**Cache invalidation**: When `_` reappears at a position that previously had a control-blank value, the old WordDef must be cleared and the resolver must re-run to get a fresh value.

#### Core components (in cues-core)

| Component | File | Role |
|-----------|------|------|
| `ControlBlankSource` | `packages/opencues-core/src/sources/control-blank-source.ts` | CueSource: keyword matching, state read, CueResult |
| `ControlConfig` | `packages/opencues-core/src/cues-md.ts` | All `blank*` fields |
| `buildSourcesFromConfig` | `packages/opencues-core/src/sources/build-sources.ts` | Wires ControlBlankSource when controls have `blankKeywords` |

### Integration responsibilities (what each editor must implement)

Any integration consuming cues-core needs to handle these for control-bound blanks:

| Responsibility | What to implement |
|----------------|-------------------|
| **`readControlState` callback** | Call `blankScript get [keyword] [context...]` and return the output. Passed to `buildSourcesFromConfig`. |
| **Auto-populate** | When the resolver returns a control-blank result, replace `_` in the displayed text with the value. Timing depends on the editor's render cycle. |
| **Cycling** | On Up/Down at a control-blank position (identified by `metadata.controlName`), run the script with `upArgs`/`downArgs`, then call `script get` to read the new live value and update display. |
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
```

**Key design choices:**
- **Two scripts** — `volume.sh` for word-control (debounced, fire-and-forget), `volume-blank.sh` for blank-control (synchronous, exact value).
- **Always live** — both scripts query the OS directly. No caching.
- **`blankStep: 6`** — each Up/Down press changes volume by 6.
- **`blankAutoPopulate: true`** — `_` is replaced with the actual system volume.

**Usage:** Type `volume _` → blank fills with current volume (e.g., `64`). Navigate to the number, Up/Down changes volume by 6.

---

## Example: Brightness Control

A script-based control-bound blank that reads and sets the system display brightness. Demonstrates the same two-script pattern as volume — word-control for key-press cycling, blank-control for exact get/set.

```
controls/brightness/
  cue.md                # Config: word-control + blank-control fields
  brightness.sh         # Word-control: up/down via BrightCtl.exe (native powrprof.dll)
  brightness-blank.sh   # Blank-control: get/set via BrightCtl.exe
  (BrightCtl.cs compiled to ~/.claude/opencues/scripts/BrightCtl.exe by setup.sh)
```

**Key design choices:**
- **Two scripts** — `brightness.sh` for word-control (debounced, fire-and-forget), `brightness-blank.sh` for blank-control (synchronous, exact value).
- **Always live** — both scripts query the OS directly via `BrightCtl.exe get`. No caching.
- **`blankStep: 10`** — each Up/Down press changes brightness by 10.
- **`blankAutoPopulate: true`** — `_` is replaced with the actual system brightness.
- **BrightCtl.exe `set` command** — blank-control uses `BrightCtl.exe set <value>` (exact value), matching the VolCtl.exe `set` convention.

**Usage:** Type `brightness _` → blank fills with current brightness (e.g., `70`). Navigate to the number, Up/Down changes brightness by 10.

---

## LLM/HTTP controls — implemented as TS classes in the runtime

The original `stocks`, `weather`, `hackernews`, `prompt` (improver), `answer`, and
`opencues` (settings) controls were shell scripts (`stock-blank.sh`,
`hn-blank.sh`, etc.) that hosts spawned via `controlInvoke` → `spawnProcess`.
During the controls hoist refactor, all six were ported to TypeScript classes
inside `@opencues/runtime` so the chrome extension (which can't `spawn` from
a content script) could use them too. The shell scripts were deleted; the
runtime classes are now the source of truth across all hosts.

| Control | Class | Purpose |
|---|---|---|
| `stocks` | [`StocksControl`](../../packages/opencues-runtime/src/controls/stocks.ts) | Finnhub price lookup (`Reddit stock _` → `$133.44`) |
| `weather` | [`WeatherControl`](../../packages/opencues-runtime/src/controls/weather.ts) | Open-Meteo geocode + forecast (`London weather _` → `19°C Clear`) |
| `hackernews` | [`HackerNewsControl`](../../packages/opencues-runtime/src/controls/hackernews.ts) | RSS fetch → dynamic list of post titles |
| `prompt` | [`PromptImproverControl`](../../packages/opencues-runtime/src/controls/prompt-improver.ts) | Two-step LLM: extract → improve, returns 3 alts (consume-all pattern) |
| `answer` | [`AnswerControl`](../../packages/opencues-runtime/src/controls/answer.ts) | LLM keyword + context → 3 candidate answers |
| `opencues` | [`OpenCuesSettingsControl`](../../packages/opencues-runtime/src/controls/opencues-settings.ts) | Read/write `opencues.md` scalars (selector/satellite settings) |

Each host integration assembles a `Map<string, Control>` and passes it to
`createControlInvoke()` which becomes the host's `controlInvoke` binding. See
`integrations/opencode/patches/opencuesBootstrap.ts` (lines 105-116) and
`integrations/claude-code/patches/opencuesRuntime.ts` (the `controlInvoke:` block) for
the wiring pattern.

The `controls/<name>/cue.md` config files for these stay where they are —
they declare keywords, formats, and behaviour. The `cue.md` no longer points
at a shell script (no `script:` / `blankScript:` field for hoisted controls);
the host's `controlInvoke` handles dispatch by name.

**Adding a new LLM/HTTP control:** add a class to
`packages/opencues-runtime/src/controls/`, export it from `index.ts`, and
register it in each host's controls map. See [adding-a-cue-control.md](../guides/adding-a-cue-control.md).

## OS-level controls — still shell scripts

`volume` and `brightness` continue to ship as `.sh` files (with `.cs` →
`.exe` shims for WSL). They wrap platform-specific OS APIs (`amixer`,
`AppleScript`, `pactl`, Windows Core Audio) — there's no portable
JavaScript replacement, so a TS class would just be `child_process.spawn`
boilerplate around the same shell calls. Hosts that can spawn processes
(CC, OC) call them via `spawnProcess`; the chrome extension simply doesn't
support them.

---

## Adding a New Control-Bound Blank

1. Create a control folder: `controls/{name}/`
2. Add `cue.md` with `type: control` and blank fields (`blankKeywords`, `blankStep`, `blankAutoPopulate`)
3. Add a blank script that handles `get` and `set <value>`
4. Optionally add a separate word-control script for `up`/`down` (or use one script for both)
5. Set `blankScript: ./your-blank-script.sh` if using separate scripts
6. Run `setup.sh` to rebuild
7. Type `{keyword} _` to test
