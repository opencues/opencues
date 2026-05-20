# Upgrading the Claude Code pin

This is the runbook for moving the Claude Code integration from one upstream
version to another. Unlike OpenCode and Gemini CLI (where we patch real source
`.tsx` files and rebuild), CC ships only a minified `cli.js` and we patch the
bundle in place via tweakcc with regex-anchored injections. That choice
constrains everything below.

The integration is pegged at `@anthropic-ai/claude-code@2.1.110` (exact, no
caret). Same-patch and same-minor upstream bumps usually apply cleanly;
cross-minor bumps are the risky shape because the obfuscated identifiers
tweakcc anchors against can be renumbered between minified builds.

## Prerequisites

- A clean worktree of the OpenCues repo. Don't do this on a branch with
  unrelated work-in-progress — fork-side state changes are easier to
  reason about in isolation.
- The CC fork at `~/claude-code-cues/` (installed by `opencues install
  claude-code`). If it doesn't exist, the full install will reinstall it
  fresh and most of the dance below collapses.

## The dance

### 1. Pick the target version

```bash
npm view @anthropic-ai/claude-code versions --json | tail -20
```

Prefer the latest stable in the same minor line (`2.1.x`) over a cross-
minor jump. CC publishes patch versions frequently; same-patch bumps
almost always apply.

### 2. Diff the patch surface against the current pin

The patch operates against the minified `cli.js`. Before bumping, fetch
both versions and run a structural diff of the **injection sites** — the
anchors `opencuesRuntime.ts` regex-matches against. The current
anchors are:

- `getRequireFuncName(oldFile)` — finds CC's per-build `createRequire`-derived
  var name.
- The boot-injection site (look at `opencuesRuntime.ts` for the exact
  regex).
- The text-change handler hook.
- The keypress handler hook.
- Statusline + theme patch sites (currently disabled — every stock tweakcc
  patch is off; only OpenCues v2 wiring runs).

Quick check that anchors are likely intact in a candidate version:

```bash
npm pack @anthropic-ai/claude-code@<new-version> --pack-destination /tmp
mkdir -p /tmp/cc-new && tar xzf /tmp/anthropic-ai-claude-code-*.tgz -C /tmp/cc-new
# Search for marker substrings from existing anchors — adjust patterns
# from opencuesRuntime.ts's regexes
grep -c "createRequire" /tmp/cc-new/package/cli.js
```

**Three outcomes:**

- **Anchors all present, count matches.** Patches will apply. Proceed to step 3.
- **Anchor count changed but pattern still present.** Likely safe; verify
  uniqueness — tweakcc's `src.replace(old, new, 1)` requires the anchor be
  unique enough that the regex matches the right occurrence.
- **Anchor regex no longer matches.** You'll need to port the patches. Open
  `integrations/claude-code/patches/opencuesRuntime.ts` and update the
  regex against the new `cli.js`. The unpacked bundle from this step is
  your reference.

### 3. Update the pin

Edits required:

- `integrations/claude-code/compat.json` — declare the new range. Don't
  replace existing entries; the array is the historical record of every
  version we've proven.
- `integrations/claude-code/README.md` — the "Compatible with" line in the
  table at the top.
- `integrations/claude-code/patches/setup.sh` — if it pins
  `@anthropic-ai/claude-code@<exact-version>`, bump it here. Exact pin
  matters — caret-pin would silently float to the next patch upstream
  ships, possibly breaking anchors after a fresh install.
- `CLAUDE.md` (repo root) — `## Claude Installs` table version cell.

### 4. Uninstall the old patches

```bash
opencues uninstall claude-code
```

This restores `cli.js` from the tweakcc backup in
`~/claude-code-cues/.opencues/patch-state/`, then removes the
`~/claude-code-cues/.opencues/` dir entirely (tweakcc clone, statusline,
patch state). The pinned npm install of `@anthropic-ai/claude-code` stays
in place — we replace it in step 5.

**Important**: if uninstall complains about a missing backup, the patch
state has drifted. The safe recovery is `rm -rf ~/claude-code-cues` and
let the next install rebuild from scratch (cold install, ~3-4 min).

### 5. Reinstall

```bash
opencues install claude-code
```

The default (no `--keep-state`) is a destructive nuke + rebuild:

- `npm install @anthropic-ai/claude-code` reinstalls the pinned version
  (which is now the new one from step 3).
- tweakcc gets re-cloned into `<CC_FORK>/.opencues/tweakcc/`.
- `@opencues/{core,runtime}` are built and copied into
  `<CC_FORK>/node_modules/@opencues/`.
- `highlight-statusline.sh` lands at `<CC_FORK>/.opencues/`.
- tweakcc patches itself with OpenCues v2 wiring (every stock tweakcc
  patch is disabled).
- tweakcc applies the patch to the new `cli.js`.
- Both build-time and apply-time verification run. If any anchor fails,
  install exits non-zero with a pointer to `/tmp/opencues-install-cc.log`.

If patch application fails:

- **`__oc.failed` already present in cli.js**: idempotency check thinks
  the patch is already applied. Should be impossible right after step 4 —
  if you see this, the uninstall didn't restore properly. Try `rm -rf
  ~/claude-code-cues` and re-run.
- **Anchor not found**: an obfuscated identifier moved. Go back to step
  2, update the regex in `opencuesRuntime.ts`, retry. The patch is
  idempotent — re-running setup.sh won't double-apply.
- **`getRequireFuncName(oldFile)` returns undefined**: cli.js no longer
  uses `createRequire` in a recognizable pattern (rare, but happened
  in a CC refactor circa late 2025). Update that function in
  `opencuesRuntime.ts` to match the new shape.

### 6. Smoke check

```bash
claude-cues
```

Watch `/tmp/opencues.log` in a second shell for the boot line:

```
[HH:MM:SS][info] OpenCues runtime starting (Claude Code v2.1)
```

Then exercise the four checks from `integrations/claude-code/README.md`'s
Verify table:

| Test | What it checks |
|---|---|
| Type `volume _`, cycle Up | Cue-blank: auto-populates with system volume |
| Type `opencues settings _`, cycle Up | Selector/satellite blank |
| Type `weather _ paris` | LLM/HTTP cue-blank |
| Status bar shows tip when a word is highlighted | Statusline export → `highlight-statusline.sh` |

If a smoke check fails, the runtime writes diagnostics to
`/tmp/opencues.log`. The patch source itself never `console.log`s — CC
owns the TTY and any stdout write corrupts the TUI render. All patch
diagnostics go through the `log` function in `opencuesRuntime.ts` which
writes to `/tmp/opencues.log`.

### 7. Run the harness

The agentic harness (private repo `opencues/opencues-agentic`,
gitignored under `tests/agentic/`) is the truth-teller for non-eyeball-
visible regressions — state-machine drift, span invalidation, cycling
edge cases. Run it green before merging a pin bump.

### 8. Commit

One commit, scoped tight:

```
chore(claude-code): pin to 2.1.NNN
```

PR body links to the upstream release notes (if any) and calls out any
non-trivial findings from step 2's diff.

## Common upgrade gotchas

- **Bare `require()` in the bootstrap.** cli.js is ESM-converted; `require`
  isn't defined at module scope. The patch must use the `createRequire`-
  derived var that `getRequireFuncName(oldFile)` returns. If a CC version
  changes the var-naming pattern, this breaks. See `opencuesRuntime.ts`
  for the pattern.

- **`__oc.failed` marker drift.** Idempotency depends on a marker string
  unique to our injection. If you rename `__oc` or the seam exports, the
  re-run detection breaks and re-installs double-apply. Don't rename
  these without also updating every marker check.

- **tweakcc's stock patches.** Disabled in our build. Don't re-enable them
  to "get free features" — interactions with our statusline / theme /
  startup-banner patches have produced silent CC failures (no boot, no
  log, dead TUI).

- **Statusline path drift.** The statusline lives at
  `~/claude-code-cues/.opencues/highlight-statusline.sh` and CC reads it
  via an absolute path in `~/.claude/settings.json`. If you move the
  fork, settings.json points at a dead path. `opencues install
  claude-code` rewrites settings.json on every run; manual fork moves
  need a re-install.

## Same-patch vs same-minor vs cross-minor

- **Same-patch** (2.1.110 → 2.1.115): expect ~5 min. Anchors almost always
  clean; the minifier output is dominated by stable patterns within a
  patch line.
- **Same-minor** (2.1.110 → 2.1.200): expect 10-30 min. Anchors usually
  hold but verify in step 2.
- **Cross-minor** (2.1 → 2.2): expect hours. Plan on real regex porting
  in step 2, possible new adapter band under
  `packages/opencues-runtime/adapters/cc/v2.2/`, and re-baselining
  every shipped quirk in `cc/REPAIR.md`.

The current adapter band is `cc/v2.1/`. A cross-minor bump should create
`cc/v2.2/` side-by-side (copy v2.1 as a starting point) and update
`compat.json` so each band targets its own range.

## Reference

- `integrations/claude-code/CLAUDE.md` — patch architecture overview
- `integrations/claude-code/patches/opencuesRuntime.ts` — the patch source
- `packages/opencues-runtime/adapters/cc/REPAIR.md` — host quirk catalogue
- `/tmp/opencues-install-cc.log` — install-time log when setup.sh fails
