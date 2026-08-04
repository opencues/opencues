# CLAUDE.md — OpenCode integration

The OpenCode integration patches a pinned [sst/opencode](https://github.com/sst/opencode)
fork in place — unlike Claude Code (which patches a minified bundle
via tweakcc), OpenCode ships its source `.tsx` files in the npm
tarball, so we patch source and let Bun rebuild on launch. Cleaner
than CC's tweakcc dance; closer in shape to the Gemini CLI
integration.

## Where things live

| File | Role |
|---|---|
| `pin.json` | Pinned upstream version + sha (currently `v1.14.17` / `40ba8f3`; the older `v1.4` band is also tested) |
| `compat.json` | Declared host compatibility ranges |
| `bin/install.cjs` | Installer entry — orchestrates the clone + bun-install + build + patch |
| `patches/setup.sh` | One-command installer. Idempotent. Re-runs only re-apply patches that aren't already in place |
| `patches/opencuesBootstrap.ts` | The bootstrap — copied to fork as `opencues.ts`. Boots `@opencues/runtime` against the OpenCode TUI |
| `UPGRADING.md` | Version-bump runbook (the only integration with this doc as of 2026-05; pattern should extend to the others) |
| `../../packages/opencues-runtime/adapters/oc/v1.4/` | Adapter band for OpenCode 1.4.x |
| `../../packages/opencues-runtime/adapters/oc/v1.14/` | Adapter band for OpenCode 1.14.x |
| `../../packages/opencues-runtime/adapters/oc/REPAIR.md` | Version-bump playbook (8 host quirks documented) |

The four files patched in the fork (paths relative to the cloned
`~/.opencues/forks/opencode/` tree — they are NOT files in the OpenCues repo):

- `packages/opencode/src/cli/cmd/tui/app.tsx` — entry; injects `opencues.ts` bootstrap call
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — publishes textarea ref + onContentChange handler
- `packages/opencode/src/cli/cmd/tui/feature-plugins/home/footer.tsx` — renders the OpenCues tip alongside MCP status
- `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx` — sidebar tip rendering

## The install flow

`opencues install opencode` runs `bin/install.cjs`, which chains:

1. **Clone** `sst/opencode` at the pinned SHA into `~/.opencues/forks/opencode/`
   (or reuse an existing clone at `--target <path>`).
2. **Install fork dependencies** via `bun install` so the fork's own
   deps (e.g. `@opentui/solid/preload`) land. **Bun is a hard prereq**
   — OpenCode itself is a Bun app, not a Node app.
3. **Build** `@opencues/core` + `@opencues/runtime` (turbo-cached).
4. **Install** the built artefacts into the fork at
   `node_modules/@opencues/{core,runtime}/` by `cp -r`'ing
   `dist/` + `package.json`. No symlinks — Node's bare-specifier
   resolution finds them on its own. The full-recursive `cp -r dist/`
   shape covers any new dist subdir automatically, which is the
   structural property that kept OC clear of the June 2026 PR #117
   providers/ regression that hit CC. If you ever switch this to a
   hard-coded subdir list ("copy only sources/, runtime/, …"), the
   same silent-boot-failure bug class returns. The CI gate for that
   class is `scripts/check-cc-bundle-integrity.sh` (CC-specific
   today); add a parallel gate before changing the copy shape here.
5. **Patch** the fork in place: drops `opencues.ts` bootstrap + edits
   the four `.tsx` files via anchor-based `str.replace`. Each patch
   is idempotent — looks for a marker string from its injection and
   returns early if already present.

Re-runs are idempotent — unchanged patches skip, unchanged builds
skip. First install ~5 min (mostly `git clone` + `bun install`);
re-runs are under 30s.

## How patching works

OpenCode's source `.tsx` files use stable identifiers (unlike CC's
minified bundle), so we anchor patches against real symbol names —
not regex against obfuscated names. Example anchor:

```
"  } = inputState;\n  const isHelpDismissKey = useIsHelpDismissKey();"
                                  // unique inputState destructure end
```

Anchors are unique substrings of the upstream source. When a
version bump moves an anchor, `setup.sh` logs `WARN: ... anchor not
found` and continues — the patch silently no-ops, but you'll see
it at the next launch (no OpenCues tip in the footer).

Grep the patched source after upgrading the pin to confirm
injections landed:

```bash
grep -n "startOpenCues\|publishPromptAccess" \
  ~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/app.tsx \
  ~/.opencues/forks/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
```

## Iteration loop

After changes to `opencuesBootstrap.ts`, `setup.sh`, or shared
runtime modules:

```bash
bash integrations/opencode/patches/setup.sh
opencues run opencode
```

The script restores patched files via `git restore` before re-
applying, so stale half-state is impossible — every run is from
clean source. Warm install: ~30s.

## Debugging

- **`tail -f /tmp/opencues.log | grep '\[oc\]'`** — runtime logs
  (per-host prefix added 2026-05-19).
- **`opencues doctor`** — diagnoses install boundary issues.
- **`/tmp/opencues-install-oc.log`** — install-time log if setup.sh
  failed.

## Known fixes baked into the adapter

See `../../packages/opencues-runtime/adapters/oc/REPAIR.md` for the
host-quirk catalogue. Eight quirks (LF-1 through LF-8) surfaced when
the adapter first ran against a live fork. All are baked into the
current adapter sources; check they're still in place after a
version bump:

- LF-1: keypress filter wrap (without it, every key handler ran for
  every key, blocking typing after one character)
- LF-2: SolidJS `useTheme().syntax` is a memo, not the SyntaxStyle
  itself — needs `.get()`
- LF-3 through LF-8: see REPAIR.md

## Version bumps

When `sst/opencode` ships a new version:

1. Update `pin.json` to the new sha.
2. If it's a same-minor bump (e.g. 1.14.17 → 1.14.20), the existing
   adapter band should work — run `setup.sh` and check for anchor
   warnings.
3. If it's a cross-minor bump (e.g. 1.14 → 1.15), create a new
   adapter band under `adapters/oc/v1.15/` (copy v1.14 as a starting
   point) and update `compat.json`.
4. See `UPGRADING.md` for the full runbook — this is the only
   integration that has one today, and the pattern should extend to
   the others.
