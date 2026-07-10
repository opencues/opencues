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
| `docs/` | CC-specific reference: cue-blanks + WSL guide, status-line setup, CLI prompting tips. Host-agnostic feature concepts (navigation, cycling, blanks, etc.) live at `docs/features/` now — see root `docs/features/README.md`. |

## The install flow

`opencues install claude-code` runs `bin/install.cjs`, which chains
two scripts:

1. **`opencues seed-configs --silent`** — owns all writes to `~/.cues/`
   (shared across every native host). First-time copy + library-script
   sync + 0-byte OPENCUES.md self-heal.
2. **`patches/setup.sh`** — strictly CC-specific. Default: nuke +
   rebuild. Pinned `@anthropic-ai/claude-code` reinstalled into
   `~/claude-code-cues/` + tweakcc cloned AND checked out at the exact
   commit in `compat.json:tweakcc-pin` inside `<CC_FORK>/.cues/tweakcc/`
   (never unpinned — issue #276) + `@opencues/{core,runtime}` built
   and installed under `<CC_FORK>/node_modules/@opencues/` + statusline
   into `<CC_FORK>/.cues/` + tweakcc patched (only the OpenCues v2
   wiring; every stock tweakcc patch disabled AND the separate
   system-prompt pipeline disabled, § 4e) + verified at build, apply,
   AND runtime (fatal `node --check` on the cli.js shape + `--version`
   execution smoke on the patched artifact, both shapes). ~1m 5s warm
   install.

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

After changes to `opencuesRuntime.ts` or `@opencues/runtime`, run **one
command**:

```bash
opencues install claude-code
```

It auto-detects every `~/claude-code-cues*` dir with a real CC binary
and patches each in sequence. Canonical first, then dev forks
(`-150`, `-158`, `-170`, …) in name order. Healthy + fresh forks skip;
stale ones rebuild. ~1m 5s per fork warm.

**Why the fan-out exists** (June 2026, PR following #117): PR #117
bumped `@opencues/{runtime,core}`. The release pass rebuilt the
canonical fork; the `-170` dev fork was forgotten. Direct launches of
`~/claude-code-cues-170/.../claude.exe` ran the stale 0.3.0 bundle for
hours, dropping every cue + blank silently. No warning, no test
coverage (unit tests run source, not bundles), no doctor row. The
install path now treats every CC fork on disk as a real install
target — "I ran the installer once, every fork is fresh" is now
structurally true.

Direct setup.sh still works for single-fork iteration:

```bash
# Single fork, explicit target (CI, one-off binaries outside ~/claude-code-cues*).
OPENCUES_CC_TARGET=~/claude-code-cues-170/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  integrations/claude-code/patches/setup.sh
```

`opencues install claude-code --canonical-only` skips the fan-out
without pinning a target — useful when you're certain only the
canonical fork matters.

`--keep-state` skips the nuke (~39s vs 1m 5s warm) when you're only
iterating on patch sources.

**Boot-time advisory** (June 2026): every CC launch also runs
`checkRuntimeDrift` from the runtime side. If a user launches a fork
directly (bypassing `opencues run` self-heal AND the install fan-out),
the runtime detects bundled-version drift on boot and writes a `warn`
line to `/tmp/opencues.log` naming the fork + fix command. Closes the
"silently broken stale fork" gap that the May/June 2026 dual-fork bugs
both hit.

> Why this matters: each fork has its own bundled `node_modules/@opencues/{core,runtime}`
> copy. A fix to `packages/opencues-runtime/src/modules/resolver.ts` lands in
> source only — `setup.sh` is what re-builds + copies the bundle into each
> fork. Skip a fork and that fork keeps running the pre-fix bundle, while the
> source tree and the other fork show the fix. Silent runtime drift, no test
> coverage (the tests run against source, not the bundled copies). This bit
> us in May 2026 with the `_`-tip resolver guard — see root CLAUDE.md §
> Claude Installs for the post-mortem.

### setup.sh shape detection

`setup.sh` auto-detects which artifact to feed tweakcc by checking, in
order:

1. `$CC_FORK_DIR/node_modules/@anthropic-ai/claude-code/cli.js` — the
   pre-2.1.113 minified JS bundle. If present, `CC_SHAPE=cli.js` and
   tweakcc patches it directly.
2. `$CC_FORK_DIR/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
   — the 2.1.113+ bun-compile ELF binary. If present (and #1 isn't),
   `CC_SHAPE=native-binary`; tweakcc 4.0.13+ extracts cli.js from the
   `.bun` ELF section, applies the patches, and repacks. The post-patch
   cli.js is also written to `$TWEAKCC_CONFIG_DIR/native-claudejs-patched.js`
   — that's what the verification step greps (the binary itself isn't
   ASCII-greppable because the section is compressed).

The verification step skips `node --check` on native-binary shapes.
Don't add JS-only validations after the apply step without gating them
on `[ "$CC_SHAPE" = "cli.js" ]` — and don't be tempted to `node --check`
the native post-patch **extract** either: the embedded JS runs under Bun
and legitimately uses syntax Node's parser rejects (CC 2.1.170's `using`
declarations fail node 22 `--check` on a PRISTINE extract). The native
shape is verified by the § 9 runtime smoke instead: the patched binary
itself is executed with `--version` and the install hard-fails if it
doesn't run (issue #276 — a corrupted repack used to ship as "Done.").
`bin/install.cjs:validateFork` mirrors both probes, so a corrupted
artifact can neither install NOR skip as "already installed + healthy"
later. `scripts/check-tweakcc-pin.sh` (pre-pr + CI) pins all of this
in place.

> **Failure mode this gate prevents:** running setup.sh against the 150
> fork used to abort at step 2 with "cli.js still missing" — the script
> was hard-coded to the cli.js path. The abort happened AFTER the nuke,
> leaving `node_modules/@opencues/` empty and the user with a broken
> install. Now the script picks the right shape before npm install runs
> and never reaches that error path for legitimate native-binary forks.

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
4. macOS Terminal.app Ctrl+Option+arrow is normalised at **stdin**, not at
   the event layer. Terminal.app sends the double-ESC `\x1b\x1b[A`, which
   Ink splits into `escape` + a plain arrow before `dispatchKey` sees it —
   so the event-level synth (`shouldSynthesizeMacDoubleEscCtrl`) can't fire.
   `boot()` calls `installMacDoubleEscStdinRewrite(process.stdin)` to rewrite
   `\x1b\x1b[A`→`\x1b[1;7A` (Ghostty's modifier-CSI) before Ink's parser
   reads it. **No Ink fork, no cli.js patch; darwin-only (strict no-op on
   Windows/Linux).** Full rationale: REPAIR.md §14.

### ZWS render-kick — invariant: never escape the adapter

CC's React string-equality check bails on `forceRender()` when the
new buffer string is `===` the old one — common after a transform
substitute that produced byte-identical output, or a spinner frame
that paints the same char. To defeat that, `__oc_pushHostText` (the
patch in `opencuesRuntime.ts`) toggles a `\u200B` / `\u200C` (ZWS /
ZWNJ) marker on every push so the string is always non-equal and
React commits.

That's a **CC-only render-kick artifact** — no other host adds these
chars; the only reason any other host sees them is if our adapter
leaks them out. **Rule: ZWS must be stripped at every boundary where
the buffer crosses into a runtime module.** Today's boundaries:

| Boundary | Stripped where |
|---|---|
| `TextChangeEvent.text` (BlankFill, Navigation, AgentRewrite consume this) | `checkTextDrift` calls `visible(text)` before storing/emitting |
| `adapter.getText()` (returns `lastSeenText`) | Same — `lastSeenText` is always the stripped copy |
| `RenderContext.text` (DimRender, SentenceCue, statusline consume this) | `applyRender` runs `visible(visibleText)` before building the ctx |

The render-side strip was the **third** boundary and was missed until
May 2026 — symptom was multi-word blank-fill spans losing their dim
the moment the user typed any character after the substitute, because
`splitWords(ctx.text)` was emitting a stray ZWS-word and the multi-
word dim end-word lookup walked off by one.

**If you add a new path that surfaces buffer text to a runtime
module, route it through `visible()` first.** Easiest diagnostic
when you suspect a ZWS leak: `grep "ctxLen\|zwsStripped" /tmp/opencues.log`
— the post-May-2026 `applyRender` log includes `zwsStripped: N` so
non-zero values directly point at the render-kick traffic.

## Version bumps

When `@anthropic-ai/claude-code` ships a new version:

1. Bump `compat.json` to declare the new range.
2. Run `setup.sh` against the new version — it'll fail at the apply
   step if a tweakcc anchor moved.
3. Fix the anchor in `patches/opencuesRuntime.ts` (search for the
   obfuscated identifier in the new `cli.js` and update the regex).
4. Add a "What broke" note to `REPAIR.md` with the fix.
