---
last_updated: 2026-05-05
---

# Cue-Blanks

A **cue-blank** is a blank (`_`) bound to a keyword via `blankKeywords`. The user types a command whose keyword **leads the line** ending in `_` (e.g., `volume _`, `weather paris _`), the underscore auto-populates with a current value, and Up/Down cycling changes the actual external state. Everything that touches the world is `_`-gated — there is no word-cycling on plain text without `_`.

There are five flavours:

- **Auto-populated cue-blanks** — `_` populates from `blankInvoke('<name>', { action: 'get' })` (or `blankScript get` for the shell-script style). Up/Down call `set` / `up` / `down`. Example: `volume _` → `50%`.
- **List blanks** — BLANK.md has `stepValues: ["I am brave", "I am strong", …]`. No script; the runtime cycles through the list. Multi-word values are span-tracked.
- **Dynamic list blanks** — `blankInvoke get` returns multiple lines, each becoming a cycling alternative (e.g., HN front-page titles).
- **Read-only blanks** — a plain `blankScript:`/`impl:` blank with no `blankStep`/`stepValues`/`blankSatellite` fetches data once and is non-cycleable by default (e.g., stock prices via Finnhub). A multi-line `get` still rotates its results via the alternatives stash.

Cue-blanks are checked **first** in the cycling function (`_cycleAlt`) before any alternative or linked-word cycling.

---

## How It Works

1. **Detection** — at analysis time, every `_` is matched against the registered cue-blanks. If a blank's shape (or synthesized keyword shape) matches the line containing `_` — the command leading its line, `_` at the trailing edge — the `_` is bound to that blank.
2. **Auto-populate** — `blankInvoke({ blankName, action: 'get', args: [keyword, ...context] })` returns the current value; the `_` is replaced with that value, and `metadata.blankName` is set on the resulting WordDef.
3. **On cycle (Up/Down)** — the cycling function checks the bound blank and calls `up` / `down` (or `set` for selector/satellite) via `blankInvoke`. The class implementation (or `blankScript`) updates external state and returns the new display value.
4. **Debounced spawn** — for shell-script blanks, rapid key presses only trigger one subprocess per ~50ms; the timer fires with the final accumulated value.

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
`BLANK.md` references them via `blankScript:`. The runtime
`spawnProcess`-es them on each cycle.

These can't run in the chrome adapter (no subprocess capability), so
their `BLANK.md` includes `not-on-host: [chrome]` and chrome's bundle
filter excludes them at sync time.

### API / LLM-bound blanks → TypeScript classes in the runtime

Several blanks were hoisted from per-host shell scripts into
TypeScript classes living in
`packages/opencues-runtime/src/blanks/`:

| Blank name | Class | Purpose |
|---|---|---|
| `hackernews` | `HackerNewsBlank` | Live HN front-page headlines via RSS |
| `stocks` | `StocksBlank` | Live stock prices via Finnhub |
| `weather` | `WeatherBlank` | Forecast via Open-Meteo |
| `opencues` | `OpenCuesSettingsBlank` | Read/write `CUES.md` frontmatter scalars |
| `countries` | `CountriesBlank` | Country lookup |
| `crypto` | `CryptoBlank` | Live crypto prices |
| `dictionary` | `DictionaryBlank` | Word definitions |

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
   `.sh` path) for OS-bound blanks.

Each host wires its registry in its bootstrap:

- `integrations/chrome/src/opencues-bootstrap.ts` — Chrome registry
- `integrations/opencode/patches/opencuesBootstrap.ts` — OpenCode registry
- `integrations/claude-code/patches/opencuesRuntime.ts` — CC registry

The shared `createBlankInvoke` factory in
`@opencues/runtime/src/boot-common.ts` keeps the registry-then-spawn
fallback consistent across hosts.

### Pattern for adding a new TS-class blank

1. Add the class to `packages/opencues-runtime/src/blanks/<name>.ts`
   implementing the `Blank` interface.
2. Export it from `packages/opencues-runtime/src/blanks/index.ts`.
3. Register it in each host's `blanksRegistry`.
4. Add `blanks/<name>/BLANK.md` under `defaults/blanks/` with
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
| `name` | string | (required) | Blank identifier (e.g., "volume", "stocks") — usually inferred from folder name |
| `tip` | string | name | Tip text shown in the secondary display when focused |
| `blankScript` | string | (required for OS-bound blanks) | Path to the script for `get` / `set` / `up` / `down`. Use `./{name}-blank.sh` for folder-based blanks — relative to the BLANK.md location |
| `speak` | boolean | false | Read the tip aloud via TTS on navigation |
| `blankKeywords` | string[] | (none) | Trigger words that bind a `_` to this blank (e.g., `volume, vol, sound`). Multi-word phrases allowed. Desugar to anchored `blankShapes`. |
| `blankShapes` | JSON list | (synthesized from keywords) | Anchored regex grammar `{pattern, action, valueGroup?}` routing the `_`'s line deterministically. See [blank-integration.md](../architecture/blank-integration.md). |
| `blankStep` | number | (none) | Increment/decrement step size for numeric blanks (also synthesizes set/step shapes) |
| `blankSuffix` | string | (none) | Suffix appended to the displayed value (e.g. `%` shows `50%`). Stripped before arithmetic. Script always receives plain numbers. |
| `integration` | string | (none) | Additive output template with a `{value}` slot (e.g. `volume is now {value}`); shapes the inserted value only |
| `blankDismissible` | boolean | false | Append `_` as a final cycling option so the user can dismiss the value |
| `blankClearKeywords` | boolean | `false` | After a non-shaped fill, strip the blank's own keyword from the text |
| `blankClearOnEdit` | boolean | `false` | Remove spawned words when user edits to something not in alts |
| `stepValues` | string[] | (none) | Static list of values to cycle through |
| `blankSatellite` | boolean | false | Auto-populate as two independent words (selector + satellite) |

Cue-blanks are folder-based: `blanks/{name}/BLANK.md` with YAML frontmatter (config fields) and any colocated scripts. Folder name = blank id. Discovered automatically by `discoverFolderConfigs` and merged into the runtime's blanks registry at config load time.

---

## Script Protocol

When the user cycles a shell-script cue-blank, the integration spawns:

```
bash {blankScript} {action} {args...}
```

- **Get current value:** `bash volume-blank.sh get`
- **Set:** `bash volume-blank.sh set 50`
- **Up:** `bash volume-blank.sh up`
- **Down:** `bash volume-blank.sh down`

**Spawn behavior:**
- **`get` is synchronous** — the runtime awaits stdout to populate the blank
- **`up` / `down` / `set` are detached fire-and-forget** for OS-state changes; debounced to one spawn per ~50ms
- **Path resolution** — `~` is expanded to `$HOME`. Folder-based blanks use `./{name}-blank.sh` relative to the BLANK.md
- **WSL** — scripts run in the Linux environment. To talk to Windows applications, use `powershell.exe` or compiled `.exe` helpers inside the script

Example script:

```bash
case "$1" in
  get)  echo "$(query_system_volume)" ; exit 0 ;;
  set)  set_system_volume "$2" ; exit 0 ;;
  up)   adjust_volume +6 ; exit 0 ;;
  down) adjust_volume -6 ; exit 0 ;;
esac
```

TTS (`speak: true`) fires once on navigation, not on each cycle update.

---

## Portability

### Standard (opencues-core)

- `BlankConfig` type defines all blank fields
- `parseSingleCueMd` parses `BLANK.md` frontmatter into a typed `BlankConfig`
- `discoverFolderConfigs` finds `blanks/{name}/BLANK.md` files and returns parsed configs

### Integration responsibilities

- Implement `blankInvoke` — registry lookup first, then `spawnProcess` fallback
- Spawn external scripts with the correct arguments (`get`, `set`, `up`, `down`)
- Use synchronous execution for `get` (auto-populate awaits stdout); detached fire-and-forget for `up`/`down`
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
| **User edit** (typing, deleting) | `metadata.blankName` is **cleared**. The position becomes a normal word. Grammar/LLM can now provide alternatives. | The user intentionally changed the word — they're done with the cue-blank. |
| **LLM/grammar result** (resolver callback) | `metadata.blankName` is **preserved**. The grammar result is **skipped**. | The LLM is offering unsolicited alternatives for a position the user didn't ask to change. The blank value must not be overwritten. |

**How to distinguish them:**

The two changes arrive through different code paths:

1. **User edits** flow through the text-change detection layer (the render cycle). When the displayed text changes, the integration compares old vs new text word-by-word. If a word at a blank position changed to something not in its alternatives, the metadata is cleared — the user "unlocked" that position.

2. **LLM results** flow through the resolver callback. When merging new results into the existing WordDef array, the integration checks if the existing WordDef has `metadata.blankName`. If yes AND the new result is NOT a blank result, the merge is skipped.

**The invariant:** Only the user can clear `metadata.blankName`. The LLM cannot. This ensures blank positions are stable until the user explicitly edits them away.

**What goes wrong if you get this wrong:**

- **If LLM can overwrite blank-bound words:** The auto-populated volume value (e.g., "64") gets replaced by grammar alternatives ("sixty-four", "numerous"). The position loses its blank behaviour. Cycling no longer changes the actual volume.
- **If user edits can't clear blank-bound words:** The position is permanently stuck. Even after deleting "64" and typing "hello", the position stays dimmed and cycling tries to run the volume script. The user has no way to reclaim the position.

**Edge case — word removal:** When the user deletes text and the word count decreases, WordDefs at indices beyond the new text length must also have their metadata cleared. The position no longer exists, so the blank-name must not persist there.

---

## Keyword Matching (line-scoped shapes)

`blankKeywords` desugar to anchored `blankShapes`. A blank claims a `_` when
its keyword (or shape) **leads the line** containing `_`, with `_` at the
trailing edge. Routing is deterministic and line-scoped — prose that merely
mentions a keyword mid-line does NOT fire. The first blank with a matching
shape wins. Examples with `blankKeywords: volume, sound, audio`:

- `volume _` — matches (`volume` leads, `_` at end)
- `volume 30 _` — matches; `30` is captured as the set value
- `audio up _` — matches; `up` is captured as a step (when `blankStep` is set)
- `set audio _` — no match (line leads with `set`, not the keyword)
- `the volume is loud _` — no match (prose; `volume` doesn't lead the line)
- `the _ is loud` — no match (no keyword, and `_` isn't at the trailing edge)

With prior content on earlier lines, the command on the last line still
fires: `some notes here.\nvolume 30 _` → matches.
