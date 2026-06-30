---
last_updated: 2026-06-29
---

# Cue-Blanks — Claude Code

Implements feature [11](../../../docs/features/cue-blanks.md). See that doc for the concept.

**Implementation:** Navigation + dimming + cycling + `blankInvoke` dispatch all live in `@opencues/runtime`. The CC bootstrap (`patches/opencuesRuntime.ts`) registers TS-class blanks into the host's `blanksRegistry`.

A cue-blank is a blank (`_`) bound to a keyword via `blankKeywords` (which desugars into anchored `blankShapes`). The user types a keyword that leads the line containing `_` — args may sit between the keyword and `_` (e.g. `weather paris _`) — the runtime auto-populates with a current value via `blankInvoke`, and Up/Down cycling changes the actual external state. Everything that touches the world is `_`-gated — there is no word-cycling on plain text without `_`.

## Overview

Four flavours of cue-blank:

- **Auto-populated cue-blanks** — `_` populates from `blankInvoke('<name>', { action: 'get' })`. Auto-populate is always-on: any shape match fills the `_`. Up/Down call `up` / `down` (or `set` for selector/satellite). Example: `volume _` → `50%`.
- **List blanks** — cue.md has `stepValues: [...]`. No script; the runtime cycles the list.
- **Dynamic list blanks** — `blankInvoke get` returns multi-line output; each line becomes a cycling alternative (e.g., HN headlines).
- **Read-only blanks** — read-only is inferred: a blank that omits `blankStep` / `stepValues` / `blankSatellite` is read-only by construction, so it fetches data once and never cycles (e.g., stocks).

## How It Works

```
User types: "set volume _"
           ↓
Analysis matches `volume` (a blankKeywords entry) leading the line containing `_`
           ↓
Runtime calls blankInvoke({ blankName: 'volume', action: 'get', args: ['volume'] })
           ↓
Host adapter dispatches:
  → registry hit → TS class get()  (no subprocess)
  → registry miss → spawn `bash volume-blank.sh get` (subprocess)
           ↓
Returned value (e.g., '50') replaces `_` (display: '50%' from blankSuffix)
metadata.blankName = 'volume' is set on the WordDef (LLM-overwrite protection)
           ↓
User presses Ctrl+Alt+Up: blankInvoke({ action: 'up' }) runs detached,
then blankInvoke({ action: 'get' }) runs ~200ms later for the new display value
```

## Cycling Priority

Cue-blanks are checked **first** in `_cycleAlt()`:

1. **Cue-blank values** (`metadata.blankName`) → `blankInvoke up/down`, then `get`, return
2. **Dynamic-list (span) alts** → cycle `_consumeAllAlts` (dedicated storage for multi-line `get()` output, separate from `_dynDefs`)
3. **Dynamic alts** → cycle `_dynDefs.words[i].alts`
4. **Linked words** → co-dependent words cycle together

All Up/Down handlers (Ink key handlers and raw sequence handlers) delegate to `_cycleAlt` in `@opencues/runtime`.

## Configuration

Folder-based is canonical. The host registers TS-class blanks at install time; `.md` files hot-reload.

```
defaults/blanks/volume/
├── cue.md             # type: blank, blankKeywords, blankScript: ./volume-blank.sh
├── volume-blank.sh    # Colocated script (get/set/up/down)
└── VolCtl.cs          # WSL helper compiled to VolCtl.exe by setup.sh
```

```yaml
---
name: volume
type: blank
tip: system volume
speak: true
blankKeywords: volume, vol, sound, audio
blankStep: 6
blankSuffix: '%'
blankScript: ./volume-blank.sh
---
```

For all `BlankConfig` fields see the [Adding a Cue-Blank](../../../docs/guides/adding-a-cue-blank.md) guide.

### Script Resolution

`blankScript: ./<name>-blank.sh` is resolved relative to the cue.md location, which seeds to `~/.cues/blanks/<name>/<name>-blank.sh`. OS helper binaries (`*.exe`, `*.ps1`) live colocated in the same folder and are looked up via `${SCRIPT_DIR}/<helper>` inside the script — no path walking, no install-layout coupling.

## Script Implementation

### Script Interface

```bash
~/.cues/blanks/volume/volume-blank.sh get          # → "50"
~/.cues/blanks/volume/volume-blank.sh set 75       # apply
~/.cues/blanks/volume/volume-blank.sh up           # increment
~/.cues/blanks/volume/volume-blank.sh down         # decrement
```

If `get` returns empty or fails, the static `tip:` from `cue.md` is used as fallback.

### Sync timing rules (WSL)

`up`/`down`/`set` are spawned detached (fire-and-forget), but `get` is called synchronously ~200ms later. To avoid stale reads:

1. **Do not background the exe with `&`** — the change must be applied before `get` fires.
2. **Do not call the live-read function before up/down** — it costs ~200ms (.NET startup), pushing the total past the 200ms window.
3. **The exe handles delta internally** — it reads current state, applies the delta, and exits only after the change is committed.

See the sync pitfalls comment block in `defaults/blanks/volume/volume-blank.sh` for full details.

## Visual Behavior

| State | Appearance |
|-------|------------|
| Not highlighted | Dimmed (dark gray) |
| Highlighted | Bold white |

Cue-blank values (words with `metadata.blankName`) are navigable even with `alts.length` < 2 — the 1-alt exception.

## Adding New Cue-Blanks

Use the folder-based approach — create `defaults/blanks/<name>/` with a `cue.md` and `<name>-blank.sh`. See [Adding a Cue-Blank](../../../docs/guides/adding-a-cue-blank.md) for the full walkthrough. Existing `blanks/volume/` and `blanks/brightness/` folders are canonical OS-level examples; `blanks/stocks/`, `blanks/weather/`, `blanks/hackernews/` are TS-class examples.

Config changes hot-reload within ~2s. `setup.sh` is only needed if you add a compiled `.cs` executable or a new TS-class blank.

## Troubleshooting

### Script Not Running

1. Check script exists and is executable:
   ```bash
   ls -la ~/.cues/blanks/volume/volume-blank.sh
   ```

2. Test script directly:
   ```bash
   ~/.cues/blanks/volume/volume-blank.sh up
   ```

3. Check for Windows line endings (WSL):
   ```bash
   sed -i 's/\r$//' ~/.cues/blanks/volume/volume-blank.sh
   ```

### Volume/Brightness Not Changing (WSL)

1. **Test the exe directly** from WSL:
   ```bash
   ~/.cues/blanks/volume/VolCtl.exe up 10
   ~/.cues/blanks/brightness/BrightCtl.exe up 10
   ```
2. **Check VolCtl.exe get returns a value** — if it returns 0 or empty on first call, that's the COM init delay (retry logic in volume-blank.sh handles this automatically)
3. **Verify setup.sh compiled the executables** — re-run `setup.sh` if the `.exe` files are missing

### Cue-Blank Not Triggering

1. Verify a registered keyword leads the line containing `_` (args may sit between the keyword and `_`, e.g. `weather paris _`)
2. Check the runtime's `blanksByWord` map at startup — every keyword from every blank's `blankKeywords` should be there
3. Hot-reload: edit any cue.md and save → analyzer re-runs within ~2s

## Implementation Notes (Claude Code Specific)

**Auto-populate mechanism**: The resolver callback sets `globalThis._pendingAutoPopulate`. This is consumed in the render-cycle IIFE in `@opencues/runtime` (not in the resolver callback) because `onChange` must be called from a fresh React render context — stale closure references from `setTimeout` or async callbacks don't update the input.

**Live state reads**: The runtime's `blankInvoke` dispatcher calls registered TS-class `get()` directly. For shell-script blanks, the spawn-fallback uses `execFileSync` via the `createRequire`-derived var, never bare `require()` (cli.js is ESM-converted; bare `require` isn't defined at module scope).

**Cycling**: The cycling handler calls `blankInvoke({ action: 'up' | 'down' | 'set' })` synchronously, then `blankInvoke({ action: 'get' })` for the new display value.

**Merge protection**: Grammar/LLM results cannot overwrite a blank-bound WordDef (checked via `metadata.blankName`), but fresh blank results CAN replace stale ones.

**Cache invalidation**: When `_` reappears in the text, all blank WordDefs are cleared and re-analysis is forced, ensuring a fresh value read.

## Compiled Executables (WSL)

`setup.sh` auto-compiles `.cs` files into two destinations on WSL (Windows .NET csc.exe required):

| Executable | Source | Compiled to | Purpose |
|------------|--------|-------------|---------|
| `VolCtl.exe` | `defaults/blanks/volume/VolCtl.cs` | `~/.cues/blanks/volume/VolCtl.exe` | Volume via Core Audio API (colocated with `volume-blank.sh`) |
| `BrightCtl.exe` | `defaults/blanks/brightness/BrightCtl.cs` | `~/.cues/blanks/brightness/BrightCtl.exe` | Brightness via powrprof.dll (colocated with `brightness-blank.sh`) |
| `SpeakCtl.exe` | `integrations/claude-code/patches/actions/SpeakCtl.cs` | `<CC_FORK>/.cues/scripts/SpeakCtl.exe` | TTS via System.Speech (host runtime utility, not a user-blank) |

Blank-colocated executables (`VolCtl`, `BrightCtl`) sit in the same folder as the script that calls them — `volume-blank.sh` does `"${SCRIPT_DIR}/VolCtl.exe"`. No path walking, no fallback list.

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

## CC-Specific: Dynamic-List (Span) Cycling Storage

Dynamic-list blanks — whose `get()` returns multi-line output, with each line a cycling alternative (e.g., Hacker News headlines) — fill a span wider than the single `_` position. They cycle through dedicated `_consumeAllAlts` storage instead of `_dynDefs` because:
- The multi-word span shifts the blank index, so multiple WordDefs collide at index 0 (grammar + cue-blank)
- The tips-only fast path replaces `_dynDefs` entirely, losing the cue-blank alts
- Per-word clearing deletes `_dynSpans` entries when words change between cycles

The alternatives flow through `_pendingAutoPopulate.consumeAllAlts` (set in the resolver callback) to `globalThis._consumeAllAlts` (set during auto-populate). The cycling path in `_cycleAlt` runs before dynamic alt cycling.

State that must be updated after each cycle: `_hlText`, `_hlState.text`, `_hlState.wordIndex`, `_dynLastAnalyzed`, `_dynPrevWords`, `_dynSpans`, and `_consumeAllAlts.spanLength`.

> **Removed (June 2026):** the `blankConsumeAll` / `blankReplace` / `blankConsumeContext` dials and the prompt-improver "consume-all" blank flavour are gone. Fill is now always additive (FILL only); command-span clearing is shape-derived (a captured arg, a typed set/step, or an `integration:` template consumes the whole "keyword … _" command span, while a bare keyword get keeps its label). Free-form prompt rewrites route through `TransformBlankSource` (imperative instructions) and lookups through `FluidBlankSource` (always-FILL). The `_consumeAllAlts` storage described above survives only as the backing for dynamic-list (span) cycling. See [blank-integration](../../../docs/architecture/blank-integration.md).

## Related

- [Cue-Blanks feature spec](../../../docs/features/cue-blanks.md) — concept
- [Blank Integration](../../../docs/architecture/blank-integration.md) — blank routing (`blankShapes` / `blankKeywords`) + output placement (`integration:` template)
- [Adding a Cue-Blank](../../../docs/guides/adding-a-cue-blank.md)
