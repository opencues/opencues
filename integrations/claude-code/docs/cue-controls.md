---
last_updated: 2026-04-08
---

# Cue-Controls — Claude Code

Implements feature [11](../../../docs/features/cue-controls.md). See that doc for the concept.

**Patch files:** `patches/wordHighlight.ts` (navigation + dimming), `patches/dynamicHighlight.ts` (cycling + script spawn)

Cue-controls are words with built-in cycling behavior that bypasses the normal alternatives pipeline. In the status line, they show their configured tip text only (not the word or alt count).

## Overview

There are six kinds of cue-control:

- **Custom cue-controls** — navigate to a word (like "volume") and press Ctrl+Alt+Up or Down to spawn an external script instead of modifying the word. This enables controlling system functions directly from the Claude Code input.
- **Control-bound blanks** — blank positions bound to a control via `blankKeywords`. The blank auto-populates with the live value from `blankScript get` and syncs on each cycle.
- **Step controls** — words matching config-driven patterns (via `stepPattern` or `stepSuffixes`) are incremented/decremented by a configurable step size. Supports suffixes like `f`, `px`, `em`, `%`. See `cycling.md` for config fields.
- **List controls** — control-bound blanks with `stepValues` that cycle through an ordered list of values. Type a keyword + `_`, the blank auto-populates with the first value, Up/Down cycles through the list. Multi-word values are span-tracked. No script needed.
- **Dynamic list controls** — control-bound blanks where `blankScript get` returns multiple lines. Each line becomes a cycling alternative, same as `stepValues` but populated from live data (e.g., `HN posts _` fetches RSS feed titles from Hacker News).
- **Read-only controls** — control-bound blanks with `blankReadOnly: true` that fetch data from external APIs (e.g., stock prices). The blank auto-populates with the fetched value; cycling is disabled. The matched keyword is passed to the script for multi-lookup controls (e.g., `stock-blank.sh get reddit`).

The unified check `globalThis._isCueControl(word)` identifies custom controls (via `_cueControlOverrides`) and step controls (via `_stepPatterns`). It's used by the tips lookup (`lookupMultiple` with `skipFn`) and the status line export to exclude cue-controls from tips/alts display.

## How It Works

```
User types: "set volume to max"
           ↓
Navigate to "volume" (Ctrl+Alt+Left)
           ↓
Press Ctrl+Alt+Up
           ↓
cue-control check (FIRST priority)
  → Word "volume" found in cueControlOverrides
  → Spawn: ~/.claude/actions/volume.sh up 5
  → Return (skip step control/cycling logic)
           ↓
Volume increases
```

## Priority Order

Cue-controls are checked **FIRST** in `_cycleAlt()`, before any other logic:

1. **Cue-control (custom)** → spawn script, return
2. **Control-bound blanks** → sync script call, replace blank value, return
3. **Step control** → config-driven increment/decrement, return
4. **Alternatives** → cycle through alternatives
5. **Linked words** → co-dependent words cycle together

All Up/Down handlers (Ink key handlers and raw sequence handlers) delegate to `_cycleAlt` in `dynamicHighlight.ts`.

## Configuration

### In `~/.tweakcc/config.json`

```json
{
  "settings": {
    "misc": {
      "cueControlOverrides": {
        "volume": {
          "control": "volume",
          "upArgs": ["up", "5"],
          "downArgs": ["down", "5"]
        },
        "brightness": {
          "control": "brightness",
          "upArgs": ["up", "10"],
          "downArgs": ["down", "10"]
        }
      }
    }
  }
}
```

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `control` | string | Control identifier, used for default script path |
| `tip` | string? | Label shown in status line when highlighted |
| `script` | string? | Custom script path. Use `./script.sh` for folder-colocated scripts |
| `upArgs` | string[] | Arguments passed when Up is pressed |
| `downArgs` | string[] | Arguments passed when Down is pressed |
| `speak` | boolean? | Read the tip aloud via TTS when navigated to (default: false) |
| `blankSuffix` | string? | Suffix appended to the displayed blank value (e.g. `%` shows `50%`). Stripped before arithmetic. |

### Script Resolution

Script path is resolved in this order:
1. `script` field value (supports `./` relative to folder for folder-based controls)
2. `~/.claude/actions/{control}.sh` (default)

### Folder-Based Controls

Controls can be self-contained folders instead of entries in `controls.md`:

```
controls/volume/
├── cue.md        # Control config in YAML frontmatter
└── volume.sh     # Colocated script (script: ./volume.sh)
```

See `docs/guides/adding-a-cue-control.md` for the full folder format.

## Script Implementation

### Script Interface

Scripts receive arguments as defined in config:
```bash
# For upArgs: ["up", "5"]
~/.claude/actions/volume.sh up 5

# For downArgs: ["down", "5"]
~/.claude/actions/volume.sh down 5
```

Scripts should also implement a `get` command — the integration calls it on navigation and ~200ms after each cycle to update the status line with the live value:

```bash
~/.claude/actions/volume.sh get
# → "volume: 64%"
```

If `get` returns empty or fails, the static `tip:` field is used as fallback.

### Sync timing rules (WSL)

Word-control scripts are spawned detached (fire-and-forget) but `get` is called synchronously 200ms later. To avoid stale reads:

1. **Do not background the exe with `&`** — the change must be applied before `get` fires.
2. **Do not call the live-read function before up/down** — it costs ~200ms (.NET startup), pushing the total past the 200ms window.
3. **The exe handles delta internally** — it reads current state, applies the delta, and exits only after the change is committed.

See the sync pitfalls comment block in `controls/volume/volume.sh` for full details.

## Visual Behavior

cue-controls follow the same visual pattern as step-controlled values:

| State | Appearance |
|-------|------------|
| Not highlighted | Dimmed (dark gray) |
| Highlighted | Bold white |

Cue-controls are always navigable.

## Prerequisites

cue-controls require `enableWordHighlight: true` in config. The `cueControlOverrides` config is serialized into cli.js by the wordHighlight patch — if wordHighlight is disabled, the globalThis variable is never set and cue-controls silently do nothing.

## Adding New cue-controls

Use the folder-based approach — create `controls/{name}/` with a `cue.md` and script. See `docs/guides/adding-a-cue-control.md` for the full walkthrough. The existing `controls/volume/` and `controls/brightness/` folders are canonical examples.

Config changes hot-reload within ~2s. `setup.sh` is only needed if you add a compiled `.cs` executable.

## Troubleshooting

### Script Not Running

1. Check script exists and is executable:
   ```bash
   ls -la ~/.claude/actions/volume.sh
   ```

2. Test script directly:
   ```bash
   ~/.claude/actions/volume.sh up 5
   ```

3. Check for Windows line endings (WSL):
   ```bash
   sed -i 's/\r$//' ~/.claude/actions/volume.sh
   ```

### Volume/Brightness Not Changing (WSL)

1. **Test the exe directly** from WSL:
   ```bash
   ~/.claude/actions/VolCtl.exe up 10
   ~/.claude/actions/BrightCtl.exe up 10
   ```
2. **Check VolCtl.exe get returns a value** — if it returns 0 or empty on first call, that's the COM init delay (retry logic in volume.sh handles this automatically)
3. **Verify setup.sh compiled the executables** — re-run `setup.sh` if the `.exe` files are missing

### cue-control Not Navigable

1. Verify word is in config (case-insensitive match)
2. Re-apply patches after config change
3. Check `globalThis._cueControlOverrides` in browser console

## Control-Bound Blanks

Control-bound blanks bridge blanks (`_`) with cue-controls. Typing `change volume _` auto-populates the blank with the current volume and cycling changes the actual system state.

See `docs/features/control-blanks.md` for full configuration reference.

### Implementation notes (Claude Code specific)

**Auto-populate mechanism**: The resolver callback sets `globalThis._pendingAutoPopulate`. This is consumed in the render-cycle IIFE in `wordHighlight.ts` (not in the resolver callback) because `onChange` must be called from a fresh React render context — stale closure references from `setTimeout` or async callbacks don't update the input.

**Live state reads**: The `readControlState` callback calls `blankScript get [keyword] [context...]` synchronously via `execFileSync`. Must use `${requireFuncName}("child_process")`, never bare `require()` — see `architecture.md` § Development Notes.

**Cycling**: The cycling handler calculates the target value (current + blankStep, clamped to blankRange), then calls `blankScript set <value>` via `execSync`. Uses `metadata.blankScript` — separate from the word-control `script` which handles `up`/`down`. Word-based controls use debounced `spawn` with direction args (fire-and-forget). Blank-controls are value-based and synchronous.

**Merge protection**: Grammar/LLM results cannot overwrite a control-blank WordDef (checked via `metadata.controlName`), but fresh control-blank results CAN replace stale ones.

**Cache invalidation**: When `_` reappears in the text, all control-blank WordDefs are cleared and re-analysis is forced, ensuring a fresh value read.

## Compiled Executables

`setup.sh` auto-compiles `.cs` files from both `patches/actions/` and `controls/*/` to `~/.claude/actions/` via the Windows .NET csc.exe compiler.

| Executable | Source | Purpose |
|------------|--------|---------|
| `VolCtl.exe` | `controls/volume/VolCtl.cs` | Volume via Core Audio API (`get`, `set`, `up`, `down`) |
| `BrightCtl.exe` | `patches/actions/BrightCtl.cs` | Brightness via powrprof.dll (`get`, `set`, `up`, `down`) |
| `SpeakCtl.exe` | `patches/actions/SpeakCtl.cs` | TTS via System.Speech |

**VolCtl.exe** uses the Windows Core Audio API (via COM vtable calls):
- `get` — queries actual system volume as 0-100 integer
- `set <value>` — sets exact volume using `VolumeStepUp`/`VolumeStepDown`
- `up <amount>` / `down <amount>` — sends media key presses via `SendInput` (shows Windows OSD)

COM initialization uses `COINIT_APARTMENTTHREADED` with MTA fallback — required for reliable operation when spawned from Node.js child processes.

**BrightCtl.exe** uses `powrprof.dll` (native Windows power API, no PowerShell startup cost):
- `get` — reads current brightness via `PowerReadACValueIndex` (0-100 integer)
- `set <value>` — sets exact brightness via `PowerWriteACValueIndex` + `PowerSetActiveScheme`
- `up <amount>` / `down <amount>` — reads current, applies delta, writes back in one call (~194ms total)

SpeakCtl.exe requires `/reference:System.Speech.dll` — setup.sh handles this with a special case for the `SpeakCtl` base name.

## CC-Specific: Consume-All Controls

Controls with `blankConsumeAll: true` replace the entire input text with a multi-word result. The existing keyword-clearing logic handles the clearing — `blankConsumeAll` just expands `blankKeywordIndices` to include every non-blank position.

**Cycling uses dedicated storage (`_consumeAllAlts`)** instead of `_dynDefs` because:
- After clearing shifts the blank index, multiple WordDefs collide at index 0 (grammar + control-blank)
- The tips-only fast path replaces `_dynDefs` entirely, losing the control-blank alts
- Per-word clearing deletes `_dynSpans` entries when words change between cycles

The alternatives flow through `_pendingAutoPopulate.consumeAllAlts` (set in the resolver callback) to `globalThis._consumeAllAlts` (set during auto-populate). The cycling path in `_cycleAlt` runs before dynamic alt cycling (priority 4 in the cycling order).

State that must be updated after each cycle: `_hlText`, `_hlState.text`, `_hlState.wordIndex`, `_dynLastAnalyzed`, `_dynPrevWords`, `_dynSpans`, and `_consumeAllAlts.spanLength`. See `docs/guides/creating-a-cue-type.md` for the full rationale.

**Config passthrough via env vars**: `readControlState` reads first-party fields from `ControlConfig` and passes them to the blank script as environment variables before `execFileSync`:

| `cue.md` field | Env var | Description |
|---|---|---|
| `model` | `CUES_MODEL` | LLM model identifier |
| `apiUrl` | `CUES_API_URL` | API endpoint URL |
| `apiKeyEnv` | `CUES_API_KEY_ENV` | Name of env var holding the API key |
| `altCount` | `CUES_ALT_COUNT` | Number of alternatives to return |
| `includeOriginal` | `CUES_INCLUDE_ORIGINAL` | Whether to append original as last alt |
| `prompts.Extract` | `CUES_PROMPT_EXTRACT` | Body section named `## Extract` |
| `prompts.Transform` | `CUES_PROMPT_TRANSFORM` | Body section named `## Transform` |

Body sections (`## SectionName`) in the `cue.md` body are parsed by cues-core into `control.prompts` and forwarded as `CUES_PROMPT_<SECTIONNAME>`. This keeps scripts free of config parsing — the single-parser principle.

**Claude CLI provider**: If `model` starts with `claude-`, the script can use `claude -p` instead of the HTTP API (no API key required — uses existing Claude Code auth). The prompt improver script auto-detects this from `CUES_MODEL`.

**Example:** The prompt improver (`controls/prompt/`) uses two-step LLM calls (model and prompts configured in `cue.md`) to extract the user's prompt from surrounding text, then improve it, returning 3 alternatives + the original.

## Related

- `docs/features/control-blanks.md` — full control-bound blanks feature reference
- `docs/features/consume-all-blanks.md` — consume-all blanks feature concept
- `docs/guides/creating-a-cue-type.md` — implementation guide for new cue types with dedicated cycling
- `config.md` — all configuration options
- `architecture.md` — architecture overview + development notes
- `alternatives.md` — TTS details and external highlight preservation
