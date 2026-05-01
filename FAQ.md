# FAQ

Common questions about installing, running, and uninstalling OpenCues.
For conceptual docs see [README.md](README.md) and [docs/](docs/); for
per-integration detail see `integrations/<host>/README.md`.

---

## Install

### Is install really one command per integration?

Yes. From a fresh OpenCues clone:

```bash
pnpm install
opencues install <host>   # claude-code | opencode | chrome | codex | --all
```

That covers everything the host needs. Specifically:

| Host | What the installer does |
|---|---|
| `claude-code` | `opencues seed-configs` (shared `~/.opencues/`) → nuke prior CC state + reinstall pinned `@anthropic-ai/claude-code@2.1.110` → clone tweakcc into `<CC_FORK>/.opencues/tweakcc/` → patch tweakcc (every stock patch disabled, only OpenCues v2 wiring) → build `@opencues/{core,runtime}` into `<CC_FORK>/node_modules/@opencues/` → install statusline.sh into `<CC_FORK>/.opencues/` → apply tweakcc to cli.js + verify v2 boot landed. ~1m warm. tweakcc is just our patcher tool. |
| `opencode` | Clone `sst/opencode` fork → `bun install` the fork's deps → build `@opencues/{core,runtime}` → install into `<fork>/node_modules/@opencues/` → patch 3 TSX files in place |
| `chrome` | Build MV3 extension → copy `dist/` to `--target` if provided |
| `codex` | **Pre-alpha** — clone fork + build Rust bridge. TUI patches TODO; see [`integrations/codex/HANDOFF.md`](integrations/codex/HANDOFF.md) |

After install, launch with `opencues run <host>` (except Chrome, which you load manually in `chrome://extensions`).

### What do I need installed first?

Universal: Node.js 18+, [pnpm](https://pnpm.io), a Groq API key (or any OpenAI-compatible provider).

Per-integration (the HOST's requirements, not OpenCues's):

| Host | Extra |
|---|---|
| `claude-code` | Claude Code CLI on PATH |
| `opencode` | [bun](https://bun.sh) (OpenCode itself is a bun app) |
| `codex` | [Rust toolchain](https://rustup.rs/) |
| `chrome` | Chrome 121+ |

A claude-code-only user never needs bun or Rust. See `README.md § Requirements` for the full table.

### Can I use `opencues` directly instead of `pnpm exec opencues`?

Yes, once the binary is on PATH. Options:

- **From a clone** (today): `pnpm exec opencues <cmd>` always works. Add a shim if you want the short form:
  ```sh
  ln -s "$(realpath node_modules/.bin/opencues)" ~/.local/bin/opencues
  ```
  (Actually: pnpm's shim breaks through symlinks — use a wrapper script at `~/.local/bin/opencues` that `exec`s the real binary by absolute path.)
- **Post-publish (Stage 8)**: `npx @opencues/<host> install` will be the user-facing entry point; no clone required.

Installer hints automatically print whichever form works in your shell.

### Does `opencues init` scaffold `opencues.md`?

**No.** `opencues.md` holds system-wide settings (voice-mode, tips-mode, debug-mode, cursor-navigate) whose schema is defined by the OpenCues runtime — not by users or projects. One value applies across every integration. It's runtime-owned:

- Lives at user-level only: `~/.opencues/opencues.md`
- Seeded from `defaults/opencues.md` by `opencues seed-configs` (and re-seeded automatically if the file is 0-bytes — the `OpenCuesSettingsBlank` silently no-ops on empty content, so a 0-byte file would silently break `opencues ___` / `config ___` blank-fills)
- `setup.sh` self-heals an empty `opencues.md` on every install (section 7a-bis)
- `opencues init` scaffolds only `cues.md`, `blanks.md`, `README.md` in a project

### Can I have project-level `opencues.md`?

No — it's intentionally user-level only. A project-level override would violate the "one value across every integration" invariant. `cues.md`, `blanks.md` can all be project-level overrides; `opencues.md` cannot.

### The install output is too verbose / too quiet — can I change it?

Default is compact:
```
  ▸ Cloning sst/opencode (~250MB) ✓
  ▸ Installing fork dependencies (bun install) ✓
  ▸ Building @opencues/{runtime,core} ✓
  ▸ Installing runtime + core into fork ✓
  ▸ Patching fork (3 files + bootstrap) ✓
```

Set `OPENCUES_INSTALL_VERBOSE=1` to stream every command's output live. The quiet-mode log is always saved to `/tmp/opencues-install-<host>.log` (so if a step fails, you get the last 30 lines + a log-path pointer).

---

## Uninstall

### Is uninstall really one command?

Yes: `opencues uninstall <host>` (or `--all`). Each integration reverts its patches + removes its install dir:

| Host | What uninstall does |
|---|---|
| `claude-code` | Revert `cli.js` from backup → `rm -rf ~/claude-code-cues/.opencues/` |
| `opencode` | `git checkout --` on 3 patched TSX files → remove `<fork>/node_modules/@opencues/` → remove bootstrap |
| `chrome` | Remove the Chrome extension's `dist/` in the repo; remove the `--target` deploy if one was used |
| `codex` | Revert patches → remove bridge crate |

### What does uninstall NOT remove?

By design:
- **User configs** (`~/.opencues/`) — your cues/blanks survive so re-install doesn't lose settings
- **The OpenCues clone** (`~/opencues/`) — that's your repo, not an installer artefact
- **Cloned forks** (`~/opencode-cues/`, `~/codex-cues/`) — those are your host checkouts, not OpenCues's to manage
- **`claude-code-cues`** (your optional local Claude Code install) — same reasoning

### How do I fully remove OpenCues from my machine?

See `README.md § Removing § Fully removing OpenCues`. Four steps:

```bash
opencues uninstall --all
rm -rf ~/.opencues          # user configs
rm -rf ~/opencues           # the repo
rm -rf ~/opencode-cues ~/codex-cues ~/claude-code-cues    # cloned forks (only what you have)
```

### Uninstall failed partway — what now?

The main failure mode is OpenCode's uninstall refusing to `git checkout` a dirty working tree (you edited one of the three patched files). Stash/commit your changes and re-run. CC and Chrome are idempotent — safe to re-run.

---

## Where things live

### Where does each host store its install state?

| Path | Owner | Purpose |
|---|---|---|
| `~/claude-code-cues/.opencues/` | `@opencues/claude-code` | Everything CC needs — `core/`, `runtime/`, `scripts/`, `patch-state/`, `tips.json`, `statusline.sh`. Uninstall = `rm -rf` this dir + revert `cli.js`. |
| `~/claude-code-cues/` | Your local Claude Code install (optional) | Where the `claude-cues` alias points. The auto-detect in `opencues install claude-code` looks here and at the standard native install path. |
| `~/opencode-cues/` | OpenCode fork (cloned on install) | Patched fork; `~/opencode-cues/node_modules/@opencues/` contains our built libs; three TSX files are patched in place. |
| `~/codex-cues/` | Codex fork (cloned on install) | Similar to opencode-cues. Pre-alpha. |
| `~/.opencues/` | You (user configs) | Your cues/blanks + user-level `opencues.md`. Shared by every host. |
| `<cwd>/.opencues/` | Your project | Project-level overrides for cues/blanks. |
| `/tmp/opencues.log` | Runtime | Debug log from whichever host is actively running. |
| `/tmp/opencues-install-<host>.log` | Installer | Most recent install output (kept on success too for re-inspection). |
| `/tmp/opencues-cursor-state.json`, `/tmp/opencues-highlight-state-<pid>.json` | Runtime | Host-agnostic IPC files; created while a patched host runs. |

For a live view: `opencues which` prints every path with ✓ / − markers showing what actually exists.

### Why isn't `~/.opencues/` the one install dir for everything?

Two reasons:

1. **Host integrations need to touch host-specific spots** — CC patches a `cli.js` sitting under `~/.claude/` or wherever Claude Code was installed; OpenCode patches TSX files inside a fork directory; Chrome builds into the repo's own `integrations/chrome/dist/`. None of those are "user config" — they're patched-host artefacts.
2. **`~/.opencues/` is purely config**. Cues, blanks, and settings you edit. Conceptually separate from compiled runtime and patched binaries.

### Where are the OpenCode bits specifically?

See `integrations/opencode/README.md § Where things live`:

- `~/opencode-cues/node_modules/@opencues/core/` — built `@opencues/core`
- `~/opencode-cues/node_modules/@opencues/runtime/` — built `@opencues/runtime`
- `~/opencode-cues/packages/opencode/src/cli/cmd/tui/opencues.ts` — bootstrap
- `app.tsx`, `component/prompt/index.tsx`, `feature-plugins/home/footer.tsx` — patched in place (revertable via `git checkout`)

---

## Running / using

### Why does `opencues run opencode` say "Done. Launch with: pnpm exec opencues run opencode" vs just "opencues run opencode"?

The installer probes whether `opencues` is on PATH and picks the form that works in your shell. If you see the `pnpm exec` form, add a shim (see above) or use it as-is — both work from inside the OpenCues clone.

### Where do I see runtime logs?

`/tmp/opencues.log`. Tail it with:

```bash
opencues logs --tail
```

### How do I toggle debug mode?

```bash
opencues debug on    # or: off
```

That rewrites `~/.opencues/opencues.md`'s `debug-mode:` scalar. Hot-reload picks it up within ~2s on the next keystroke.

### Something's broken — what do I run first?

```bash
opencues doctor
```

Cross-host diagnostics with suggested fixes. Then `opencues which` for the live path layout, then `opencues logs --tail` for the runtime log.

---

## Configuration

### What's the difference between `~/.opencues/cues.md` and `<cwd>/.opencues/cues.md`?

User-level (`~/.opencues/`) is your global default — applies everywhere. Project-level (`<cwd>/.opencues/`) applies only when you run a host from inside that project. Project wins on name conflicts (cue source name, blank mode name, blank name).

The load precedence is `$OPENCUES_HOME` → project → user, in that order.

### Can I edit `opencues.md` by hand?

You can edit the *scalar values* (`voice-mode: active ↔ inactive`, etc.) if you prefer — they hot-reload. The *settings block* shape (the nested `settings:` with `tip:` and `values:` entries) is runtime-defined; the runtime will overwrite additions during settings writes.

### How do I scaffold a new cue / blank?

```bash
opencues new cue my-synonyms            # → ~/.opencues/cues/my-synonyms/cue.md
opencues new blank my-answer --project   # → ./.opencues/blanks/my-answer/cue.md
```

The scaffolded `cue.md` is a thorough schema reference — every frontmatter field documented with examples. Validate after editing:

```bash
opencues validate --project
```

---

## Troubleshooting

### `opencues install opencode` exits with setup.sh non-zero

The installer's quiet mode shows the last 30 lines of `/tmp/opencues-install-oc.log` on failure + a log path. Common causes:

- **bun not on PATH** — the installer pre-flights this; install bun from https://bun.sh/
- **pnpm not on PATH** — same, install pnpm from https://pnpm.io
- **Fork path points at a non-opencode dir** — pass `--target /path/to/real/opencode/checkout` or delete `~/opencode-cues/` and re-run

Re-run with `OPENCUES_INSTALL_VERBOSE=1` to stream live.

### `opencues run opencode` says "preload not found @opentui/solid/preload"

Means the fork's `bun install` hasn't run. If you upgraded from an older install (pre-Apr 2026), re-run `opencues install opencode` — the current installer includes a `bun install` step inside the fork that was missing previously.

### `opencues run opencode` silently exits 0 with no output

Shouldn't happen anymore — the runtime detects spawn failures and reports exit 127 with a reason (missing bun, binary unfindable, etc.). If you're still seeing silent exits, you're likely on a stale checkout; `git pull && pnpm install`.
