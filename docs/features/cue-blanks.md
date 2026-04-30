---
last_updated: 2026-04-22
---

# Cue-Blanks

Cue-blanks are words with built-in cycling behavior that bypasses the normal alternatives pipeline. They never show tips or alts in the secondary display (unless they have a `blankTip`). There are six kinds:

- **Custom cue-blanks** — trigger external scripts instead of modifying text (e.g., "volume" runs a volume script). Configured per-word with custom arguments for up/down directions.
- **Auto-populated blanks** — blank positions (`_`) bound to a cue-blank via `blankKeywords`. The blank auto-populates with the live value from `blankScript get` and updates on each cycle.
- **Step blanks** — words matching config-driven patterns (via `stepPattern` or `stepSuffixes` in `blanks/` folder `cue.md` files) are incremented/decremented by a configurable step size, bounded by `stepMin`/`stepMax`. Supports suffixes like `f`, `px`, `em`.
- **List blanks** — blanks with `stepValues` that cycle through an ordered list of values (e.g., affirmations). No script needed — uses normal alt cycling. Multi-word values are span-tracked.
- **Dynamic list blanks** — blanks where `blankScript get` returns multiple lines, each becoming a cycling alternative (e.g., RSS feed titles from Hacker News). Same cycling behavior as `stepValues` but populated from live data.
- **Read-only blanks** — blanks with `blankReadOnly: true` that fetch data from external APIs (e.g., stock prices via Finnhub). Auto-populate only, cycling disabled. The matched keyword is passed to the script for multi-lookup controls.
- **Consume-all blanks** — blanks with `blankConsumeAll: true` that clear the entire input and replace it with multi-word cycling alternatives (e.g., prompt improver). Uses dedicated cycling storage independent of `_dynDefs`. See [Consume-All Blanks](consume-all-blanks.md).

Cue-blanks are checked **first** in the cycling function (`_cycleAlt`) before any alternative or linked-word cycling.

---

## How It Works

1. **Detection** — `_isCueControl(word)` returns true if the word exists in `globalThis._cueBlankOverrides` (case-insensitive lookup) or matches any pattern in `globalThis._stepPatterns`
2. **On cycle (Up/Down)** — the cycling function checks `_actOvr[word.toLowerCase()]`. If a match exists, it spawns the configured script with direction-specific arguments. If no match but a step control pattern matches, it increments or decrements using the blank's `step`/`stepMin`/`stepMax` config
3. **Debounced spawn** — rapid key presses (e.g., holding Up) only spawn the script once per 50ms via `globalThis._cueBlankTimers`. The timer fires with the final accumulated value
5. **Clamping** — Word-based cue-blank cycling hardcodes clamping to 0-100. The `blankRange` field is only used by `BlankSource` for validation during auto-populate, not by the word-blank cycling handler

---

## Blanks Architecture — TS classes vs shell scripts

Cue-blanks have two implementation styles. Both are dispatched through
the same `blankInvoke` shim, so from the runtime's view they look
identical; the difference is where the work happens.

### OS-level blanks → shell scripts

`volume`, `brightness` and any other blank whose work is genuinely
operating-system-bound (changing system audio, toggling display
brightness, calling `osascript` / `pactl` / `pwsh` …) ship as
`.sh` / `.ps1` scripts under `blanks/<name>/`. The blank's
`cue.md` references them via `script:` and `blankScript:`. The
runtime `spawnProcess`-es them on each cycle.

These can't run in the chrome adapter (no subprocess capability), so
their `cue.md` includes `not-on-host: [chrome]` and chrome's bundle
filter excludes them at sync time.

### API / LLM-bound blanks → TypeScript classes in the runtime

Six blanks were hoisted from per-host shell scripts into
TypeScript classes living in
`packages/opencues-runtime/src/blanks/`:

| Control | Class | Purpose |
|---|---|---|
| `hackernews` | `HackerNewsControl` | Live HN front-page headlines via RSS |
| `stocks` | `StocksControl` | Live stock prices via Finnhub |
| `weather` | `WeatherControl` | Forecast via Open-Meteo |
| `answer` | `AnswerControl` | LLM-formatted answer in place |
| `prompt` | `PromptImproverControl` | LLM-rewritten prompt in place |
| `opencues` | `OpenCuesSettingsControl` | Read/write `opencues.md` scalars |

Why hoist them: chrome can't spawn subprocesses, so the shell-script
model excluded chrome from these blanks entirely. A TS class lives
in the runtime that ships with every host — same code, every host.

### `blankInvoke` — the shared dispatcher

The runtime exposes a `blankInvoke` capability the host adapter
implements. On each blank trigger, the runtime calls
`blankInvoke({ blankName, action, args, ... })`:

1. The host's TS-blanks registry is checked first. If the
   `blankName` is registered (`HackerNewsBlank`, `StocksBlank`,
   `WeatherBlank`, …), the class handles it directly — no
   subprocess.
2. If unregistered, the host falls through to `spawnProcess` (the
   legacy `.sh` path) for OS-bound blanks.

Each host wires its registry in its bootstrap:

- `integrations/chrome/src/opencues-bootstrap.ts` — Chrome registry
- `integrations/opencode/patches/opencuesBootstrap.ts` — OpenCode registry
- `integrations/claude-code/patches/opencuesRuntime.ts` — CC registry
- `integrations/codex/...` — Codex registry (pre-alpha)

The shared `createBlankInvoke` factory in
`@opencues/runtime/src/boot-common.ts` keeps the registry-then-spawn
fallback consistent across hosts.

### Pattern for adding a new TS-class blank

1. Add the class to `packages/opencues-runtime/src/blanks/<name>.ts`
   implementing the `Blank` interface.
2. Export it from `packages/opencues-runtime/src/blanks/index.ts`.
3. Register it in each host's `blankInvoke` map (or in
   `controlsRegistry` for the hosts that use the shared factory).
4. Add `blanks/<name>/cue.md` under `defaults/blanks/` with
   `impl: @opencues/runtime <ClassName>` so the validator + the
   docs-tools know it's a hoisted blank.

`blankInvoke` and the `Blank` interface are documented in the
[Adding a Cue-Blank](../guides/adding-a-cue-blank.md) guide and
in `packages/opencues-runtime/src/blanks/index.ts`.

---

## Configuration

`BlankConfig` (defined in `cues-md.ts`) has these fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `control` | string | (required) | Control identifier (e.g., "volume", "brightness") |
| `tip` | string | control name | Tip text shown in the secondary display when focused |
| `script` | string | (required for OS-bound blanks) | Path to the script to spawn. Use `./{name}.sh` for folder-based blanks — relative to the cue.md location, which seeds to `~/.opencues/blanks/{name}/{name}.sh` |
| `upArgs` | string[] | `["up"]` | Arguments passed when cycling up |
| `downArgs` | string[] | `["down"]` | Arguments passed when cycling down |
| `speak` | boolean | false | Read the tip aloud via TTS on navigation |
| `blankKeywords` | string[] | (none) | Context words that bind a blank (`_`) to this control |
| `blankStep` | number | (from args) | Increment/decrement step size for blanks |
| `blankAutoPopulate` | boolean | false | Auto-fill blank with current control value on analysis |
| `blankRange` | [number, number] | `[0, 100]` | Min/max for validation during auto-populate (used by `BlankSource`) |
| `blankTip` | string | (none) | Tip shown when the auto-populated blank value is highlighted |
| `blankSuffix` | string | (none) | Suffix appended to the displayed value (e.g. `%` shows `50%`). Stripped before arithmetic. Script always receives plain numbers. |
| `blankKeywordExpansions` | object | (none) | Map from keyword (lowercase) to display name. When auto-populate fires, the matched keyword word is replaced with its expansion (e.g. `rddt` → `Reddit`). |
| `blankClearKeywords` | boolean | `false` | Remove keyword context words from text on auto-populate. Only the resolved value remains. |
| `blankClearOnEdit` | boolean | `false` | Remove spawned words when user edits to something not in alts (selector/satellite pair cleanup). |

Cue-blanks can be defined in two ways:
- **`blanks.md`** — a JSON code block mapping blank names to `BlankConfig` objects
- **Folder-based** — `blanks/{name}/cue.md` with YAML frontmatter (`type: control`, plus config fields). Scripts are colocated in the same folder

Both are parsed into the same `BlankConfig` structure and merged into `_cueBlankOverrides` at config load time.

---

## Script Protocol

When the user cycles a custom cue-blank, the integration spawns:

```
bash {script} {args...}
```

- **Up:** `bash volume.sh up 10` (where `["up", "10"]` comes from `upArgs`)
- **Down:** `bash volume.sh down 10` (where `["down", "10"]` comes from `downArgs`)

**Spawn behavior:**
- **Detached, fire-and-forget** — `child_process.spawn` with `{detached: true, stdio: "ignore"}` and `.unref()`. The script runs independently; its exit code is not checked
- **Debounced** — if the user presses Up three times in 50ms, only one spawn fires with the final arguments
- **Path resolution** — `~` is expanded to `$HOME`. Folder-based blanks use `./{name}.sh` relative to the cue.md (resolves to `~/.opencues/blanks/{name}/{name}.sh`). OS helpers (`*.exe`, `*.ps1`) live colocated in the same folder; setup.sh seeds them and compiles `*.cs` → `*.exe` in-place
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

### Standard (opencues-core)

- `BlankConfig` type defines all blank fields: `control`, `tip`, `script`, `upArgs`, `downArgs`, `speak`, and blank-related fields
- `parseSingleCueMd` parses `cue.md` frontmatter into a typed `BlankConfig`
- `discoverFolderConfigs` finds `blanks/{name}/cue.md` files and returns parsed configs
- `blanks.md` JSON block parsing produces the same `BlankConfig` structure
- Step blank patterns are auto-generated from `stepSuffixes` or explicit `stepPattern` — any integration can reuse the pattern-matching approach

### Integration responsibilities

- Spawn external scripts with the correct arguments (up/down direction, current value)
- Use detached spawning for word-blanks (fire-and-forget) vs. synchronous execution for auto-populated blanks
- Debounce rapid cycling to avoid spawning scripts on every keystroke
- Implement TTS invocation when `speak: true` is set on a blank
- Display blank tips in the secondary display (status line, tooltip, etc.)
- Handle platform differences for script execution (e.g., WSL path translation)

---

## Ownership Model: User Edit vs LLM Overwrite

This is the most important behaviour to get right when porting blanks to a new integration.

A blank position has **two types of incoming changes**, and they must be handled differently:

| Change source | What happens | Why |
|---------------|-------------|-----|
| **User edit** (typing, deleting) | `metadata.blankName` is **cleared**. The position becomes a normal word. Grammar/LLM can now provide alternatives. | The user intentionally changed the word — they're done with the control-blank. |
| **LLM/grammar result** (resolver callback) | `metadata.blankName` is **preserved**. The grammar result is **skipped**. | The LLM is offering unsolicited alternatives for a position the user didn't ask to change. The control value must not be overwritten. |

**How to distinguish them:**

The two changes arrive through different code paths:

1. **User edits** flow through the text-change detection layer (the render cycle). When the displayed text changes, the integration compares old vs new text word-by-word. If a word at a blank position changed to something not in its alternatives, the metadata is cleared — the user "unlocked" that position.

2. **LLM results** flow through the resolver callback. When merging new results into the existing WordDef array, the integration checks if the existing WordDef has `metadata.blankName`. If yes AND the new result is NOT a blank result, the merge is skipped.

**The invariant:** Only the user can clear `metadata.blankName`. The LLM cannot. This ensures blank positions are stable until the user explicitly edits them away.

**What goes wrong if you get this wrong:**

- **If LLM can overwrite control-blanks:** The auto-populated volume value (e.g., "64") gets replaced by grammar alternatives ("sixty-four", "numerous"). The position loses its blank behaviour. Cycling no longer changes the actual volume.
- **If user edits can't clear control-blanks:** The position is permanently stuck as a control-blank. Even after deleting "64" and typing "hello", the position stays dimmed and cycling tries to run the volume script. The user has no way to reclaim the position.

**Edge case — word removal:** When the user deletes text and the word count decreases, WordDefs at indices beyond the new text length must also have their metadata cleared. The position no longer exists, so the control-blank must not persist there.

---

## Keyword Matching

The system scans words in the input (case-insensitive) against each blank's `blankKeywords`, checking **all occurrences** of each keyword, subject to `blankProximity`. The keyword must be within `blankProximity` words of the `_` — if a keyword appears multiple times, any occurrence within range is sufficient. The first control with a matching keyword wins.

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
