# OpenCues dependency map

This walks the complete dependency surface of an OpenCues install and
the raw `npm install -g opencues` install path. Use it when you want
to know *exactly* what touches the system, what's contained, and what
the user is asked to install.

The high-level rule: **everything we own lives in `~/.opencues/` or
`~/.cues/` (configs) or the host-specific fork dir (`~/claude-code-cues/`
etc.). Everything else is either bundled per-platform via npm or
prompted before being touched.**

## Layers — at a glance

```
                          ┌─────────────────────────────────┐
   pre-install gate       │ package.json "os" + "engines"   │  blocks Windows native,
                          │ (npm-native, hard refuse)       │  Node <18 before any code runs
                          └─────────────────────────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────────────┐
   Tier 1: in-package     │ JS + TS code (runtime/core/*)   │  npm install — done
                          │ Static config files             │
                          └─────────────────────────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────────────┐
   Tier 2: contained      │ ~/.opencues/vendor/             │  We download/build, we uninstall
                          │   ├── bun/   (curl install)     │
                          │   └── tmux/  (prebuilt → build) │
                          │ ~/.cues/scripts/*.exe (WSL)     │  Compiled at install on WSL
                          │ <fork>/node_modules/@opencues/  │  Per-host runtime + core
                          └─────────────────────────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────────────┐
   Tier 3: system         │ apt/brew install bubblewrap,    │  Interactive offer (Y/n)
   (with consent)         │ espeak-ng, brightnessctl, tmux  │  One sudo prompt
                          └─────────────────────────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────────────┐
   Tier 4: daemon clients │ pactl/wpctl/amixer (audio)      │  Can't bundle — talks to daemon
                          │ system Chrome browser           │  User-installed
                          └─────────────────────────────────┘
```

## Per-dependency table

| Dep | Why we need it | Tier | Contained? | Uninstall removes it? |
|---|---|---|---|---|
| **Node.js ≥18** | Run the CLI + every integration's installer | gate | ✗ user-installed | n/a |
| **pnpm** | Workspace install during dev; `pnpm exec opencues` fallback | gate | ✗ user-installed | n/a |
| **git** | Clone CC/OC/gemini forks at pinned SHA | gate | ✗ user-installed | n/a |
| **bash 4+** *(macOS)* | Recommended for third-party blank scripts (mapfile, declare -A) | warn | ✗ system | n/a |
| `@opencues/{core,runtime,cli,*}` | The product itself | 1 | ✓ npm package | ✓ npm uninstall |
| **Bun** (for shell + opencode) | OpenCode is a Bun app; oc-edit / oc-editd use Bun | 2 (offered) | ✓ `~/.opencues/vendor/bun/` | ✓ `opencues uninstall shell` |
| **tmux 3.2+** (for shell) | `oc-shell` slide-pane needs `display-popup` | 2 (prebuilt → build) | ✓ `~/.opencues/vendor/tmux/` | ✓ `opencues uninstall shell` |
| **`VolCtl.exe`, `BrightCtl.exe`, `SpeakCtl.exe`** *(WSL)* | Native Windows binaries for volume/brightness/TTS (fastest path on WSL) | 2 | ✓ `~/.cues/blanks/*` (compiled by seed-configs) | ✗ (config files stay) |
| **`@anthropic-ai/claude-code` pinned** | CC fork we patch | 2 | ✓ `~/claude-code-cues/` | ✓ `rm -rf ~/claude-code-cues` |
| **`sst/opencode` pinned** | OC fork we patch | 2 | ✓ `~/opencode-cues/` | ✓ user `rm -rf` (intentionally left behind by uninstall — your checkout) |
| **`google-gemini/gemini-cli` pinned** | Gemini fork we patch | 2 | ✓ `~/gemini-cli-cues/` | ✓ user `rm -rf` |
| **tweakcc** | Patcher for CC's minified `cli.js` | 2 | ✓ `~/claude-code-cues/.cues/tweakcc/` | ✓ part of CC uninstall |
| **bubblewrap** (`bwrap`) *(Linux)* | OS confiner for `sandbox: strict` blanks | 3 (offered Y/n) | ✗ system pkg-mgr | ✗ user removes |
| **espeak-ng** or **spd-say** *(Linux)* | TTS for `voice-mode` | 3 (offered Y/n) | ✗ system pkg-mgr | ✗ user removes |
| **brightnessctl** or **ddcutil** *(Linux)* | Backend for `brightness _` | 3 (offered Y/n) | ✗ system pkg-mgr | ✗ user removes |
| **`brightness` cli** *(macOS)* | Backend for `brightness _` | 3 (offered Y/n) | ✗ brew | ✗ user removes |
| **system tmux** *(if user picks system over vendored)* | shell integration | 3 (offered Y/n) | ✗ system pkg-mgr | ✗ user removes |
| **`osascript`** *(macOS)* | Backend for `volume _` | 4 | ✓ macOS built-in | n/a |
| **`say`** *(macOS)* | TTS for `voice-mode` | 4 | ✓ macOS built-in | n/a |
| **`sandbox-exec`** *(macOS)* | OS confiner — Apple seatbelt | 4 | ✓ macOS built-in | n/a |
| **`pactl` / `wpctl` / `amixer`** *(Linux)* | Talk to PulseAudio/PipeWire/ALSA daemon for volume | 4 | ✗ daemon client — must match user's stack | n/a |
| **Chrome 121+** | The chrome integration runs here | 4 | ✗ user's browser | n/a |
| **LLM provider API key** (Cerebras / Groq / etc.) | LLM-driven cues + blanks | 4 | ✗ env var or `~/.cues/.env` | ✓ env-cleared by user / file delete |

## The raw `npm install -g opencues` flow

The shape post-launch, assuming `opencues` is published to npm:

```bash
npm install -g opencues
```

That installs:
- Node.js verified ≥18 (npm refuses otherwise via `engines`)
- Platform verified `darwin` or `linux` (npm refuses on `win32` via `os`)
- The CLI binary at `$(npm prefix -g)/bin/opencues`
- `@opencues/{core,runtime,cli,*}` packages — pure JS, no install scripts that touch system

Then the user picks an integration:

```bash
opencues install claude-code   # zero system deps beyond Node + git
opencues install opencode      # needs Bun → preflight offers contained install
opencues install gemini-cli    # needs npm (ships with Node) + git
opencues install chrome        # needs Chrome 121+ (user-installed already)
opencues install shell         # needs Bun + tmux 3.2+ → preflight offers both
opencues install --all         # runs every host installer in sequence
```

Each `install <host>` runs the cross-platform preflight first. The
preflight:

1. **Detects** missing system tools per platform (`bwrap` / `espeak-ng` /
   `brightnessctl` / `tmux` / `bun`).
2. **Prints** a table — `item / impact / fix`.
3. **Offers** (if TTY + not `--no-prompts`) to install them in one
   batched command. **System packages** → one `sudo apt install`
   call. **Bun** → separate `BUN_INSTALL=~/.opencues/vendor/bun curl …
   | bash`. Either skip with [n] or take with [Y].
4. **Continues** the install — anything the user skipped becomes a
   doctor finding, never a hard fail.

After install completes:

```
✓ shell

• verify your environment supports every feature: opencues doctor
```

`opencues doctor` then enumerates every dep, shows ✓/✗ per backend,
and prints a finding for each missing tool with the per-distro fix
command.

## What's still a seam (and why we can't close it)

Two genuine seams remain after every reasonable contained-install
effort:

1. **Native Linux audio backend** (`pactl` / `wpctl` / `amixer`) —
   these are *clients* to PulseAudio/PipeWire/ALSA daemons. We can
   ship a binary but it'd just talk to whatever audio server is up.
   Better answer: detect what's installed and use it.
2. **Linux backlight permissions** — `brightnessctl` writes to
   `/sys/class/backlight/*` which needs setuid root or the right udev
   rules. We can't bundle around the kernel permission check.

Everything else is now contained, offered with consent, or pre-installed.

## Uninstall

```bash
opencues uninstall <host>     # removes everything that host installed
opencues uninstall --all      # all hosts
```

What goes:
- ~/claude-code-cues/, ~/opencode-cues/, ~/gemini-cli-cues/ (fork trees that contain *our* node_modules + patches)
- The patches on each fork's source files (reverted via `git checkout --`)
- The fork's `node_modules/@opencues/` (we own this)
- chrome `dist/` build output
- chrome native-messaging host manifests + sync-host.bat shim
- `~/.opencues/vendor/` (bun + tmux + build src) — when `opencues uninstall shell` runs, unless `--keep-vendor`
- `~/.opencues/shell-integration.{bash,zsh,fish}` + the marker line we appended to user's rc

What stays (intentional):
- `~/.cues/` (your configs, user content)
- `~/.cues/.env` (your API keys)
- Anything installed via `sudo apt` (Tier 3) — we never sudo-uninstall

To go fully clean afterwards:

```bash
opencues uninstall --all
rm -rf ~/.cues ~/opencues
# Tier-3 system pkgs (only if you want them gone):
sudo apt remove bubblewrap espeak-ng brightnessctl
```

## CI / scripted installs

For non-interactive contexts (Docker images, CI runners):

```bash
opencues install <host> --yes        # accept every preflight offer
opencues install <host> --no-prompts # accept nothing; install proceeds with warnings
```

`--yes` runs the sudo-install + bun-curl commands without interactive
confirmation. `--no-prompts` is the audit-friendly mode: preflight
prints warnings, never blocks, never runs sudo or curl.
