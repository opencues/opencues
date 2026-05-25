# Install

Per-host installation, what each install does, where things land, and how to recover when something fails. For a 5-minute Claude Code quickstart, see [`README.md` § Quickstart](../README.md#quickstart-5-minutes); this doc is the deep version.

## Prerequisites

- **Node.js 18+** (`node --version`)
- **pnpm 8+** (`pnpm --version`; `corepack enable pnpm` ships it with Node 16+)
- An **LLM provider API key** (Groq's free tier covers every feature — [`docs/guides/llm-providers.md`](guides/llm-providers.md) covers the full provider table)
- The **host editor** you want to integrate with (see per-host requirements below)

### Recommended for full sandbox security

Scripted blanks (volume, brightness, anything that spawns a script) get OS-level confinement when [bubblewrap](https://github.com/containers/bubblewrap) is available.

| Platform | Install | Status if missing |
|---|---|---|
| Linux / WSL2 | `apt install bubblewrap` (Debian/Ubuntu) / `dnf install bubblewrap` (Fedora) / `pacman -S bubblewrap` (Arch) | Scripted blanks still run, but without confinement. `opencues doctor` flags it. |
| macOS | Already installed (`/usr/bin/sandbox-exec` ships with macOS) | — |
| Windows native | Not yet supported | Strict-sandbox blanks fall back unwrapped |

Run `opencues doctor` after install to confirm everything's wired.

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
| OpenCode install fails at `bun install` | Bun isn't installed | `curl -fsSL https://bun.sh/install \| bash` then re-run |
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

**Enable:** Run `/statusline` in Claude Code and set the command to:

```
~/claude-code-cues/.cues/statusline.sh
```

**Disable:** Run `/statusline` again and clear the command.

Full reference: [`integrations/claude-code/docs/status-line.md`](../integrations/claude-code/docs/status-line.md).

## Updating

```bash
cd ~/opencues
git pull
pnpm install                   # picks up dep changes
pnpm exec opencues update      # pulls, rebuilds, redeploys every detected install
```

For a single host re-install: `pnpm exec opencues install <host>` re-runs the integration's full install pipeline.

Per-integration upgrade runbooks (for upstream version bumps, not for OpenCues updates):
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
