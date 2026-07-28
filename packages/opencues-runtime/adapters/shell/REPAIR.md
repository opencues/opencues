# Terminal adapter — repair guide

Standalone Bun + OpenTUI app (`oc-edit`). Pin: **@opentui/core 0.1.99**, served by the `shell/v1/` adapter band. Unlike CC / OC / Gemini, there is no upstream host to fork — we own the entire app.

The band-specific code lives at:

- `packages/opencues-runtime/adapters/shell/v1/adapter.ts`
- `packages/opencues-runtime/adapters/shell/v1/boot.ts`
- `integrations/shell/src/app.tsx`
- `integrations/shell/src/bootstrap.ts`
- `integrations/shell/patches/setup.sh`
- `integrations/shell/bin/install.cjs`

OpenTUI itself is identical to what OC uses, so the **OC REPAIR.md** (`packages/opencues-runtime/adapters/oc/REPAIR.md`) is the first place to look for any OpenTUI-flavoured failure — LF-1 through LF-8 all apply structurally. This file documents only what's **shell-specific**.

## Host quirks (Terminal v1) — known fixes baked into the bootstrap

### LT-1. Bun resolves `bunfig.toml` from cwd, not from the script's directory

**File:** `packages/opencues-cli/src/commands/run.cjs` — `runTerminal()`.

**Symptom:** `oc-edit` (or `opencues run shell`) launched from any directory other than `integrations/shell/` dies with `Cannot find module 'react/jsx-dev-runtime' from .../src/app.tsx`.

**Why:** Bun's bunfig discovery looks in the cwd, not where the script lives. The terminal app's bunfig contains `preload = ["@opentui/solid/preload"]`, which is what installs the Solid JSX runtime. Without it, Bun falls back to the default JSX import source — `react/jsx-dev-runtime` — and bails.

**Fix:** `runTerminal()` spawns bun with `cwd: integrations/shell` **and** passes `--preload @opentui/solid/preload` explicitly. Belt-and-braces — losing either alone has bitten us. If you change the launch path, keep both.

### LT-2. `@opencues/core/node-http-adapter` must live at the package root, NOT in `dist/`

**File:** `integrations/shell/patches/setup.sh` — staging step.

**Symptom:** Boot log shows `Resolver: NodeHttpAdapter load failed { ... Cannot find module '@opencues/core/node-http-adapter' from .../resolver.js }`. Cues never resolve (no LLM round-trip).

**Why:** `node-http-adapter.js` is a hand-written CJS module that bypasses tsc — it lives at `packages/opencues-core/node-http-adapter.js`, **not** under `src/`. Resolver imports it via `require('@opencues/core/node-http-adapter')`. With `package.json` `main: "dist/index.js"` and no `exports` map, Node resolves the subpath from the package root, expecting `<pkg>/node-http-adapter.js` — copying it into `<pkg>/dist/` leaves the root path missing and the require fails.

**Fix:** `setup.sh`'s staging step copies the file to `node_modules/@opencues/core/node-http-adapter.js` (package root), **not** `node_modules/@opencues/core/dist/node-http-adapter.js`. This is the LF-7 trap from the OC band repeating in a slightly different form — both surfaces silently drop LLM resolution unless this file lands at the right depth.

### LT-3. `@opencues/solid`'s `jsx-runtime` export is a `.d.ts` file — the real runtime comes from the Bun preload

**File:** `integrations/shell/bunfig.toml`.

**Symptom:** Without the bunfig preload, TypeScript "resolves" the JSX import to `@opentui/solid/jsx-runtime.d.ts` and Bun reports `Export named 'jsxDEV' not found in module .../jsx-runtime.d.ts`.

**Why:** `@opentui/solid`'s `exports` map points `./jsx-runtime` → `./jsx-runtime.d.ts` deliberately — there is no separate jsx-runtime JS. The actual JSX runtime is installed at import time by `@opentui/solid/preload`, which hooks Bun's JSX transform to emit Solid-flavoured calls.

**Fix:** the bunfig at `integrations/shell/bunfig.toml` carries:

```toml
preload = ["@opentui/solid/preload"]
```

Don't remove this even if a future Bun version "fixes" the d.ts confusion — the preload is what registers the Solid renderer with `@opentui/core`, separately from JSX itself.

### LT-4. `editBuffer.setText` / `replaceText` clear all extmarks; insert/delete only adjust

**File:** `integrations/shell/src/bootstrap.ts` — `setText` and `pushText` paths.

This is the OC LF-4 trap repeating — the OpenTUI primitive is identical between hosts.

**Symptom:** Dims survive same-line typing but vanish after any runtime-driven write (agent rewrite, BlankFill substitute, cycle).

**Why:** OpenTUI's `ExtmarksController` ADJUSTS extmarks on `insertChar` / `deleteChar` / `newLine` / `undo`, but CLEARS them on `setText` / `replaceText` / `clear`. Our runtime-driven writes funnel through `textarea.setText(text)`, which nukes every extmark — the next render's diff says "already own d:S:E, skip create" and leaves the dim invisible.

**Fix:** `setText` and `pushText` reset `ownedExtmarks = new Map()` at the bottom of their bodies. Next render rebuilds from scratch. User-typed character paths go through `insertChar` and are unaffected.

This is the same fix that landed in OC commit `9c09d9c` — the bootstrap source carries it forward.

### LT-5. A consumed key MUST `evt.preventDefault()` or the focused textarea double-inserts it

**File:** `integrations/shell/src/app.tsx` — the `useKeyboard` handler.

**Symptom:** `_`-cycle inside a painted cue note "cycled then inserted my `_`" — the first `_` rotated the cue AND left a stray `_`, and the second `_` refused to cycle ("can't cycle twice"), instead inserting and killing the span. Normal `_`-blank fills (`translate _`) had the same latent stray-`_`-after-fill shape.

**Why:** OpenTUI routes each keypress through `InternalKeyHandler.emitWithPriority` (core `index-*.js`): **global listeners fire first** (`renderer.keyInput.on("keypress", …)`, which is where `useKeyboard` registers), THEN the focused renderable's own insert handler — but *only if* `keyEvent.defaultPrevented` is still false (`if (keyEvent.defaultPrevented) return` gates the renderable set). `keyInput` and `_internalKeyInput` are the **same** `_keyHandler` instance, so a `preventDefault()` in `useKeyboard` crosses over and suppresses the textarea insert. The shell's handler called `dispatchOpenCuesKey(evt)` but **ignored its boolean return and never called `preventDefault`**, so the textarea inserted every character the runtime had already consumed. For `_`-cycle that stray insert pushes the caret one past `spanEnd`; `Cycling.stepUnderscore`'s gate (`cursor <= def.spanEnd`) then rejects the next `_`, which falls through and inserts literally.

**Fix:** mirror the OpenCode band exactly —

```tsx
if (dispatchOpenCuesKey(evt)) {
  evt.preventDefault?.();
  evt.stopPropagation?.();
}
```

**Why the harness can't catch it:** the event-bridge's `oc-inject key:` path calls `bootResult.dispatchKey` **directly**, never through app.tsx's `useKeyboard`, so the missing `preventDefault` seam is invisible to every headless test. The runtime's `cycling.test.ts` `_`-cycle suite uses `MockAdapter.fireKey`, which returns `consumed` with no textarea to double-insert — also green while the real app was broken. This is a structural gap: the useKeyboard→preventDefault contract lives only in app.tsx and only fires under real keystrokes. If you touch that handler, re-verify manually in a real `oc-shell` (restart it fully — `oc-edit --keep-alive` holds the old `dist/app.js`).

## Sketches we deliberately didn't ship — wait for the bug before adding

- **Trace logging.** OC's bootstrap writes `/tmp/opencues-cursor-trace.log` per cursor touchpoint, gated on `OPENCUES_TRACE_CURSOR`. We dropped it from the terminal bootstrap because none of the cursor-jump bugs that motivated it have surfaced yet. Add it back the first time a cursor-jump bug bites here.
- **`replaceText` vs `setText`.** OC's mem-buffer-leak fix (commit `9c09d9c`) switched the prompt writer to `replaceText` to avoid the u16-bounded mem-slot registry leak. We use `setText` here for now — the leak takes 65k mutations to trigger and our app's session length is much shorter than OC's. If a user runs `oc-edit` against a multi-hour pipeline, swap to `replaceText`. The mitigation in LT-4 still applies.

## OpenCode quirks that DON'T apply

Most of OC's REPAIR.md catalogue is about glue between Bun and OpenCode's SolidJS host (the `useTheme().syntax` memo unwrap, the `__ocPromptHolder` singleton, the patched Prompt component's onContentChange routing). The terminal app owns its own Solid render — there's no holder/publish dance, the textarea ref lands straight on `startOpenCues()`. Those quirks structurally cannot fire here.

## Cross-terminal key handling — the long tail

Not strictly a "repair" but worth catalogue-ing as quirks surface:

- **macOS Terminal.app** — `Alt` is the menu key. Users may need `Option + arrow` or to enable "Use Option as Meta key" in profile preferences.
- **iTerm2** — Profiles → Keys → Left/Right Option → set to `Esc+` if Ctrl+Alt+arrow doesn't reach the app.
- **tmux** — `set -g xterm-keys on` in `.tmux.conf`; without it tmux swallows the modifier.
- **Windows Terminal / WSL** — usually works out of the box.
- **Alacritty / Kitty / Ghostty** — usually works; check `tput` reports the right sequences.

When users report key issues, ask them: which terminal emulator, which OS, which shell. Add the empirical mitigation to this section once verified.
