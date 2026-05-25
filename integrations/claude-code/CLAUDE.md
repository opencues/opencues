# CLAUDE.md — Claude Code integration

The Claude Code integration patches a pinned `@anthropic-ai/claude-code`
fork via [tweakcc](https://github.com/Piebald-AI/tweakcc) — a regex-
anchored patcher that injects our bootstrap into the minified `cli.js`.
Unlike Gemini (sources patched + rebuilt) or OpenCode (sources patched
+ Bun run), CC's source isn't in the npm tarball; we patch the
shipped bundle. That choice constrains everything below.

## Where things live

| File | Role |
|---|---|
| `compat.json` | Declared host compatibility ranges (which CC versions this band targets) |
| `bin/install.cjs` | Installer entry — orchestrates the nuke + rebuild from scratch |
| `patches/setup.sh` | One-command installer (clone CC, build runtime/core, install tweakcc, apply patch). Idempotent. `--keep-state` skips the nuke for dev iteration |
| `patches/opencuesRuntime.ts` | The patch source itself — emits a JS string that tweakcc injects into `cli.js`. Boots `@opencues/runtime` via the S1/S3/S6 seams |
| `patches/highlight-statusline.sh` | Status line script — reads `/tmp/opencues-status-*.json` and renders the inline tip |
| `tweakcc/` | The patched-into-place tweakcc install (gitignored — cloned during setup, lives at `<CC_FORK>/.cues/tweakcc/`) |
| `../../packages/opencues-runtime/adapters/cc/v2.1/boot.ts` | Adapter band — declares the host capabilities + boots the runtime with the bindings the patch supplies |
| `../../packages/opencues-runtime/adapters/cc/REPAIR.md` | Version-bump playbook |
| `docs/` | Integration-specific reference (cycling, alternatives, blank fill, status line, etc.) |

## The install flow

`opencues install claude-code` runs `bin/install.cjs`, which chains
two scripts:

1. **`opencues seed-configs --silent`** — owns all writes to `~/.cues/`
   (shared across every native host). First-time copy + library-script
   sync + 0-byte OPENCUES.md self-heal.
2. **`patches/setup.sh`** — strictly CC-specific. Default: nuke +
   rebuild. Pinned `@anthropic-ai/claude-code` reinstalled into
   `~/claude-code-cues/` + cloned tweakcc inside
   `<CC_FORK>/.cues/tweakcc/` + `@opencues/{core,runtime}` built
   and installed under `<CC_FORK>/node_modules/@opencues/` + statusline
   into `<CC_FORK>/.cues/` + tweakcc patched (only the OpenCues v2
   wiring; every stock tweakcc patch disabled) + verified at build AND
   apply time. ~1m 5s warm install.

**Compact footprint**: everything CC-specific lives inside
`~/claude-code-cues/`. Uninstall is `rm -rf ~/claude-code-cues` +
tweakcc revert. Your native `claude` install stays untouched.

## How patching works

Unlike Gemini (where we patch real source `.tsx` files then rebuild),
CC ships only the minified `cli.js`. The patch must therefore:

1. Locate injection points by regex against obfuscated identifiers
   (e.g. `getRequireFuncName(oldFile)` finds the `createRequire`-
   derived var name CC happens to be using this version).
2. Emit a JavaScript string that defines `globalThis.__oc` with our
   boot logic + the seams the runtime calls back through
   (`__oc.dispatchKey`, `__oc.notifyTextChange`, etc.).
3. Inject the string via tweakcc's anchor-based `src.replace(old, new, 1)`.

Each injection is idempotent — re-running setup.sh against an already-
patched fork is a no-op (we look for the `__oc.failed` /
`startOpenCues` markers).

## Patch development rules

> **Never use bare `require()` in the cli.js bootstrap.** cli.js is
> ESM-converted; `require` isn't defined at module scope. Use the
> `createRequire`-derived var that `getRequireFuncName(oldFile)`
> returns. See `opencuesRuntime.ts` for the pattern.

> **Don't `console.log()` from the patch.** CC owns the TTY; any
> stdout write corrupts the TUI's render. Use the patch's `log`
> function (which writes to `/tmp/opencues.log`) for everything.

## Iteration loop

After changes to `opencuesRuntime.ts` or `@opencues/runtime`:

```bash
integrations/claude-code/patches/setup.sh
# Then restart claude-cues
```

`--keep-state` skips the nuke (~39s vs the 1m 5s warm install) when
you're only iterating on patch sources.

## Debugging

- **`tail -f /tmp/opencues.log | grep '\[cc\]'`** — runtime logs
  (per-host prefix added 2026-05-19).
- **`opencues doctor`** — diagnoses install boundary issues.
- **`opencues which`** — shows the CC fork path + tweakcc state.
- **`/tmp/opencues-install-cc.log`** — install-time log if setup.sh
  failed.

## Known fixes baked into the adapter

See `../../packages/opencues-runtime/adapters/cc/REPAIR.md` for the
host-quirk catalogue:

1. `bindings.getText` / `getCursorOffset` are stale React closures —
   mitigated by the `lastSeenText` / `lastSeenCursor` pair in v2 boot.
2. tweakcc's stock patches are disabled — only the OpenCues v2 wiring
   runs (avoids interactions with statusline / theme patches we don't
   need).
3. ANSI rendering goes through `render-override` + `dim-ranges`
   directives — the host doesn't accept arbitrary terminal sequences.

## Version bumps

When `@anthropic-ai/claude-code` ships a new version:

1. Bump `compat.json` to declare the new range.
2. Run `setup.sh` against the new version — it'll fail at the apply
   step if a tweakcc anchor moved.
3. Fix the anchor in `patches/opencuesRuntime.ts` (search for the
   obfuscated identifier in the new `cli.js` and update the regex).
4. Add a "What broke" note to `REPAIR.md` with the fix.
