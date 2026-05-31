# Install

Per-host installation, what each install does, where things land, and how to recover when something fails. For a 5-minute Claude Code quickstart, see [`README.md` § Quickstart](../README.md#quickstart-5-minutes); this doc is the deep version.

## Prerequisites

- **Node.js 18+** (`node --version`)
- **pnpm 8+** (`pnpm --version`; `corepack enable pnpm` ships it with Node 16+)
- An **LLM provider API key.** Cerebras is the recommended default
  ([cloud.cerebras.ai/platform/](https://cloud.cerebras.ai/platform/) → *Generate API Key*); Groq, OpenAI, Anthropic, Gemini, OpenRouter,
  and OpenCode Zen are all supported. Full provider table + per-feature
  routing: [`docs/guides/llm-providers.md`](guides/llm-providers.md).
- The **host editor** you want to integrate with (see per-host requirements below)

For the **complete dependency map** + the raw `npm install -g opencues` walk-through (tier 1 contained / tier 2 vendored / tier 3 system-with-consent / tier 4 daemon-clients), see [`docs/install/dependencies.md`](install/dependencies.md). It enumerates every dep, who owns its install, and who owns its uninstall.

### Supported platforms

| Platform | Status | Notes |
|---|---|---|
| **Linux** | Supported | Primary dev platform. Optional tools (bwrap, espeak-ng, pactl/wpctl/amixer, brightnessctl) extend feature coverage — see per-feature table below. |
| **macOS** (Intel + Apple Silicon) | Supported | Hardened May 2026 for bash 3.2 + BSD coreutils + sandbox-exec. macOS preflight runs at `opencues install` time. |
| **WSL2** | Supported | Same as Linux. Chrome integration auto-targets Windows-side Chrome via `--wsl`. |
| **Windows native** | Not supported | Installers are bash + POSIX coreutils. `package.json` carries `"os": ["darwin", "linux"]` — `npm install` refuses on `win32`. Use WSL2. |

Run `opencues doctor` after every install — it cross-checks every install boundary and points at the specific fix for anything missing.

### Per-feature platform support

Each row is a feature that has a hard OS dependency outside `@opencues/{core,runtime}`. Missing the listed tool means the feature silently degrades (usually to a no-op or a default value) — not a hard failure. `opencues install` preflight + `opencues doctor` both surface the gap.

| Feature | macOS | Linux | WSL | What it needs |
|---|---|---|---|---|
| **`volume _` blank** | built-in (`osascript`) | needs `wpctl` (PipeWire) / `pactl` (PulseAudio) / `amixer` (ALSA) | colocated `VolCtl.exe` or `nircmd.exe` | If none found: reads "50" on get; set is a no-op. |
| **`brightness _` blank** | needs `brew install brightness` (laptop) or `ddcutil` (external) | needs `brightnessctl` (laptop) or `ddcutil` (external) | colocated `BrightCtl.exe` or PowerShell WMI | If none found: reads "50" on get; set is a no-op. |
| **TTS (`voice-mode`)** | built-in (`say`) | needs `espeak-ng` or `spd-say` | `SpeakCtl.exe` (colocated) or `powershell.exe` | If none found: voice-mode is a silent no-op. |
| **Strict sandbox** (`sandbox: strict` blanks) | built-in (`sandbox-exec`) | needs `bubblewrap` (`bwrap`) | Linux path (bwrap) | If missing: scripted blanks still run, just unwrapped. `doctor` flags it. |
| **Chrome native-messaging host** (live `~/.cues/` sync + scripted blanks in Chrome) | supported | supported | supported (`.bat` shim → `wsl.exe`) | Bundled with `opencues install chrome-host`. |

Quick-install commands per distro:

```bash
# Debian / Ubuntu — everything the preflight may suggest:
sudo apt install bubblewrap espeak-ng pulseaudio-utils brightnessctl tmux

# Fedora:
sudo dnf install bubblewrap espeak-ng pulseaudio-utils brightnessctl tmux

# Arch:
sudo pacman -S bubblewrap espeak-ng libpulse brightnessctl tmux

# macOS — everything brew can supply:
brew install bash tmux brightness  # bash 4+ optional but recommended
```

### Per-integration host requirements

| Integration | What you need first | Check |
|-------------|---------------------|-------|
| `claude-code` | Claude Code 2.1.110+ on PATH (the installer reinstalls a pinned copy locally; the on-PATH check just confirms you have the auth set up) | `claude --version` |
| `opencode`    | [bun](https://bun.sh/) (OpenCode is a bun app — the installer clones a fork itself) | `bun --version` |
| `chrome`      | Chrome 121+ | `chrome://version` |
| `gemini-cli`  | Node 18+ (installer clones a Gemini CLI 0.41.x fork itself) | `node --version` |

A Claude-Code-only user never needs bun. An OpenCode user needs bun because OpenCode itself is a bun app, not because OpenCues requires it.

## Install commands

```bash
# Clone + install (one time)
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues
pnpm install
pnpm build

# Store the API key (works on any shell — writes ~/.cues/.env chmod 600).
# Provider names: groq, cerebras, openai, anthropic, openrouter, gemini.
pnpm exec opencues set-key groq your-key

# Or, if you'd rather use env vars in your shell config:
#   bash: echo 'export GROQ_API_KEY="your-key"' >> ~/.bashrc && source ~/.bashrc
#   zsh : echo 'export GROQ_API_KEY="your-key"' >> ~/.zshrc  && source ~/.zshrc
#   fish: set -Ux GROQ_API_KEY your-key

# Install the integration(s) you want
pnpm exec opencues install claude-code     # patches Claude Code
pnpm exec opencues install opencode        # patches an OpenCode 1.4.x or 1.14.x fork
pnpm exec opencues install chrome          # builds the MV3 extension
pnpm exec opencues install chrome-host \
  --extension-id <id-from-chrome-extensions>  # optional — live ~/.cues/ sync into Chrome
pnpm exec opencues install gemini-cli      # patches a Gemini CLI 0.41.x fork
pnpm exec opencues install --all           # all four (chrome-host is separate)

# Launch (claude-code, opencode, gemini-cli — chrome auto-loads in browser)
pnpm exec opencues run claude-code
pnpm exec opencues run opencode
pnpm exec opencues run gemini-cli
```

| Integration | Install | Compatible with | Launch |
|---|---|---|---|
| **Claude Code** | `opencues install claude-code` | Claude Code 2.1.110+ | `opencues run claude-code` (or just `claude-cues` once on PATH) |
| **OpenCode** | `opencues install opencode` | OpenCode 1.4.x / 1.14.x | `opencues run opencode` |
| **Chrome** | `opencues install chrome` (+ `opencues install chrome-host` for live `~/.cues/` sync) | Chrome 121+ | Load unpacked at `chrome://extensions` (path printed by installer) |
| **Gemini CLI** | `opencues install gemini-cli` | Gemini CLI 0.41.2 | `opencues run gemini-cli` |

Per-host install detail, paths touched, uninstall flow: each integration's own README (linked above).

## What each install does

Every `opencues install <host>` is one command, end-to-end — no manual `bun install` / extra setup after.

| Host | Steps the installer runs | Runnable with `opencues run <host>`? |
|---|---|---|
| `claude-code` | `seed-configs` (shared `~/.cues/`) + nuke-and-rebuild from scratch inside `~/claude-code-cues/` (clone tweakcc, build runtime + core, patch cli.js, verify). ~1m warm install. tweakcc is just our patcher — every stock tweakcc patch is disabled, only OpenCues v2 wiring lands. | ✓ (runs `claude-cues`) |
| `opencode` | Clone the fork + `bun install` fork deps + build our runtime + install into fork's `node_modules/@opencues/` + patch 4 TSX files | ✓ |
| `chrome` | Build MV3 extension + copy `dist/` to `--target` if provided | ✗ — load unpacked at `chrome://extensions` yourself |
| `chrome-host` | Drop a local native-messaging host + register it with Chrome (manifest + WSL `.bat` shim + HKCU registry on Windows). Requires `--extension-id <id>` from `chrome://extensions`. After install, edits to `~/.cues/` push into every open tab in ~300ms — no rebuild, no refresh. | ✗ — Chrome spawns the host on demand |
| `gemini-cli` | Clone the fork + `npm install` fork deps + build our runtime + install into fork's `node_modules/@opencues/` + patch 4 source files (3 TSX + esbuild config) + `npm run build` the fork | ✓ |

## Where things land

| Path | Purpose |
|---|---|
| `~/claude-code-cues/` | Everything `@opencues/claude-code` owns lives inside this CC fork: `node_modules/@opencues/{core,runtime}/` (runtime), `.cues/{statusline.sh,scripts/,patch-state/}` (support files), and the patched `cli.js`. Uninstall is `rm -rf` of this dir + tweakcc revert. |
| `~/opencode-cues/` | OpenCode fork the integration clones + patches |
| `~/gemini-cli-cues/` | Gemini CLI fork the integration clones + patches. `node_modules/@opencues/{core,runtime}/` + `packages/cli/src/ui/opencues.ts` (bootstrap) + 4 patched source files. |
| `~/.cues/` | User-level configs — `OPENCUES.md` (runtime settings) plus the three master files (`CUES.md`, `BLANKS.md`, `AUDITORS.md`) and their per-source folders. Read by every host. |
| `<cwd>/.cues/` | Project-level config overrides. Read by native hosts (claude-code, opencode, gemini-cli) automatically via cwd. Chrome with `chrome-host` installed reads `~/.cues/` live (or `$OPENCUES_HOME` if set); without the host, only the extension's bake-time defaults apply. |
| `<repo>/defaults/` | Seed source for `opencues seed-configs` + Chrome's bake-time defaults. Never read at runtime; part of the code pipeline, not user config. |
| `/tmp/opencues.log` | Runtime debug log when a patched host runs |

`opencues which` prints a live blast-radius view with ✓ / − markers showing what's actually on disk.

## Common install failures

If `opencues install <host>` exits non-zero, it's usually one of these:

| What you see | Why | Fix |
|---|---|---|
| `pnpm: command not found` | pnpm isn't on PATH | `corepack enable pnpm` (Node 16+ ships it) or `npm install -g pnpm` |
| `claude-cues: command not found` after a successful install | Your shell hasn't picked up `~/.local/bin/` (or wherever pnpm linked the bin) | Open a fresh shell, or `export PATH="$HOME/.local/bin:$PATH"` |
| Install hangs at `Cloning into ~/claude-code-cues...` | Slow git clone or proxy issue — installer fetches the upstream fork | Wait it out (first install pulls ~50MB); set `https_proxy` if behind a corporate proxy |
| `GROQ_API_KEY not set` warning at the end | Key isn't visible to the install shell | `opencues set-key groq <key>` (writes `~/.cues/.env`, no shell config needed) and re-run install |
| Linux: Ctrl+Alt+arrow switches workspace instead of cycling cues | Your DE owns those keys | See the next section |
| `claude-cues` launches but typing does nothing visible | Runtime didn't boot, or `voice-mode: inactive` and you expected TTS | `tail /tmp/opencues.log` for the boot lines; `opencues doctor` cross-checks every install boundary |
| OpenCode/shell install fails at `bun install` | Bun isn't installed | Re-run `opencues install opencode` (or `shell`) and answer **Y** to the "Install bun?" preflight prompt — drops a contained copy in `~/.opencues/vendor/bun/`. Or install system-wide: `curl -fsSL https://bun.sh/install \| bash`. |
| Shell install: `oc-install-tmux` fails on missing build deps | Source-build path needs gcc + libevent + ncurses + bison | `opencues install shell` runs the preflight first — answer **Y** to the system-package offer to apt/brew-install. Or install them yourself: `sudo apt install build-essential libevent-dev libncurses-dev pkg-config bison`. Prebuilt tmux tarballs (zero build deps) land when a `tmux-prebuilt-<ver>` GitHub release is published. |
| doctor reports "missing version marker" on every host | Install pre-dates the version-marker era (introduced post-v0.1) | Re-run `opencues install <host>` once — writes the marker for future drift detection. One-time clear. |
| Chrome extension loads but does nothing on a page | Bundle didn't sync or extension is stale | Hard-reload at `chrome://extensions` (reload icon on the OpenCues card) + hard-refresh the page |

`opencues doctor` runs every one of these checks (and more) — if you're stuck on something else, start there.

### Linux/Wayland workspace conflict

GNOME, KDE, and most tiling WMs bind Ctrl+Alt+arrow to workspace switching by default. The OS swallows the keystroke before OpenCues ever sees it — typing feels normal but cycling does nothing. To unbind:

- **GNOME:** `gsettings set org.gnome.desktop.wm.keybindings switch-to-workspace-left "[]"` (repeat for `-right`, `-up`, `-down`). Revert with `... reset switch-to-workspace-left`.
- **KDE:** *System Settings → Shortcuts → Global Shortcuts → KWin* → clear "Switch One Desktop to the Left/Right/Up/Down".
- **Sway/i3:** comment out the `Ctrl+Alt+Left/Right` bindings in your config.
- **macOS:** *System Settings → Keyboard → Keyboard Shortcuts → Mission Control* → uncheck "Move left a space" / "Move right a space" (or change to Ctrl+arrow only).

Test: in a fresh shell, press Ctrl+Alt+Right inside `claude-cues`. If your workspace switches, the OS still owns the binding.

## Troubleshooting

### `claude-cues` is on PATH but typing produces no cues

Work through these in order:

1. **Did you restart the host editor?** Patches only take effect after a restart.
2. **Is the API key visible to the host process?** `export GROQ_API_KEY=...` in a one-off terminal doesn't survive — the host needs it in `~/.bashrc` (and a fresh session since adding it), OR write it via `opencues set-key groq <key>` so `~/.cues/.env` carries it.
3. **Did install finish?** `pnpm exec opencues doctor` shows what's missing.
4. **Check the runtime loaded:** `ls ~/claude-code-cues/node_modules/@opencues/runtime/dist/` should list dist files.
5. **Enable debug logging:** `pnpm exec opencues debug on`, then `pnpm exec opencues logs --tail`.

### Syntax error after patching cli.js

The default install nukes + reinstalls cli.js from npm every run, so the fastest fix is just re-running:

```bash
pnpm exec opencues install claude-code
```

If you need to manually revert (e.g. the tweakcc backup is the only good copy):

```bash
cp ~/claude-code-cues/.cues/patch-state/cli.js.backup \
   ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js
```

### Install fails at `FATAL: tweakcc dist contains no opencues v2 code`

setup.sh's verification gates caught a real problem — tweakcc patched but opencues didn't land. Most likely a CC version drift (your `~/claude-code-cues/package.json` has a non-exact pin like `^2.1.110` allowing npm to upgrade to a version with a different cli.js layout). Fix:

```bash
cat > ~/claude-code-cues/package.json << 'EOF'
{
  "dependencies": {
    "@anthropic-ai/claude-code": "2.1.110"
  }
}
EOF
pnpm exec opencues install claude-code
```

## Status line (Claude Code)

Shows the highlighted word and its tip in Claude Code's status bar:

```
agents (1/3) - Spawn parallel workers via Task tool
```

**Opt-in by design.** `opencues install claude-code` stages
`statusline.sh` into the CC fork dir but **does not write to
`~/.claude/settings.json`** — that's Claude Code's own directory and
we don't want to touch it without explicit consent. Run the dedicated
command:

```bash
opencues statusline status               # what's configured where?
opencues statusline enable               # writes ~/.claude/settings.json (user-level)
opencues statusline enable --project     # writes <cwd>/.claude/settings.json (project-level)
opencues statusline disable [--project]  # clears it
```

Behaviour rules:

- We back up `settings.json` to `settings.json.bak.cues-statusline` before any write.
- If `statusLine.command` is already a custom script (your starship.sh, etc.) we refuse to overwrite — pass `--force` if you want to replace it.
- If `statusLine.command` already points at a stale opencues path (from a prior install layout), `enable` rewrites it to the current path.
- `disable` only clears our entry — never touches a non-opencues `statusLine.command`.
- Project-level wins over user-level. `opencues doctor` flags this shadow case so you know when project-level CC settings are suppressing the user-level tip surface.

Full reference: [`integrations/claude-code/docs/status-line.md`](../integrations/claude-code/docs/status-line.md).

## Updating

One command, handles every detected integration in lockstep:

```bash
opencues update              # git pull + rebuild + redeploy every installed host
opencues update --dry-run    # preview the plan first
opencues update --check      # report what's available without changing anything
opencues update claude-code  # update one host only (still pulls + builds the workspace)
```

Internals:
- Takes a lock at `~/.opencues/.update.lock` so two concurrent updates can't race.
- Detects running CC/OC/Gemini sessions and warns (your running session keeps its old code until restart — safe).
- Stale locks from a crashed prior run are reclaimed automatically.
- `Ctrl+C` mid-update releases the lock cleanly.

OpenCues also passively notifies when a newer version is on npm — `install`, `run`, and `doctor` print a one-line hint when a fresh registry check returns a higher version. Set `OPENCUES_NO_UPDATE_CHECK=1` to disable.

For a single host re-install (no workspace pull): `opencues install <host>` re-runs that integration's full install pipeline.

Per-integration upgrade runbooks (for upstream Claude Code / OpenCode / Gemini version bumps, not for OpenCues updates):
- [`integrations/claude-code/UPGRADING.md`](../integrations/claude-code/UPGRADING.md)
- [`integrations/opencode/UPGRADING.md`](../integrations/opencode/UPGRADING.md)
- [`integrations/gemini-cli/UPGRADING.md`](../integrations/gemini-cli/UPGRADING.md)
- [`integrations/chrome/UPGRADING.md`](../integrations/chrome/UPGRADING.md)

## Uninstall

`uninstall` reverts the patches each integration applied to its host. It does **not** touch your user configs, the cloned OpenCues repo, or (for OpenCode/Gemini) the upstream fork itself — those stay put so you can re-install without losing settings.

```bash
pnpm exec opencues uninstall claude-code   # reverts cli.js + removes ~/claude-code-cues/{node_modules/@opencues,.cues}/
pnpm exec opencues uninstall opencode      # git checkout 4 patched files + removes fork node_modules entries
pnpm exec opencues uninstall gemini-cli    # same shape as opencode
pnpm exec opencues uninstall chrome        # removes integrations/chrome/dist + (if --target was used) the deploy
pnpm exec opencues uninstall --all
```

Preview any of these with `--dry-run` before executing. `opencues which` shows every path that would be affected.

### Fully removing OpenCues

`uninstall` only handles host-side patches. To go further:

```bash
# 1. Revert host patches
pnpm exec opencues uninstall --all

# 2. Remove user-level configs (voice-mode, tips, custom cues, ...)
rm -rf ~/.cues

# 3. Remove the OpenCues clone itself
rm -rf ~/opencues

# 4. Remove the cloned editor forks (these stay in place because they're
#    your checkouts of upstream editors, not ours)
rm -rf ~/opencode-cues ~/gemini-cli-cues ~/claude-code-cues
```

### If uninstall partially fails

The OpenCode + Gemini CLI uninstalls revert patched files with `git checkout --`. If the fork's working tree is dirty (you edited those files), git refuses and the uninstaller logs the skipped file. Stash or commit your changes, then re-run `opencues uninstall <host>`. `claude-code` and `chrome` are idempotent — re-running is safe.
