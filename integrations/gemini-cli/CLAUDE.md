# CLAUDE.md — Gemini CLI integration

The Gemini integration is the first React/Ink host. Most of what makes
it different from CC/OC is React's render model, which is incompatible
with the runtime's existing pull-model patterns out-of-the-box.
Everything below is what we learned the hard way during the May 2026
reintegration.

## Where things live

| File | Role |
|---|---|
| `pin.json` | Pinned upstream version + sha (currently 0.41.2) |
| `patches/setup.sh` | Clone fork, build runtime/core, patch 4 files, build fork |
| `patches/opencuesBootstrap.ts` | Copied to fork as `packages/cli/src/ui/opencues.ts`. Glue between Gemini's React surface and `@opencues/runtime`'s `boot()` entry. |
| `../../packages/opencues-runtime/adapters/gemini/v0.41/boot.ts` | Adapter band — owns `wrappedSetText/Cursor/Push/ForceRender`, pull-model state (`pendingText/Cursor/Render`), `consumePendingRenderImpl`, `decorateLine`. |
| `../../packages/opencues-runtime/adapters/gemini/v0.41/adapter.ts` | `GeminiV041Adapter` — implements the runtime's `HostAdapter` contract using the `GeminiBindings` from boot.ts. |

The four files patched in the fork:

- `packages/cli/src/ui/AppContainer.tsx` — adds `useEffect(() => startOpenCues(...), [])` and `useKeypress(... KeypressPriority.Critical)` so we intercept keys before any other subscriber.
- `packages/cli/src/ui/components/InputPrompt.tsx` — publishes `PromptInputAccess`, observes text+cursor, registers the render-kick (`useOpenCuesRenderTick`), pulls pending render state on every render via `consumePendingOpenCues`, decorates each visual line via `decorateOpenCuesLine`.
- `packages/cli/src/ui/components/Footer.tsx` — adds an `addCol('opencues-tip', ...)` driven by `useOpenCuesTip()`.
- `esbuild.config.js` — marks `@opencues/{core,runtime}` as external so the bundler doesn't try to resolve our path-style imports.

## How patching works

Unlike Claude Code (where we monkey-patch a minified `cli.js` via
tweakcc using regex anchors against obfuscated identifiers), Gemini
ships its source `.tsx` files in the fork. We patch source, then
rebuild.

`patches/setup.sh` runs these steps idempotently:

1. **Clone** `google-gemini/gemini-cli` at the pinned sha into
   `~/gemini-cli-cues` (skip if already present).
2. **`npm install`** inside the fork so `npm run build` can resolve
   ink/react/etc.
3. **Build** `@opencues/{runtime,core}` from this repo via pnpm.
4. **Install** the built packages into `<fork>/node_modules/@opencues/{runtime,core}/`
   by `cp -r`'ing `dist/` + `package.json`. No symlinks — Node's bare-specifier
   resolution finds them on its own. Each install is `rm -rf`'d first
   so a stale layout from an earlier setup.sh layout can't shadow.
5. **Copy** `opencuesBootstrap.ts` to `<fork>/packages/cli/src/ui/opencues.ts`.
   The patched .tsx files import from `./opencues.js` (NodeNext
   resolution maps that to opencues.ts at build time).
6. **Patch** the four fork files via Python heredocs that use
   `src.replace(old_anchor, new_text, 1)`. Each patch is **idempotent**:
   the function returns early if a marker string from its injection
   (e.g. `startOpenCues`, `publishPromptAccess`, `useOpenCuesTip`) is
   already present in the file.
7. **`npm run build`** in the fork to compile the patched .tsx into
   `packages/cli/dist/`. Without this, the gemini bin (which runs
   `node packages/cli/dist/index.js`) executes pre-patch sources.

### Patch anchors

The replace anchors are unique substrings of the upstream source —
NOT regex, NOT line numbers. Examples:

- AppContainer: `"const settings = useSettings();"` (unique destructure landmark)
- InputPrompt: `"  } = inputState;\n  const isHelpDismissKey = useIsHelpDismissKey();"` (unique inputState destructure end)
- Footer: `"import { isDevelopment } from '../../utils/installationInfo.js';"` (last import)
- esbuild.config.js: `"const external = ["` (start of the externals array)

When a Gemini version bump breaks an anchor, `patch_*` will print
`WARN: ... anchor not found` and continue without injecting. Always
grep the patched source after upgrading the pin to confirm injections
landed:

```bash
grep -n "startOpenCues\|publishPromptAccess\|useOpenCuesTip" \
  ~/gemini-cli-cues/packages/cli/src/ui/AppContainer.tsx \
  ~/gemini-cli-cues/packages/cli/src/ui/components/InputPrompt.tsx \
  ~/gemini-cli-cues/packages/cli/src/ui/components/Footer.tsx
```

### Iteration loop

After any change to `boot.ts`, `opencuesBootstrap.ts`, `setup.sh`,
or shared runtime modules:

```bash
bash integrations/gemini-cli/patches/setup.sh
opencues run gemini-cli
```

The script `git restore`s patched files before re-applying, so
stale half-state is impossible — every run is from clean source.
Warm install: ~30s.

### Debugging a failed setup

`OPENCUES_INSTALL_VERBOSE=1` streams every command's stdout/stderr.
Otherwise the failing step prints the last 30 lines of
`/tmp/opencues-install-gemini.log`.

### Uninstall

`opencues uninstall gemini-cli` (or `bin/install.cjs uninstall`)
removes `node_modules/@opencues/{core,runtime}`, deletes
`packages/cli/src/ui/opencues.ts`, and `git restore`s the four
patched files. Doesn't delete the fork itself — `rm -rf ~/gemini-cli-cues`
nukes everything.

## React/Ink quirks (this is the meat)

### 1. Render-kick is non-optional

React only re-renders when component state changes. The runtime's
`forceRender()` does nothing visible unless the host signals React to
re-render.

The bootstrap exposes `useOpenCuesRenderTick()` — a `useState` bumper
component-mounted in InputPrompt that registers itself as
`_renderKick`. The host's `forceRender` callback invokes the kick.

**Critical**: every wrapped setter in `boot.ts`
(`wrappedSetText/SetCursorOffset/PushText/ForceRender`) MUST call
`host.forceRender?.()` after queuing pending state. Without this,
runtime modules call `setText` to swap an alt, the new text gets
queued in `pendingText`, but no React re-render schedules — so the
useEffect that drains `consumePendingRender` never runs. UI looks
frozen until the user happens to type or move the cursor.

Headless mode also no-ops `host.forceRender` (since `headlessTrigger`
already drained synchronously) so this is safe across both modes.

### 2. ZWS toggle for pure forceRender

When the runtime calls `forceRender()` without changing text/cursor
(e.g. Navigation moving the highlight to a sibling word), React's
`useEffect([buffer.text])` won't fire — the text is identical.

Fix: when `consumePendingRender` is called with no pending text/cursor
but `pendingRender=true`, return a **ZWS-toggled** version of the
current text (toggles between trailing `\u200B` and `\u200C`). React
sees a "different" string, fires its effect, the InputPrompt
re-renders, `decorateLine` reapplies with the new hlState.

The ZWS write goes through `buffer.setText` **directly** from
InputPrompt's pull-model useEffect — bypassing our wrapped `setText`
that normally calls `markRuntimeWrite`. So `consumePendingOpenCues`
in `opencuesBootstrap.ts` MUST call `sourceReclassifier.markRuntimeWrite(pending.text)`
before returning. Without this mark, the next `notifyOpenCuesTextChange`
fires with `source='user'`, Navigation interprets it as the user
typing, and **deactivates the highlight** — the "flash and release"
symptom on every nav key press.

### 3. Per-segment render swap (decorateLine)

Gemini's `renderItem` builds each visual line as an array of `<Text>`
elements with per-segment colors. Our patch:
1. Accumulates segment displays into `__ocAnsiLine` in the existing
   loop.
2. Calls `decorateOpenCuesLine` (a wrapper over `applyDirectives`).
3. **Only when the result differs from the input** (i.e. directives
   actually applied), replaces `renderedLine.length = 0` and pushes
   one `<Text>{decorated}</Text>`.

Trade-off: per-segment syntax-highlight colors are lost on dimmed/
highlighted lines. Acceptable — dim/highlight beats colored
unhighlighted text. Acts like CC's `applyRender(rendered, text, cursor)`.

Don't switch to per-segment Ink-prop application (`dimColor`/`inverse`
on each `<Text>`). The CC-style string-wrap approach is intentional
and consistent across host bands.

#### Colour scope: word-level only — DO NOT line-wrap

`decorateOpenCuesLine` returns the runtime's `applyDirectives` output
**as-is** (after the code-point conversion). The runtime emits ANSI
only around the specific ranges that have directives:

- dim → `\x1b[2m…\x1b[22m`
- active selection → `\x1b[7m…\x1b[27m`
- markdown bold/italic/strike/heading/list → their respective ANSI

Plain words OUTSIDE any directive get **zero ANSI** from us. The
terminal renders them with whatever colour Gemini's per-segment
`<Text>` would have used, or the user's terminal default.

We tried wrapping the whole decorated line in OpenCues' brand
foreground (`\x1b[97m…\x1b[39m`, see `da0c393` revert). **Don't.**
The brand tint affected every char on the line — including untouched
words — making it look like OpenCues "owned" the whole line. The
explicit ask was: only OUR ranges (dim + selection) should be
visibly OpenCues; everything else stays terminal-default.

If you ever want to change the colour of dim or selection ranges
themselves (the user mentioned "background box like chrome" for
selection eventually), do it via post-processing the ANSI codes
in `decorateOpenCuesLine` — `.replace(/\x1b\[7m/g, …)` /
`.replace(/\x1b\[2m/g, …)`. Keep the swap scoped to the directive
escapes; don't add a line-wide wrap.

### 4. wrappedGetText must prefer pendingText

`wrappedGetText` / `wrappedGetCursor` in `boot.ts` read `pendingText`
/ `pendingCursor` BEFORE falling back to `host.getText()` /
`host.getCursorOffset()`. The fallback chain matters because the
resolver runs synchronously: `stopAllAnimations` queues
`setText("_")` (restores the underscore from the braille loading
char), then the same tick enters the substitution loop which reads
`adapter.getText()` to decide whether to write the LLM answer. The
React buffer hasn't drained yet — `host.getText()` returns the stale
braille char, FluidBlank's `!liveText.includes('_')` guard fires, and
the substitution skips.

Symptom: "write a poem about love _" plays the loading animation,
then `_` returns and the answer never lands. BlankSource blanks
(weather, volume) work because they fire from BlankFill
synchronously without animator — they don't depend on getText
reading the just-written `_`. Same trap applies to any future
pull-model adapter (chrome React variants, etc).

### 5. Code-point vs UTF-16 code-unit cursor offsets

Gemini's text buffer uses **code points** for cursor offsets (each
emoji counts as 1). The OpenCues runtime uses **UTF-16 code units**
(each emoji surrogate pair counts as 2). Without conversion, every
emoji to the left of the cursor drifts the highlight / selection /
cursor visually one column to the right per emoji.

See `packages/cli/src/ui/utils/textUtils.ts` — `cpLen`,
`cpIndexToOffset`, `cpSlice`. `buffer.cursor()` is built on
`logicalPosToOffset(lines, row, col)` which sums `cpLen(line) + 1`
per row, so the returned offset is code-point space. Same goes for
`buffer.setText(text, offset)` — its `offset` param is code points.

Conversion lives in `opencuesBootstrap.ts` at every binding seam
between Gemini and the runtime:

| Path | Direction | Helper |
|---|---|---|
| `getCursorOffset` | cp → cu | `codePointsToCodeUnits(text, cp)` |
| `setCursorOffset` | cu → cp | `codeUnitsToCodePoints(text, cu)` |
| `pushText` (cursor arg) | cu → cp | conversion uses the NEW text |
| `dispatchOpenCuesKey` | cp → cu | reads `buffer.cursor()` then converts |
| `notifyOpenCuesTextChange` | cp → cu | InputPrompt sends `logicalPosToOffset`; runtime expects code units |
| `notifyOpenCuesCursorChange` | cp → cu | same as text change |
| `consumePendingOpenCues` IN | cp → cu | `currentCursor` arrives in cp |
| `consumePendingOpenCues` OUT | cu → cp | `pending.cursor` returned in cu; InputPrompt's `buffer.setText` wants cp |
| `decorateOpenCuesLine` | cp → cu (×3) | `cursor`, `lineStart`, `lineEnd` all converted before applying directives |

The helpers (`isAsciiFast`, `codeUnitsToCodePoints`,
`codePointsToCodeUnits`) live at the top of `opencuesBootstrap.ts`.
`isAsciiFast` is a single-pass code-unit scan with no regex — pure
ASCII text short-circuits to zero conversion cost (the common case).

OpenCode and Claude Code don't need this — both use UTF-16
code-unit cursor offsets throughout. Single-source conversion
lives at the boundary so the runtime stays unit-agnostic. Any
**future React-buffer adapter** (chrome React variants, OpenCode if
it migrates) should check whether its buffer uses code points or
code units and add the same boundary conversion if so.

Pinned by manual test: type `Tu 😊 es 😊 le bluh` and run cycling /
navigation on `bluh`. Highlight stays on `bluh`. Before this fix the
highlight drifted 1 col right per emoji to its left.

## Things that LOOK like patch bugs but aren't

### "Blue background ▀/▄ blocks around the input box"

Gemini default `ui.useBackgroundColor: true` (settingsSchema.ts:805)
+ `HalfLinePaddedBox` renders this. Has nothing to do with our
patches. User keeps `~/.gemini/settings.json` with `useBackgroundColor: false`.

Until May 2026, `runGemini` in `packages/opencues-cli/src/commands/run.cjs`
launched with `cwd: <fork>`. The fork ships its own `.gemini/settings.json`
enabling `general.devtools: true` + many experimental flags, which
Gemini picks up cwd-locally and overrides the user's settings.
**Keep `runGemini` launching without forcing cwd into the fork** so
the user's `~/.gemini/settings.json` governs.

### "ctrl+alt+arrow flashes the highlight then releases"

Cause: see §2 above — ZWS toggle wasn't being marked as a runtime
write, so the source reclassifier saw it as user input and Navigation
deactivated. Fixed by `markRuntimeWrite` in `consumePendingOpenCues`.

### "Highlight / selection drifts when emojis are in the buffer"

Cause: see §5 above — Gemini buffer uses code-point cursor offsets,
runtime uses UTF-16 code units. Without conversion at the binding
seam, every emoji to the left of the cursor offsets the highlight
~1 column right. Fixed by `codePointsToCodeUnits` /
`codeUnitsToCodePoints` wrappers in `opencuesBootstrap.ts`. Pure
ASCII buffers short-circuit (zero overhead).

### "Volume blank doesn't increment when I press up after selecting volume"

User must type `volume _` (with the underscore — the blank trigger).
The `_` auto-populates with current volume via `volume-blank.sh get`,
THEN up/down on the populated value cycles. Without the `_`, there's
no slot, so `cycleBlankStep` has nothing to step.

### "Lawyer doesn't activate cycling"

`navigableWords` (config-loader.ts:586) is built from EXPLICIT word
entries in cueMap. The shipped LLM cue sources (legal/medical/financial)
all use `match:` regexes that route specific words but don't
enumerate them. `lawyer` isn't in any cueMap → not navigable.

Test cycling with words that are explicitly in a tip group (e.g.
`ci-cd` from `cues/tips/CUE.md`) or with words that match a cue
source's regex (e.g. `clause`, `contract` for legal) AND are also in
its keyword/word list. Or add a default-source (no `match:`) that
catches everything.

## Debug

- Runtime log: `/tmp/opencues.log` — module-level events (BlankFill
  substitutions, Resolver builds, etc.)
- Per-process status snapshot: `/tmp/opencues-status-<pid>.json`
- Per-process bridge events (when `OPENCUES_BRIDGE=1`): `/tmp/opencues-events-<pid>.jsonl`
- For key-dispatch debugging, temporarily wire `fs.appendFile('/tmp/opencues-keys.log', ...)` calls in `dispatchOpenCuesKey` (opencuesBootstrap.ts) — strip after use.

## Pinned-test workflow

After any change to `boot.ts`, the bootstrap, or setup.sh:
```bash
bash integrations/gemini-cli/patches/setup.sh
opencues run gemini-cli
```

`setup.sh` is idempotent — re-running it restores the patches from
clean source (it `git restore`s patched files internally before
re-applying). If you ever see weird patch state, just re-run setup.

## Test pass after touching gemini

| What | Type | Expect |
|---|---|---|
| `we shall draft the contract clause` then ctrl+alt+left | Cycling (LLM) | Highlight on `clause` (legal cue), up/down rotates alts |
| `volume _` | Cue-blank script | `_` auto-populates to e.g. `25%`; up/down on it adjusts system volume |
| `weather _` | Cue-blank HTTP | `_` auto-populates with current temp |
| `atomic number of oxygen _` | Fluid blank | LLM substitutes `8` |
| `fix typos _ this is bad righting` | Transform blank | Rewrites to `this is bad writing` |
| `opencues settings _` | Selector blank | Shows e.g. `voice-mode active`; up/down toggles |
| Any active cycle | Footer | Shows `attorney (2/5) - …` while cycling |
