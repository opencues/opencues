# Upgrading the Gemini CLI pin

This is the runbook for moving the Gemini CLI integration from one upstream
SHA to another. Currently pinned at `v0.41.2` / SHA `b0c7a17`.

Gemini CLI ships source `.tsx` files in its tarball, so we patch source and
let the fork rebuild — same shape as OpenCode, but with React/Ink rendering
and a pull-model render-kick on top. The React quirks make Gemini the most
fragile of the three native hosts under version bumps; budget more time per
bump than for OC.

## Prerequisites

- A clean worktree of the OpenCues repo.
- The Gemini fork at `~/.opencues/forks/gemini-cli/` (or wherever `--target` points).
  If it doesn't exist, install will clone fresh and most of the dance below
  collapses.
- `npm` on PATH (Gemini's build tool — pnpm won't work inside the fork).

## The dance

### 1. Pick the target SHA

```bash
git ls-remote --tags --refs https://github.com/google-gemini/gemini-cli | tail -10
```

Prefer a tagged release over `HEAD` — Gemini does tag every release, so SHA
pinning has a human-readable anchor. Resolve the tag's SHA:

```bash
git ls-remote https://github.com/google-gemini/gemini-cli refs/tags/v0.42.0
```

### 2. Diff the patch surface against the current pin

The integration patches four files in the fork. Before bumping, confirm
upstream hasn't moved or rewritten them:

```bash
cd ~/.opencues/forks/gemini-cli
git fetch origin <new-sha>
git diff <old-sha>..<new-sha> -- \
  packages/cli/src/ui/AppContainer.tsx \
  packages/cli/src/ui/components/InputPrompt.tsx \
  packages/cli/src/ui/components/Footer.tsx \
  esbuild.config.js
```

**Three outcomes:**

- **Empty diff.** Patches will apply byte-identically. Proceed to step 3.
- **Cosmetic drift** (whitespace, nearby unrelated edits). The python
  string-replace patcher is line-anchored — if the anchor strings still
  appear verbatim, patches still apply. Test in step 6.
- **Anchor strings moved or rewritten.** Port the patches. Open
  `integrations/gemini-cli/patches/setup.sh`'s `patch_*` functions and
  update the anchor strings. Current anchors (see `CLAUDE.md` for full
  list):
  - `AppContainer`: `"const settings = useSettings();"`
  - `InputPrompt`: `"  } = inputState;\n  const isHelpDismissKey = useIsHelpDismissKey();"`
  - `Footer`: `"import { isDevelopment } from '../../utils/installationInfo.js';"`
  - `esbuild.config.js`: `"const external = ["`

### 3. Update the pin

- `integrations/gemini-cli/pin.json` — `{ "version": "<new>", "sha": "<short-new>" }`
- `integrations/gemini-cli/compat.json` — append to `tested[]`, don't replace.
- `integrations/gemini-cli/README.md` — "Compatible with" line in the table.

Adjacent docs that track but aren't load-bearing:
- `README.md` (repo root) — heads-up paragraph in `## Install`.
- `integrations/gemini-cli/CLAUDE.md` — `pin.json` row in "Where things live".

### 4. Uninstall the old patches

```bash
opencues uninstall gemini-cli
```

Reverts the four patched files via `git checkout --`, deletes the
`opencues.ts` bootstrap copy, and removes `node_modules/@opencues/*` from
the fork. The fork itself (`~/.opencues/forks/gemini-cli/`) stays in place.

**Important**: if uninstall doesn't list all four patched files in its
plan, `bin/install.cjs`'s patched-files list is out of sync with
`setup.sh`'s `patch_*` functions — fix that first or leftover edits will
block step 5's `git checkout`.

### 5. Move the fork to the new SHA

```bash
cd ~/.opencues/forks/gemini-cli
git fetch origin <new-sha>
git -c advice.detachedHead=false checkout <new-sha>
# npm install runs automatically as part of step 6 — no need here
```

If the checkout complains about local changes, something from step 4 got
missed. `git status --short` will show what; revert manually with `git
checkout -- <file>` and re-try.

### 6. Reinstall

```bash
opencues install gemini-cli
```

Seven steps run: fork-presence check, `npm install` (deps refresh for the
new SHA), build core + runtime, copy artefacts into the fork's
`node_modules/`, copy `opencuesBootstrap.ts` into the fork as
`packages/cli/src/ui/opencues.ts`, apply patches, and `npm run build` in
the fork to compile the patched .tsx into `packages/cli/dist/`.

If any step fails:

- **`npm install` fails:** Gemini may have added a dep that conflicts with
  the node version on PATH. Gemini requires Node 20+; check
  `~/.opencues/forks/gemini-cli/package.json` engines field.
- **Build fails with `Cannot find module '@opencues/core'`:** core's
  `dist/` is missing. setup.sh's build step orders core before runtime;
  if you've reordered, restore that.
- **Patch fails:** the python `src.replace` returned the source unchanged
  because an anchor string moved. Go back to step 2's diff, update the
  anchor, retry. Patches are idempotent.
- **`npm run build` fails:** the patched .tsx didn't compile. The most
  common cause is a TypeScript error in our injection because we
  referenced a name (e.g. `useSettings`) that was renamed upstream. The
  build error message points at the line.

### 7. Smoke check

```bash
opencues run gemini-cli
```

Watch `/tmp/opencues.log` for the boot line:

```
[HH:MM:SS][info] OpenCues runtime starting (Gemini CLI v0.41)
```

Then exercise the seven-row test pass from `integrations/gemini-cli/CLAUDE.md`'s
"Test pass after touching gemini" table. The minimum subset:

| Test | What it checks |
|---|---|
| Type `this has a mispelled word`, ctrl+alt+left | Cycling on the LLM-routed `mispelled` (spelling cue), Up/Down rotates corrections |
| Type `volume _` | Cue-blank script auto-populate + system volume cycling |
| Type `opencues settings _`, cycle Up | Selector/satellite via the runtime class |
| Footer shows tip when a word is highlighted | `useOpenCuesTip()` React hook wiring |

If a smoke check fails, runtime diagnostics are in `/tmp/opencues.log`.
React-render-related symptoms (flashes, lag, frozen UI after cycling) are
in §1-2 of CLAUDE.md's "React/Ink quirks" section — read that BEFORE
debugging suspected anchor/build issues. Most "after the bump nothing
renders" reports turn out to be the ZWS toggle or render-kick wiring
losing a binding, not the patch failing.

Also grep the patched source to confirm injections landed:

```bash
grep -n "startOpenCues\|publishPromptAccess\|useOpenCuesTip" \
  ~/.opencues/forks/gemini-cli/packages/cli/src/ui/AppContainer.tsx \
  ~/.opencues/forks/gemini-cli/packages/cli/src/ui/components/InputPrompt.tsx \
  ~/.opencues/forks/gemini-cli/packages/cli/src/ui/components/Footer.tsx
```

A `WARN: ... anchor not found` in install output silently no-ops the
patch; if the grep returns zero hits for a marker, that patch didn't
apply even though the install reported success.

### 8. Run the harness

Same as the other hosts — run the private agentic harness against the
upgraded integration. It's the only practical way to catch React-side
state regressions that don't show in single-keystroke smoke tests.

### 9. Commit

One commit, scoped tight:

```
chore(gemini-cli): pin to v0.42.0
```

PR body links to the upstream release notes and calls out any non-trivial
findings from step 2's diff.

## Common upgrade gotchas

- **Render-kick wiring is non-optional.** Every wrapped setter in `boot.ts`
  (`wrappedSetText/Cursor/Push/ForceRender`) MUST call `host.forceRender?.()`
  after queuing pending state. If a bump changes the wrapped-setter
  shape and any one of those forgets the call, the UI looks frozen
  after cycling until the user moves the cursor manually. See CLAUDE.md
  § "React/Ink quirks" #1.

- **ZWS toggle reads as user input if `markRuntimeWrite` is dropped.**
  Navigation moving the highlight without changing text relies on the
  ZWS toggle in `consumePendingOpenCues`. That write MUST call
  `sourceReclassifier.markRuntimeWrite(pending.text)` first, otherwise
  the next text-change notify fires with `source='user'` and Navigation
  deactivates the highlight on every nav key press. See CLAUDE.md
  § "React/Ink quirks" #2.

- **Code-point vs UTF-16 cursor offsets.** Gemini's buffer uses code-point
  cursor offsets (each emoji = 1); the runtime uses UTF-16 code units
  (each emoji surrogate pair = 2). The boundary conversion lives at
  every binding seam in `opencuesBootstrap.ts`. Don't drop conversion at
  any seam — emoji-left-of-cursor drifts the highlight by ~1 col per
  emoji to its left. See CLAUDE.md § "React/Ink quirks" #5 for the full
  conversion table.

- **`runGemini` launching with `cwd: <fork>`.** The fork ships its own
  `.gemini/settings.json` with `general.devtools: true` + experimental
  flags, which Gemini picks up cwd-locally and overrides the user's
  settings. Keep `runGemini` launching WITHOUT forcing cwd into the
  fork so the user's `~/.gemini/settings.json` governs.

- **`navigableWords` is built from EXPLICIT word entries.** The shipped
  LLM cue source (`spelling`) uses a `match:` regex that routes words at
  cue time but doesn't enumerate them, so a word like `lawyer` won't be
  in the static navigableWords list even though spelling's `.*` would
  claim it. Test cycling with words that are either in a tip group's
  keyword list (e.g. `ultrathink`) or a misspelled word `spelling` flags.

## Same-patch vs same-minor vs cross-minor

- **Same-patch** (v0.41.2 → v0.41.5): expect ~10 min. Anchors usually
  hold. React surface stable.
- **Same-minor** (v0.41 → v0.42): expect 20-60 min. Anchors usually
  hold; verify React hook surface (useKeypress, KeypressPriority) hasn't
  shifted.
- **Cross-major** (v0.x → v1.0): expect hours. React component layout
  could move (AppContainer, InputPrompt, Footer paths). Plan on a new
  adapter band under `packages/opencues-runtime/adapters/gemini/v1.0/`,
  re-baselining each entry in `gemini/REPAIR.md`, and re-running the
  React-quirks test matrix end-to-end.

The current adapter band is `gemini/v0.41/`. A cross-major bump creates
`gemini/v1.0/` side-by-side (copy v0.41 as a starting point) and
updates `compat.json` so each band targets its own range.

## Reference

- `integrations/gemini-cli/CLAUDE.md` — patch architecture + React quirks
- `integrations/gemini-cli/patches/opencuesBootstrap.ts` — the bootstrap
- `integrations/gemini-cli/patches/setup.sh` — installer script
- `packages/opencues-runtime/adapters/gemini/v0.41/` — adapter band
- `/tmp/opencues-install-gemini.log` — install-time log when setup.sh fails
