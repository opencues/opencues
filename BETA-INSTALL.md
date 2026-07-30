# Installing from a clone (manual / contributor flow)

The one-command path is live: **`npm install -g opencues`** (Node 22+ and git
required) — the CLI fetches its runtime repo to `~/.opencues/repo` on first
use, pinned to its own version tag, and handles workspace deps itself (pnpm,
or corepack when pnpm isn't installed). That's the whole
[README quickstart](README.md#quickstart).

This document is the **manual clone flow** — for contributors, for anyone who
wants the checkout somewhere specific (`$OPENCUES_REPO` points the CLI at any
checkout), or for spelling out the prerequisites the one-command path assumes.
Step 4 (the per-integration install) is identical in both flows.

---

## 1. System prerequisites (one-time per machine)

OpenCues needs **Node.js 22+** and **pnpm 8+**. The installers are bash + POSIX coreutils, so platform support is:

- **macOS** (Intel + Apple Silicon) — supported natively.
- **Linux** — supported natively (the primary dev platform).
- **Windows** — **not** supported natively; run everything inside **WSL2**. `package.json` declares `"os": ["darwin", "linux"]`, so `pnpm install` refuses up front on native Windows rather than failing mid-install.

Pick your platform and run the matching block. Each ends by verifying `node --version` (v22+) and `pnpm --version` (8+).

**macOS** — default shell is zsh, so the API-key + alias steps below write to `~/.zshrc`:

```bash
brew install node            # Node.js 22+ — or: brew install fnm && fnm install --lts
corepack enable pnpm         # pnpm 8+ — ships with Node 16+; or: npm install -g pnpm

node --version && pnpm --version
```

**Linux** — distro Node packages are often stale, so fnm (or nodesource) is safer:

```bash
curl -fsSL https://fnm.vercel.app/install | bash && exec $SHELL -l
fnm install --lts && fnm use lts-latest    # Node.js 22+
# OR (Debian/Ubuntu, if new enough): sudo apt install nodejs npm

corepack enable pnpm         # pnpm 8+ — or: npm install -g pnpm

node --version && pnpm --version
```

**Windows** — install WSL2 once, then run **every** OpenCues command inside the Linux shell (Ubuntu terminal), **not** PowerShell or CMD:

```powershell
# In an elevated PowerShell (Windows side), then reboot when prompted:
wsl --install -d Ubuntu
```

Open the **Ubuntu** terminal and follow the **Linux** block above for Node + pnpm. From there, every step below runs inside WSL. The Chrome integration is the one cross-boundary case — it builds in WSL and deploys to Windows-side Chrome via `--wsl` / `--target` (see [step 4](#4-install-an-integration)).

**That's it for prereqs.** Anything else an integration needs (bun for opencode/shell, tmux for shell, bubblewrap/espeak-ng/brightnessctl on Linux) the installer detects + offers to install for you with a single prompt — `[Y]es / [n]o / [d]etails`. Contained tools (bun, tmux) land in `~/.opencues/vendor/` so `opencues uninstall <host>` cleans them up; system packages prompt for sudo once and stay where your package manager put them. Pass `--no-prompts` to skip every offer (CI mode).

> **Native module fallback.** The runtime sandbox uses [`isolated-vm`](https://github.com/laverdet/isolated-vm), a native C++ binding. Prebuilt binaries cover linux/darwin x64+arm64 and win32 x64 — those install without any toolchain. On rarer arches (e.g. armv7, FreeBSD) `pnpm install` falls back to `node-gyp rebuild`, which needs `build-essential` + `python3` on Linux or `xcode-select --install` on macOS. The installer probes the binding on every run; if it can't load, you get one actionable line with the right fix for your platform before any host build starts.

## 2. Get an LLM API key

**Cerebras is the recommended default** — same `gpt-oss-120b` weights as Groq, lower latency on the free tier:

1. Sign up at [cloud.cerebras.ai/platform/](https://cloud.cerebras.ai/platform/)
2. Click *Generate API Key*
3. Persist it in your shell rc:

```bash
echo 'export CEREBRAS_API_KEY="csk-..."' >> ~/.bashrc      # zsh → ~/.zshrc
exec $SHELL -l
```

Groq, OpenAI, Anthropic, Gemini, OpenRouter, and OpenCode Zen are all supported too — see [`docs/guides/llm-providers.md`](docs/guides/llm-providers.md) for env var names and how to switch.

## 3. Bootstrap the `opencues` CLI

```bash
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues
pnpm install
pnpm build

# Add an alias so you can type `opencues` from anywhere
echo 'alias opencues="pnpm --silent -C ~/opencues exec opencues"' >> ~/.bashrc
# zsh: ~/.zshrc instead. fish: `alias --save opencues "pnpm --silent -C ~/opencues exec opencues"`
exec $SHELL -l

# Verify
opencues --version
```

## 4. Install an integration

Pick one (or more — they share state and install order doesn't matter):

### Claude Code

```bash
opencues install claude-code
claude-cues                  # launches the patched fork; native `claude` is untouched
```

Clones `@anthropic-ai/claude-code` (pinned) into `~/claude-code-cues/` and patches it via tweakcc. First run ~3-4 min, re-runs ~1 min. Full doc: [`integrations/claude-code/README.md`](integrations/claude-code/README.md).

### Chrome

```bash
opencues install chrome
# WSL → Windows Chrome: add `-- --target /mnt/c/Users/<USERNAME>/Desktop/opencues-chrome`
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the dir the install command printed → hard-refresh your test page. Optionally install the native-messaging host for live `~/.cues/` sync + script execution:

```bash
# Copy the extension ID from chrome://extensions first
opencues install chrome-host --extension-id <id>
```

Full doc: [`integrations/chrome/README.md`](integrations/chrome/README.md).

### Others

| Integration | Install | Doc |
|---|---|---|
| OpenCode | `opencues install opencode` (offers a contained bun install) | [`integrations/opencode/README.md`](integrations/opencode/README.md) |
| Gemini CLI | `opencues install gemini-cli` | [`integrations/gemini-cli/README.md`](integrations/gemini-cli/README.md) |
| Shell (standalone) | `opencues install shell` (offers contained bun + tmux) | [`integrations/shell/README.md`](integrations/shell/README.md) |

After install, run `opencues doctor` to verify everything's wired (bundled-runtime versions, feature backends per platform, install boundaries). And `opencues update` later checks npm + rebuilds every detected integration in one command.

## Try it out

Once installed, open any of the five hosts and try:

- `_` (a bare blank) → free-form lookup. Type `capital of france _` and watch it resolve.
- `improve prompt _` after any draft prompt → the transform blank rewrites it.
- `opencues settings _` → the live settings selector.
- Any word the shipped tips pack recognizes (e.g. `ultrathink`) → cycles alternatives with Ctrl+Alt+Up/Down.

Full walkthrough with more examples: see the main [README](README.md) and [`docs/features/README.md`](docs/features/README.md).

## Stuck?

```bash
opencues doctor           # cross-host install diagnostics + suggested fixes
tail /tmp/opencues.log    # everything the runtime logged
```

If cycling does nothing on Linux, your desktop is probably eating Ctrl+Alt+arrow as a workspace-switch binding. Unbind it in your DE settings (one-liners for GNOME/KDE/Sway/macOS are in [`docs/install.md`](docs/install.md#linuxwayland-workspace-conflict)).

For per-host installs, deeper troubleshooting, and uninstall: [`docs/install.md`](docs/install.md).
