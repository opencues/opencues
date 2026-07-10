# Upgrading the Claude Code pin

Runbook for moving the Claude Code integration from one upstream version to
another. CC's distribution + patch surface have changed substantially across
the 2.1.x line and this guide reflects the current state.

## Are you a USER (your fork is behind) or a MAINTAINER (bumping the pin)?

**User — your fork is at an older version, you want to catch up to the
shipped `current-pin`:** one command.

```bash
git pull                           # gets the new compat.json from origin
opencues update claude-code        # rewrites your fork's package.json pin
                                   # + reinstalls + repatches
# Restart Claude Code (close, then re-launch claude-cues)
```

That's the whole upgrade. The command is idempotent — re-running when
already current prints `already at current-pin <ver> — nothing to do.`.

**Cross-shape note (one-time, 2.1.111 → 2.1.113+):** Anthropic switched
distribution shape from cli.js to a native bun-compile binary in 2.1.113.
`opencues update` handles the cutover transparently — npm install drops
the cli.js and writes the new `bin/claude.exe` into your fork's
node_modules; tweakcc detects the shape and applies the right patch path.
You don't need to do anything special. **However**, if you maintain a
shell alias like `alias claude-cues='node ~/claude-code-cues/…/cli.js'`
(the pre-2.1.113 shape), update it after upgrade — cli.js is gone:

```bash
alias claude-cues='~/claude-code-cues/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
```

**Maintainer — you're validating a new upstream version and want to ship
it as the default for everyone:** the runbook below ("The dance"). Probe
seams, update `compat.json` + `CLAUDE.md` + the `tested:` array, run the
agentic harness, commit.

---

## TL;DR — the two patch shapes

CC ships two different distribution shapes within the same minor line:

| Range | Shape | What ships in the npm tarball |
|---|---|---|
| **2.1.111 and earlier** | npm cli.js install | `package/cli.js` (the minified bundle) + vendor binaries |
| **2.1.113 and later** | native bun-compile binary | `package/cli-wrapper.cjs` + a thin `bin/claude.exe` stub, with the real binary in a platform-specific `@anthropic-ai/claude-code-<platform>` package |

(2.1.112 was unpublished; the cutover happened between 111 and 113.)

The OpenCues patch source (`integrations/claude-code/patches/opencuesRuntime.ts`)
works on **both** shapes. Tweakcc 4.0.13+ extracts cli.js from the bun-compile
binary's `.bun` ELF section, applies the same regex anchors, and repacks. The
text-level patch surface is identical; only the install pipeline differs.

The compat manifest at `integrations/claude-code/compat.json` is the source of
truth for what we've tested.

## The seam inventory (current as of 2.1.206)

The patch is **anchored on five seams** in cli.js. Same-patch and same-minor
bumps usually leave all five intact; cross-minor refactors can move any of
them. Read `seams.ts` (canonical source) + `opencuesRuntime.ts` (vendored copy
that ships into tweakcc) for the actual regexes.

| Seam | What it captures | Failure mode if it misses |
|---|---|---|
| **S1 KeyDispatcher** | `function WH(ZH,RH){switch(ZH.(?:key|name)){case"escape":…}` — CC's keypress handler. Pre-2.1.150 used `.key`; 2.1.150+ refactored to `.name`. The regex accepts either. | Install aborts. The runtime can't intercept keystrokes. |
| **S2 InputStateHandler** | `function O68({value:H,onChange:$,…})` — the custom hook that owns the input zone. Captures the bindings the runtime needs (onChange, onOffsetChange, inputZone class, columns var). | Install aborts. |
| **S3 RenderedValue** | `renderedValue:Q.render(…)` — the render call we wrap with `applyRender`. 2.1.150 shipped a 7-arg call with a `??`-expression; the regex catalogue includes a `RV_GENERIC` catch-all. | Install aborts. |
| **S6 StatusLineRefresh** *(optional)* | The React `useCallback` that debounces statusline refreshes. **Gone in 2.1.150** — Anthropic refactored it. Install logs a warning, statusline degrades to `statusLine.refreshInterval` polling. | Install proceeds; statusline lazy-refreshes instead of event-driven. |
| **S7 RenderKick** *(optional, new)* | `function J68({inputState:H,…})` — the InputZone parent component. The patch injects `var __ocS7=BV.useState(0)[1];globalThis.__oc_kickRender=…;` at the body start. Captured for **Gemini-style explicit React re-renders** without ZWS-toggling the buffer. | Install proceeds; `__oc_pushHostText` falls back to the ZWS-toggle path. Buffer accumulates invisible chars over time. |

S1 / S2 / S3 are **required** — any miss fails the install. S6 / S7 are
**optional** — the patch reports them in the install log and falls back to
older behavior.

## Prerequisites

- Clean worktree of the OpenCues repo. Don't do this on a branch with
  unrelated work-in-progress.
- The CC fork at `~/claude-code-cues/` (or `~/claude-code-cues-150/` for the
  native-binary install). If neither exists, the install will create it.
- tweakcc is cloned fresh into `<fork>/.cues/tweakcc/` on every from-scratch
  install and **checked out at `compat.json:tweakcc-pin`** — the upstream
  Piebald-AI/tweakcc commit validated against `current-pin`. 4.0.13+ is the
  hard floor for bun-binary repack. When validating a NEW CC version, first
  check upstream tweakcc main for a `Prompts for <new-version>` commit (they
  land one per CC release); that commit is your candidate for the new
  `tweakcc-pin`.

## The dance

### 1. Pick the target version

```bash
npm view @anthropic-ai/claude-code versions --json | tail -20
npm view @anthropic-ai/claude-code dist-tags
```

Check `compat.json`'s `tested:` array — versions there have been validated.

**Pre-cutover (2.1.111 and earlier)**: cli.js path. Stable, well-understood.

**Post-cutover (2.1.113+)**: native binary. Tweakcc handles extract/repack
transparently but the install pipeline differs (`opencues install
claude-code` needs to download the right native binary tarball).

### 2. Diff the patch surface against the current pin

Quick check that the five anchors are intact in a candidate version. For the
**npm cli.js shape** (2.1.111 and earlier):

```bash
npm pack @anthropic-ai/claude-code@<new-version> --pack-destination /tmp
tar xzf /tmp/anthropic-ai-claude-code-*.tgz -C /tmp/cc-new --strip-components=1
# Test S1+S2+S3 against the unpacked cli.js
node -e '
  const fs = require("fs");
  const src = fs.readFileSync("/tmp/cc-new/cli.js","utf8");
  const S1 = /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{switch\(\2\.(?:key|name)\)\{case"escape":/;
  const S2 = /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),/;
  const S3 = /renderedValue:([$\w]+)\.render\(/;
  const S7 = /function ([$\w]+)\(\{inputState:([$\w]+),/;
  for (const [n, r] of [["S1",S1],["S2",S2],["S3",S3],["S7",S7]]) {
    const m = src.match(r);
    console.log(n, m ? "HIT" : "MISS");
  }
'
```

For the **native binary shape** (2.1.113+):

```bash
npm pack @anthropic-ai/claude-code-linux-x64@<new-version> --pack-destination /tmp
tar xzf /tmp/anthropic-ai-claude-code-linux-x64-*.tgz -C /tmp/cc-bin --strip-components=1
# Tweakcc's nativeInstallation module extracts cli.js from the binary's
# .bun ELF section. Use its `unpack` subcommand to dump for inspection
# (the env-var path is optional — `unpack` accepts the binary as a
# positional too):
cd integrations/claude-code/tweakcc
node dist/index.mjs unpack /tmp/cc-bin-cli.js /tmp/cc-bin/claude
# Now grep for anchors against /tmp/cc-bin-cli.js the same way as above
```

Three outcomes:

- **All required (S1/S2/S3) hit.** Patches apply. Proceed to step 3.
- **One anchor misses.** Pinpoint by reading the new bundle around where the
  old anchor matched. Update the regex in `seams.ts` AND
  `opencuesRuntime.ts` (mirror copy). Add a unit test in
  `seams.test.ts` against the new shape.
- **S6 or S7 missing.** Optional — install proceeds, just logs a warning.
  Both fall back to older mechanisms (S6 → polling, S7 → ZWS-toggle).

### 3. Update the pin

Edits required:

- **`integrations/claude-code/compat.json`** — append the new version to
  `tested:` AND update `current-pin:` if you want it to become the default.
  Don't replace existing entries; the array is the historical record.
- **`integrations/claude-code/compat.json` → `tweakcc-pin:`** — bump to the
  upstream tweakcc commit you validated the new CC version against (normally
  the `Prompts for <new-version>` commit on tweakcc main). The CC pin and the
  tweakcc pin move TOGETHER — tweakcc carries per-CC-version prompt regexes
  and is the patch engine, so validating one against a stale other is not a
  validation. setup.sh checks the pin out after clone and fails loudly if the
  commit is gone.
- **`integrations/claude-code/README.md`** — `Compatible with` row in the
  header table.
- **`integrations/claude-code/patches/setup.sh`** — the version pin in the
  npm install command. **Exact pin matters** — caret would silently float
  to a version with different anchors.
- **`CLAUDE.md`** at repo root — `Claude Installs` table version cell.

### 4. Uninstall the old patches

```bash
opencues uninstall claude-code
```

This restores `cli.js` (or the native binary) from the tweakcc backup in
`<fork>/.cues/patch-state/`, then removes the `.cues/` dir (tweakcc clone,
statusline, patch state). The pinned npm install of
`@anthropic-ai/claude-code` stays in place — step 5 replaces it.

If uninstall complains about a missing backup, the patch state has drifted.
The safe recovery is `rm -rf ~/claude-code-cues` (or
`~/claude-code-cues-150`) and let step 5 rebuild from scratch.

### 5. Reinstall

```bash
opencues install claude-code
```

Default behavior is nuke + rebuild:

- `npm install @anthropic-ai/claude-code@<pinned>` (pre-cutover) **OR**
- Download `@anthropic-ai/claude-code-<platform>` (post-cutover, native binary)
- `git clone Piebald-AI/tweakcc` (pinned at 4.0.13+) into `<fork>/.cues/tweakcc/`
- Build + install `@opencues/{core,runtime}` into `<fork>/node_modules/@opencues/`
- Install `statusline.sh` to `<fork>/.cues/statusline.sh`
- Patch tweakcc to wire OpenCues v2 + disable every stock patch
- Apply tweakcc to the cli.js (or native binary)
- Verify the boot landed (greps the patched output for our markers)

Use `--keep-state` for dev iteration on patch sources (skips the nuke, ~39s
warm vs ~1m5s full).

If patch application fails:

- **Anchor missing**: re-do step 2, update regex, retry.
- **`__oc.failed` already in cli.js**: idempotency check thinks the patch is
  already applied. Should be impossible after a clean uninstall — if you see
  this, the restore-from-backup didn't actually restore. `rm -rf` and retry.
- **Native binary repack error** (post-cutover only): usually a tweakcc
  version mismatch. Upgrade tweakcc to upstream 4.0.13+ — PR #730 ("Fix
  native binary patching on Linux") is required for the modern .bun section
  layout.

### 6. Smoke check

```bash
~/claude-code-cues-150/node_modules/@anthropic-ai/claude-code/bin/claude.exe
# OR for pre-cutover: claude-cues
```

In a second shell:

```bash
tail -f /tmp/opencues.log | grep '\[cc\]'
```

Expect the boot line on first keystroke:

```
[HH:MM:SS][cc][info] OpenCues runtime starting (Claude Code v2.1)
[HH:MM:SS][cc][info] ConfigLoader: IDENTITY.md → N fields
[HH:MM:SS][cc][info] Resolver: built with 5 sources [...]
```

Then exercise the four checks from `integrations/claude-code/README.md`'s
Verify table.

### 7. Run the harness

The agentic harness (private repo, gitignored under `tests/agentic/`) is the
truth-teller for non-eyeball regressions. CC has a pty-based launcher
(`tests/agentic/oc-launch-cc-pty`, see `tests/agentic/CC-PTY.md`) because
CC's runtime boots lazily on first keystroke — the default `oc-launch-headless`
closes stdin and never primes the boot.

```bash
PID=$(tests/agentic/oc-launch-headless claude-code)
# oc-launch-headless detects claude-code and delegates to oc-launch-cc-pty
for f in tests/agentic/scenarios/{01..13}-*.json; do
  npx tsx tests/agentic/scenario-runner.ts --pid $PID --scenario $f
done
kill $PID
```

All ten reference scenarios should pass. If they don't, the regression is in
either:

- The patch source (`opencuesRuntime.ts`) — re-read each seam injection
- The CC adapter band (`packages/opencues-runtime/adapters/cc/v2.1/boot.ts`)
- The runtime — but unit tests catch this before the harness does

### 8. Commit

Scoped tight, one commit per logical change. For a clean pin bump:

```
feat(cc): pin to 2.1.NNN — <one-line reason>
```

PR body links to upstream release notes and calls out any seam-regex edits
from step 2.

## State file paths (canonical scheme)

All hosts (OC / CC / Gemini / Terminal) write the same per-PID files:

| File | Contents | Writer |
|---|---|---|
| `/tmp/opencues-bridge-<host>.pid` (or override via `OPENCUES_BRIDGE_PID_FILE`) | Active CC pid for harness | Event bridge on arm |
| `/tmp/opencues-status-<pid>.json` | Highlight state, alts, tip, agent task | Statusline module |
| `/tmp/opencues-cursor-state-<pid>.json` | Buffer text + cursor offset | CursorStateExport module |
| `/tmp/opencues-events-<pid>.jsonl` | Structured event stream | Event bridge |
| `/tmp/opencues-bridge-dump-<pid>.json` | Full dump on `dump` inject | Event bridge |
| `/tmp/opencues.log` | Debug log (info/warn/error/debug) | Every host |

**Legacy paths (retired May 2026):**

- `/tmp/opencues-highlight-state-<pid>.json` → use `/tmp/opencues-status-<pid>.json`
- `/tmp/opencues-cursor-state.json` (no pid suffix) → use `/tmp/opencues-cursor-state-<pid>.json`

If you're upgrading from a pre-May-2026 install and your downstream scripts
read the legacy paths, update them.

## Patch architecture quirks (read before touching patch source)

### Bare `require()` in cli.js — use `__oc_req`

cli.js is ESM-converted; bare `require` isn't defined at module scope. The
patch uses the `createRequire`-derived var that `getRequireFuncName(oldFile)`
returns. For native binary installs, the runtime lives outside the bun-vfs,
so even resolved-bare-specifiers fail. `__oc_req(spec)` tries bare first then
walks up from `process.execPath` looking for `node_modules/<spec>`. Use it for
every `@opencues/*` require in the bootstrap.

### `WH`'s return value is discarded on 2.1.150

2.1.150's `J68` (InputZone parent) calls `Y(R)` (= the patched `WH`) and
discards the return. The old `consumePendingRender → return new InputZone`
idiom doesn't propagate text changes any more. The patch + boot rely on
`host.pushText` (= the captured `onChange` prop) for buffer updates and
`host.forceRender` (= S7 kickRender if available) for pure re-renders.

If you re-introduce a "WH returns IZ → text propagates" assumption, the alt
swap and `expect path:active` scenario assertions both regress. Run the
harness suite before merging.

### `__oc_pushHostText` does NOT use ZWS toggle on S7-equipped builds

Pre-May-2026: every push appended ZWS/ZWNJ to defeat React's string-equality
bail-out. Side effect — the buffer accumulated invisible chars over time,
which broke the TransformBlank three-way-merge.

Post-S7: the patch detects `globalThis.__oc_kickRender` (set by the S7
injection) and just calls `$(text)` raw, then kicks. No ZWS pollution.
Falls back to ZWS-toggle only when S7 missed (older CC versions / regex
drift).

If you remove the kickRender check from `__oc_pushHostText`, you re-pollute
the buffer + reintroduce the merge bug. Don't.

### `console.log` corrupts the TUI

CC owns the TTY. Any `console.log` from patch code writes to the same stdout
Ink uses to compose the screen, corrupting the render. All patch-emitted
diagnostics go through the `log` callback in `opencuesRuntime.ts` which
writes to `/tmp/opencues.log` via `fs.appendFileSync`.

### tweakcc's stock patches are disabled

`setup.sh` injects a `condition = false` on every stock patch in tweakcc's
orchestrator. We use tweakcc as a **patcher tool**, not a feature suite.
Don't re-enable stock patches "to get free features" — interactions with
our statusline / theme patches have produced dead-boot TUIs.

## Common upgrade gotchas

- **Statusline path drift**: `~/.claude/settings.json`'s `statusLine.command`
  is an absolute path baked at install time. If the fork moves, settings.json
  points at a dead path. `opencues install claude-code` rewrites it on every
  run; manual fork moves need a re-install.

- **tweakcc requires its own update for some CC versions**: if a tweakcc
  internal anchor (not ours) misses on a new CC release, the build itself
  fails before our patches apply. Validate against a newer upstream commit
  (usually the `Prompts for <new-version>` one) and bump
  `compat.json:tweakcc-pin` in the same PR as the CC pin.

- **The patched binary can die at PARSE time with all five seams green**:
  tweakcc's system-prompt writeback (`applySystemPrompts`) runs
  unconditionally and re-embeds every extracted prompt; its backtick
  re-escaper corrupts prompts containing nested templates inside `${...}`
  interpolations (first hit on 2.1.206's memory prompt — symptom:
  `SyntaxError ... Expected ':' in ternary operator` on any launch,
  including `--version`). setup.sh § 4e now skips the writeback entirely
  (empty `patchFilter`). If a future tweakcc refactor moves that callsite,
  § 4e's anchor regex fails loudly at install. Post-mortem:
  `adapters/cc/REPAIR.md` § 15.

- **S6 isn't critical, S7 isn't critical, S1/S2/S3 are**: don't waste
  half a day porting an S6 regex. The Statusline module falls back to
  `statusLine.refreshInterval` polling. The S7 fallback (ZWS-toggle) still
  works, just dirtier.

- **2.1.110 → 2.1.150 was a major redesign for us** (May 2026): native binary
  cutover + WH-return-discarded + S6 loss + S7 introduction + canonical
  state-file paths + ZWS pollution fix + TransformBlank merge fix. If you're
  upgrading across that boundary, expect to also need:
  - tweakcc 4.0.13+ (PR #730 for bun-binary repack)
  - The `__oc_req` execPath fallback in the bootstrap
  - boot.ts's eager-setText + sync-renderHandlers
  - The Statusline hlState.onChange subscription
  - All four state-file paths updated downstream

## Same-patch vs same-minor vs cross-minor

| Bump shape | Effort | Risk |
|---|---|---|
| **Same-patch** (`2.1.150 → 2.1.151`) | ~5 min | Anchors almost always intact within a patch line |
| **Same-minor** (`2.1.150 → 2.1.180`) | 15-45 min | Verify each seam in step 2; S6 may move again |
| **Cross-minor** (`2.1 → 2.2`) | Hours-day | Plan on real regex porting. Might need a new adapter band under `packages/opencues-runtime/adapters/cc/v2.2/` |

A cross-minor bump should add `cc/v2.2/` side-by-side (copy v2.1 as a
starting point), update `compat.json`'s `compat-range`, and rebaseline every
shipped quirk in `cc/REPAIR.md`.

## Reference

- `integrations/claude-code/CLAUDE.md` — patch architecture overview
- `integrations/claude-code/patches/opencuesRuntime.ts` — the patch source
- `packages/opencues-runtime/adapters/cc/v2.1/seams.ts` — canonical seam regexes
- `packages/opencues-runtime/adapters/cc/v2.1/boot.ts` — adapter (eager setText, S7 wiring)
- `packages/opencues-runtime/adapters/cc/REPAIR.md` — host quirk catalogue
- `packages/opencues-runtime/src/event-bridge.ts` — agentic harness runtime
- `tests/agentic/CC-PTY.md` — CC-specific pty launcher (private)
- `/tmp/opencues-install-cc.log` — install-time log when setup.sh fails
