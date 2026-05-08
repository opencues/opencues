---
last_updated: 2026-04-22
---

# CLI Reference — `opencues`

The `opencues` command is the front door for everything: installing
host integrations, scaffolding cues, validating configs, inspecting
state, day-to-day operations. One CLI normalizes "install / update
/ debug" across three hosts (CC, OpenCode, Chrome), each with
very different install models underneath.

For the high-level mental model see `damon.md` § "The `opencues` CLI";
this page is the per-subcommand reference.

```
$ opencues --help
```

prints the canonical command list. Every subcommand also takes
`--help` for its own usage detail. Bash/zsh/fish completion is
available via `opencues completion <shell>`.

---

## Setup

### `install <host>` — install a host integration

Runs the integration's installer end-to-end: builds `@opencues/core`
+ `@opencues/runtime`, applies host-specific patches/builds, and
deploys to the right path.

```bash
opencues install claude-code         # patch the local Claude Code install
opencues install opencode            # patch the OpenCode fork at ~/opencode-cues
opencues install chrome              # build the MV3 extension into integrations/chrome/dist/
opencues install chrome --wsl        # also mirror to the Windows desktop install dir
opencues install --all               # install every detected host
```

Forwards extra args to the underlying installer after `--`:

```bash
opencues install claude-code -- --target /custom/path/cli.js
```

Each integration's installer lives at `integrations/<host>/bin/install.cjs`.

### `uninstall <host>` — roll back an installation

Reverts the patches/copies the installer applied. CC restores
`cli.js.backup`. OC restores the fork to its pristine state.
Chrome removes the bundle output dir. Forwards extra args after `--`.

```bash
opencues uninstall claude-code
opencues uninstall --all
```

### `seed-configs` — manage `~/.cues/`

Owns all writes to the user-level `~/.cues/` tree. Idempotent + safe to
re-run. Invoked automatically (with `--silent`) by every `opencues install <host>`,
and runnable standalone whenever you suspect drift.

Four phases on every invocation:

1. **SEED** — first-time copy of `defaults/cues.md + cues/ + blanks/ + scripts/` → `~/.cues/`. Skips files that already exist with content (preserves user edits).
2. **SYNC** — overwrites stale library files (`.sh` / `.cs` / `.ps1` from `defaults/{blanks,scripts}/`) every install. Never overwrites `.md` (user content). Catches drift when path-resolution logic changes between repo versions.
3. **HEAL** — re-seeds a 0-byte `~/.cues/cues.md`. The runtime's `OpenCuesSettingsBlank` silently no-ops on empty content, so a 0-byte file would silently break `opencues ___` / `config ___` blank-fills on every native host (CC + OC). Chrome unaffected — uses bake-time fallback.
4. **COMPILE** (WSL only) — compiles colocated `.cs` → `.exe` next to the script that uses them (`BrightCtl.exe` next to `brightness.sh`, `VolCtl.exe` next to `volume.sh`, `SpeakCtl.exe` next to `speak.sh`). Idempotent — only compiles when `.exe` is older than `.cs`.

| Flag | Effect |
|---|---|
| (none) | User-level. Runs all four phases. |
| `--project` | Writes into `<cwd>/.cues/` instead (only the SEED phase — sync/heal/compile are user-level only). Skips `cues.md` (its frontmatter is runtime-owned; no project-level overrides for system settings). |
| `--silent` | Suppress non-error output (used when chained from `opencues install`). |
| `--dry-run` | Print the plan; do not copy / compile anything. |

See [Config Search Paths](../features/config-search-paths.md) for where the configs are loaded from at runtime.

### `update` — pull, rebuild, redeploy

Runs `git pull`, then re-runs the installers for every detected
integration. The "I don't want to think about it" command after
fresh-cloning or pulling new commits.

```bash
opencues update
```

### `set-key <provider> <key>` — store an API key

Writes the key into `~/.cues/.env` so you don't have to put it
in your shell rc. Hosts read this file at startup.

```bash
opencues set-key groq gsk_...        # default LLM provider
opencues set-key finnhub xxx          # for the stocks blank
opencues set-key openai sk-...
```

### `check-keys` — verify keys work

Hits each configured provider's lightest endpoint and reports
success/failure. Useful when "the LLM isn't responding" — confirms
whether the key or the network is the problem.

---

## Authoring

### `init` — scaffold `<cwd>/.cues/`

Creates the directory + starter folder layout (`cues/` and `blanks/`)
with comments explaining each block. Idempotent — won't clobber
existing files.

```bash
cd ~/my-project
opencues init
```

### `new <kind> <name>` — scaffold one cue / blank

```bash
opencues new cue legal-jargon            # → ~/.cues/cues/legal-jargon/CUE.md
opencues new blank my-script             # → ~/.cues/blanks/my-script/BLANK.md
opencues new blank physics               # → ~/.cues/blanks/physics/BLANK.md
opencues new cue legal --project         # write under <cwd>/.cues/ instead
```

The template includes a `match:` regex placeholder, a sample prompt,
and the `INDEX:alt` format-spec line that the LLM should follow.

### `validate` — lint configs across search paths

Walks every search-path layer (env / project / user), parses every
`.md`, and reports issues:

- Schema problems (missing required fields, malformed YAML)
- Host-compat contradictions (`on-host:` lists chrome but the
  blank has `blankScript: ./*.sh`)
- Multiple defaults without a priority discriminator
- Tip JSON parse failures inside folder-based `cues/<name>/cue.md` body blocks

Exit 0 on success, 1 on errors. Suitable for CI.

### `import <source>` — install a community config pack

Pulls a tarball or local dir into `~/.cues/`. Sources accepted:

```bash
opencues import gist:abc123
opencues import github:user/repo            # default branch / HEAD
opencues import github:user/repo#v0.2       # a tag/branch/sha
opencues import https://example.com/pack.tar.gz
opencues import ./my-local-pack/             # for testing
```

Pack layout matches `defaults/`: top-level `cues.md` + folders for
`cues/` and `blanks/`. Imports are additive; existing
files are preserved unless `--force`.

---

## Run / inspect

### `run <host>` — launch the patched host

Convenience wrapper that just `exec`s the right binary:

```bash
opencues run claude-code     # runs ~/claude-code-cues/.../claude-code
opencues run opencode        # runs ~/opencode-cues/...
```

You can also invoke the patched binaries directly; `opencues run`
exists so you don't need to remember each one's path.

### `sync <host>` — push configs into a host that can't read them

Today only matters for **chrome**. Browser content scripts can't
read `~/.cues/`, so the configs have to be bundled into the
extension at sync time.

```bash
opencues sync chrome --wsl                            # default: user-level only
opencues sync chrome --include ~/work/proj/.cues  # add a project
opencues sync chrome --project                        # add <cwd>/.cues
opencues sync chrome --pack demo-pack                 # ONLY that pack
opencues sync chrome --watch                          # re-sync on file changes
opencues sync chrome --dry-run                        # show what would be synced
```

CC / OC have native filesystem hot-reload — no sync needed.
See [Chrome Sync](../features/chrome-sync.md) for the full
source-discovery rules and [Chrome Hot-Reload](../features/chrome-hot-reload.md)
for how `--watch` lands edits in already-open browser tabs.

### `which` — print every relevant path

The "where does X live?" answer. Lists install paths, config paths,
log paths, key files, and per-integration binaries with `✓` (exists)
or `-` (missing) markers.

```bash
opencues which               # everything
opencues which | grep ✓      # just what's actually installed
```

### `version` — CLI + per-integration versions

```bash
opencues version
# opencues v0.X.X
# @opencues/core      v0.X.X
# @opencues/runtime   v0.X.X
# @opencues/claude-code v0.X.X (CC 2.1.110 ✓ compatible)
# ...
```

### `doctor` — cross-host diagnostics

Read-only health check across every install. Looks for common
breakages (missing `.env`, stale tweakcc state, unbuilt artefacts,
node version mismatches, etc.) and suggests fixes. Run after a
weird issue or before reporting a bug.

### `list` — every defined cue / blank + source

Walks the search paths and prints every entry with where it was
loaded from:

```bash
opencues list                 # everything
opencues list --cues          # filter by kind
opencues list --blanks
```

Output lists each entry's `on-host:` compat (so you can see what'll
work in chrome vs CC).

### `show <name>` — full config for one entry

Dumps the resolved (post-merge) config for a single cue / blank
by name, plus the file it came from:

```bash
opencues show legal
opencues show volume
opencues show math
```

### `edit <file>` — open `~/.cues/<file>.md` in `$EDITOR`

```bash
opencues edit cues               # opens ~/.cues/cues.md (top-level settings)
opencues edit cues/legal         # opens ~/.cues/cues/legal/CUE.md
opencues edit blanks/volume      # opens ~/.cues/blanks/volume/BLANK.md
```

### `logs [--tail]` — show `/tmp/opencues.log`

```bash
opencues logs                # last 50 lines
opencues logs --tail         # follow live (Ctrl+C to exit)
```

Logging goes through the runtime regardless of host; gating is by
`debug-mode` in `cues.md` frontmatter.

### `debug [on|off]` — toggle runtime `debug-mode`

```bash
opencues debug              # print current state
opencues debug on           # enable verbose logging
opencues debug off          # disable
```

Updates `~/.cues/cues.md`; hot-reload picks it up on the
next keystroke. Same effect as cycling `debug-mode` in-text via
the OpenCues Settings blank.

### `completion <shell>` — shell completion script

```bash
opencues completion bash >> ~/.bashrc
opencues completion zsh >> ~/.zshrc
opencues completion fish > ~/.config/fish/completions/opencues.fish
```

---

## Output / exit codes

All commands return:

- `0` on success
- `1` on error (the user did something wrong, validation failed,
  install failed, etc.)
- `2` on usage error (unknown subcommand, wrong arg count)

Verbose output goes to stderr; the "primary result" of read-only
commands (`which`, `list`, `show`, `version`) goes to stdout so it's
pipe-friendly:

```bash
opencues which | grep ✓ | wc -l            # how many things are installed
opencues list --blanks | grep -c domain  # how many domain blanks exist
```

---

## Per-host details

| Host | What `install` does | Notes |
|---|---|---|
| `claude-code` | Builds `@opencues/core` + `@opencues/runtime`, copies them into `~/claude-code-cues/.opencues/`, builds tweakcc with the patches, applies to `cli.js` | Targets `~/claude-code-cues` (NOT the native `claude` install) |
| `opencode` | Patches the fork at `~/opencode-cues` | Quiet by default; `--verbose` for full output |
| `chrome` | esbuild-builds the MV3 extension into `integrations/chrome/dist/` | `--wsl` also mirrors to the Windows desktop install dir |

---

## See also

- [Quickstart](quickstart.md) — happy-path install + first cue
- [Config Search Paths](../features/config-search-paths.md) — where configs are loaded from
- [Chrome Sync](../features/chrome-sync.md) — `sync chrome` source discovery rules
- [Host Compat](../features/host-compat.md) — `on-host:` / `not-on-host:` declarations
