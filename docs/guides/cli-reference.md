---
last_updated: 2026-07-04
---

# CLI Reference — `opencues`

The `opencues` command is the front door for everything: installing
host integrations, scaffolding cues, validating configs, inspecting
state, day-to-day operations. One CLI normalizes "install / update
/ debug" across three hosts (CC, OpenCode, Chrome), each with
very different install models underneath.

For the high-level mental model see [`docs/overview.md`](../overview.md);
this page is the per-subcommand reference.

```
$ opencues --help
```

prints the canonical command list. Every subcommand also takes
`--help` for its own usage detail. Bash/zsh/fish completion is
available via `opencues completion <shell>`.

Bare `opencues` (no subcommand) on a terminal opens the **interactive
launcher** instead — a menu that routes into each command's own
interactive flow (Settings, API keys, Identity, Debug logging, Explore
cues & blanks, Install a host, Run a host, Diagnostics, Check API keys,
All commands). Non-TTY / piped input falls back to the same static
status + command list `--help` prints, so scripting is unaffected.

---

## The 5 you'll actually use

| Command | What it does |
|---|---|
| `opencues install <host>` | One-time setup for an editor/host |
| `opencues run <host>` | Launch it |
| `opencues set-key <provider> <key>` | Add an LLM API key |
| `opencues doctor` | Something's wrong — diagnostics |
| `opencues update` | Pull latest + rebuild everything |

Everything below is the full reference. For every command sorted by
frequency instead, see the [cheat sheet](cli-cheatsheet.md).

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
opencues install gemini-cli          # patch the Gemini CLI 0.41.x fork at ~/gemini-cli-cues
opencues install shell                # standalone Bun + OpenTUI app, no upstream fork (oc-shell / oc-edit)
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

Four phases on every invocation. Note this command owns `OPENCUES.md`
+ `AUDITORS.md` + the `cues/`/`blanks/`/`auditors/`/`scripts/` folder
dirs — it never touches `CUES.md`/`BLANKS.md` (those are `opencues
init`'s job, for project-level scaffolding; see below):

1. **SEED** — first-time copy of `defaults/{OPENCUES.md,AUDITORS.md,cues/,blanks/,scripts/}` → `~/.cues/`. Skips files that already exist with content (preserves user edits).
2. **SYNC** — overwrites stale library files (`.sh` / `.cs` / `.ps1` from `defaults/{blanks,scripts}/`) every install. Never overwrites `.md` (user content). Catches drift when path-resolution logic changes between repo versions.
3. **HEAL** — re-seeds a 0-byte `~/.cues/OPENCUES.md` from `defaults/OPENCUES.md`, and merges in any new scalars a fresh install shipped that an existing user's file predates (keeping the user's existing values). A 0-byte `OPENCUES.md` would otherwise silently break every runtime-settings read (`opencues settings _`, hot-reload, feature toggles) on every native host (CC + OC). Chrome unaffected — uses bake-time fallback.
4. **COMPILE** (WSL only) — compiles colocated `.cs` → `.exe` next to the script that uses them (`BrightCtl.exe` next to `brightness.sh`, `VolCtl.exe` next to `volume.sh`, `SpeakCtl.exe` next to `speak.sh`). Idempotent — only compiles when `.exe` is older than `.cs`.

| Flag | Effect |
|---|---|
| (none) | User-level. Runs all four phases. |
| `--project` | Writes into `<cwd>/.cues/` instead — only `cues/`/`blanks/`/`auditors/` folders (no `scripts/`, no `OPENCUES.md`; sync/heal/compile are user-level only). For `CUES.md`/`BLANKS.md`/`AUDITORS.md` master-file scaffolding at the project level, use `opencues init --project`. |
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

### `update-configs` — pull new shipped defaults into `~/.cues/`

A thin wrapper around `seed-configs` for the narrower "I just pulled
new opencues code, get any new shipped cues/blanks onto my disk"
workflow. Deliberately separate from `update` — `update` rebuilds +
redeploys a host integration, a different concern; running it
shouldn't silently rewrite `~/.cues/` too.

```bash
opencues update-configs
```

### `config` — browse + change OpenCues settings

Interactive settings browser (on a TTY) over every `OPENCUES.md`
scalar — the schema is the `FEATURES` + `MENU_TUNABLES` registry in
`@opencues/core`, so adding a feature there makes it appear here for
free. Grouped into sections (Cues / Blanks / Context & identity /
Agent / Voice & navigation / LLM routing / Appearance / Diagnostics).

```bash
opencues config                      # interactive settings browser
opencues config list                 # print every setting + its current value
opencues config get <scalar>         # print one setting's effective value
opencues config set <scalar> <value> # change a setting (validated against the registry)
```

Writes `~/.cues/OPENCUES.md`. Hidden footgun values
(`exposeInMenu:false`, e.g. `identity-context-mode: raw`) stay
file-edit-only — they don't appear in the browser or `list`.

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

Creates the directory with four starter files — `CUES.md`, `BLANKS.md`,
`AUDITORS.md`, and a `README.md` explaining the layout — each with
comments describing its blocks (`--minimal` writes empty `.md` files
instead). Idempotent — won't clobber existing files.

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

- Schema problems (malformed frontmatter, a cue with neither `match:` nor `keywords:`, a blank with no `blankKeywords`, an `impl:`/`blankScript:` pointing at a file that doesn't exist)
- Host-compat resolving to zero hosts (the entry can never run)
- Blank-specific footguns: no binding profile declared (unreachable at runtime), a `blankScript` that isn't executable, `sandbox:` left unset, `impl:` declaring no capabilities, secret bindings that are orphaned/unreachable/unused
- Endpoint config problems (invalid or non-default `-endpoint:` overrides)
- Empty cue/auditor body (no tip-group JSON, no prompt text — nothing for the source to actually do)

Each finding is tagged with its lint-rule code (see `spec/core.md` §
Linting rules) — `--json` for machine-readable output, `--strict` to
treat warnings as errors. Exit 0 on success, 1 on errors (or warnings
under `--strict`). Suitable for CI.

### `import <source>` — install a community config pack

Pulls a tarball or local dir into `~/.cues/`. Sources accepted:

```bash
opencues import gist:abc123
opencues import github:user/repo            # default branch / HEAD
opencues import github:user/repo#v0.2       # a tag/branch/sha
opencues import https://example.com/pack.tar.gz
opencues import ./my-local-pack/             # for testing
```

Pack layout matches `defaults/`: top-level `CUES.md` + folders for
`cues/` and `blanks/`. Imports are additive; existing
files are preserved unless `--force`.

### `review <source>` — security review of a third-party config pack

Two-pass review before you trust a pack: (1) a deterministic static
parse (reuses `validate`'s logic — counts declared capabilities,
red flags, suspicious source patterns), (2) an opt-in LLM second
opinion (`--llm`; pure text-in/text-out, no tool access, pack content
wrapped in `<untrusted-source>` delimiters). The static parse is the
authority; the LLM verdict can only downgrade a rating, never upgrade
one. `opencues import` runs this automatically and requires an
explicit confirm before installing.

```bash
opencues review github:user/repo
opencues review ./my-local-pack/ --llm
```

---

## Run / inspect

### `run <host>` — launch the patched host

Convenience wrapper that just `exec`s the right binary:

```bash
opencues run claude-code     # runs ~/claude-code-cues/.../claude-code
opencues run opencode        # runs ~/opencode-cues/...
opencues run gemini-cli      # runs node packages/cli/dist/index.js inside ~/gemini-cli-cues
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
# @opencues/claude-code v0.X.X (CC 2.1.110 / 2.1.150 ✓ compatible)
# ...
```

### `doctor` — cross-host diagnostics

Read-only health check across every install. Looks for common
breakages (missing `.env`, stale tweakcc state, unbuilt artefacts,
node version mismatches, etc.) and suggests fixes. Run when something
behaves unexpectedly, or before reporting a bug.

### `identity` — manage IDENTITY.md identity fields

`~/.cues/IDENTITY.md` is a YAML frontmatter file where each key
becomes an identity-context token (`firstName: Wilfred` → `[FIRST
NAME]`) that FluidBlank/TransformBlank can substitute in. See
[`docs/architecture/identity-context.md`](../architecture/identity-context.md).

```bash
opencues identity                  # interactive interview
opencues identity list             # show current identity fields
opencues identity list --json      # JSON output (scriptable)
opencues identity set <key> <val>  # add or update one (also: add)
opencues identity remove <key>     # remove one (also: rm)
```

### `context` — inspect every context source reaching the LLM

Unified read-only view across the three optional context sources: identity-context
(`~/.cues/IDENTITY.md`), blank-context (ambient blank tokens — stocks,
weather, …), and ambient-context (chrome-only field metadata). Shows
what the LLM would actually see in the prompt, gated by each source's
mode scalar.

```bash
opencues context list              # human-readable summary
opencues context list --json       # JSON for scripting
```

### `cleanup` — find + kill orphan host processes

Long-running `opencues run <host>` invocations sometimes leak (terminal
closes, the wrapper script dies, the underlying process double-forks
and outlives its parent). Reports + reaps them. Also runs automatically
at the start of every `opencues run <host>` (a fresh run supersedes
prior instances of the same host).

```bash
opencues cleanup          # list orphan processes
opencues cleanup --kill   # reap them
```

### `statusline <enable|disable|status>` — Claude Code status-line integration

Opt-in surface for CC's `statusLine` slot — kept as a separate command
(rather than folded into `opencues install claude-code`) because
`~/.claude/` is Claude Code's own directory and writing to it on every
install would surprise users with a custom statusline already set up.

```bash
opencues statusline enable
opencues statusline status
opencues statusline disable --project
```

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
opencues edit cues               # opens ~/.cues/CUES.md (top-level settings)
opencues edit cues/legal         # opens ~/.cues/cues/legal/CUE.md
opencues edit blanks/volume      # opens ~/.cues/blanks/volume/BLANK.md
```

### `logs [--tail]` — show `/tmp/opencues.log`

```bash
opencues logs                # last 50 lines
opencues logs --tail         # follow live (Ctrl+C to exit)
```

Logging goes through the runtime regardless of host; gating is by
`debug-mode` in `CUES.md` frontmatter.

### `debug [on|off]` — toggle runtime `debug-mode`

```bash
opencues debug              # print current state
opencues debug on           # enable verbose logging
opencues debug off          # disable
```

Updates `~/.cues/CUES.md`; hot-reload picks it up on the
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
| `claude-code` | Builds `@opencues/core` + `@opencues/runtime`, copies them into `~/claude-code-cues/.cues/`, builds tweakcc with the patches, applies to `cli.js` | Targets `~/claude-code-cues` (NOT the native `claude` install) |
| `opencode` | Patches the fork at `~/opencode-cues` | Quiet by default; `--verbose` for full output |
| `chrome` | esbuild-builds the MV3 extension into `integrations/chrome/dist/` | `--wsl` also mirrors to the Windows desktop install dir |
| `gemini-cli` | Clones the fork at `~/gemini-cli-cues`, installs deps, builds + installs `@opencues/{core,runtime}`, drops `opencuesBootstrap.ts` in, patches 4 source files, runs `npm run build` | Pinned to Gemini CLI 0.41.x via `integrations/gemini-cli/pin.json` |
| `shell` | No upstream fork — preflights Bun/tmux, `bun install`s OpenTUI deps, auto-installs a vendored tmux if none usable | Vendored tools land in `~/.opencues/vendor/`; exposes `oc-shell` (wraps your interactive shell in a private tmux session) / `oc-edit` |

---

## See also

- [Quickstart](quickstart.md) — happy-path install + first cue
- [Config Search Paths](../features/config-search-paths.md) — where configs are loaded from
- [Chrome Sync](../features/chrome-sync.md) — `sync chrome` source discovery rules
- [Host Compat](../features/host-compat.md) — `on-host:` / `not-on-host:` declarations
