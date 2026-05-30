# Install walkthrough — every integration end-to-end

This walks through the install experience for each of the five
integrations, **counting every user touch** required from
"never-heard-of-OpenCues" to "OpenCues works." For each integration:

- What `opencues install <host>` does internally
- What the user has to do (clicks, prompts, copies)
- Remaining seams + why they exist

Assumes a fresh machine with no OpenCues anywhere. Each section
starts at `npm install -g opencues`.

---

## Common preamble (every integration)

```bash
npm install -g opencues
```

What npm does at install time:
- Checks `engines.node >=18` — refuses on older Node.
- Checks `os` is `darwin` or `linux` — refuses on Windows native (use WSL).
- Drops the `opencues` binary into `$(npm prefix -g)/bin/`.

**User touches**: 1 (the npm install command).

---

## 1. Claude Code

```bash
opencues install claude-code
```

What the installer does, in order:

| Step | Action | User input |
|---|---|---|
| 1 | Cross-platform preflight — detect missing tools, print warnings | none unless TTY |
| 2 | (If TTY) offer to `sudo apt install …` any system tools you skipped | optional [Y/n] |
| 3 | `seed-configs --silent` — copies defaults into `~/.cues/`, compiles WSL `.exe` shims | none |
| 4 | `npm install @anthropic-ai/claude-code` pinned (2.1.110 / 2.1.150) into `~/claude-code-cues/` | none |
| 5 | Clones `tweakcc` into `<fork>/.cues/tweakcc/` | none |
| 6 | Builds `@opencues/{core,runtime}` + installs into fork | none |
| 7 | Installs `statusline.sh` into `<fork>/.cues/` | none |
| 8 | Applies tweakcc patches to `cli.js` (or native binary on 2.1.113+) | none |
| 9 | Verifies the patch landed | none |
| 10 | Prints `▸ verify your environment supports every feature: opencues doctor` | none |

```bash
claude-cues   # launch the patched fork; native `claude` untouched
```

**User touches**: 1 (the install command). Plus 0-2 optional Y/n prompts if the preflight finds system gaps.

**Time**: ~1m 5s warm, ~3-4 min cold.

**Seams**: none. The fork is fully contained at `~/claude-code-cues/`; uninstall is `rm -rf` of that dir plus a tweakcc revert.

---

## 2. OpenCode

```bash
opencues install opencode
```

| Step | Action | User input |
|---|---|---|
| 1 | Preflight — detects missing system tools + missing **bun** | none unless TTY |
| 2 | (If TTY + bun missing) offer to install bun into `~/.opencues/vendor/bun/` | optional [Y/n] |
| 3 | `seed-configs --silent` | none |
| 4 | `git clone sst/opencode` pinned SHA → `~/opencode-cues/` | none |
| 5 | `bun install` inside the fork (uses vendored bun if installed) | none |
| 6 | Builds `@opencues/{core,runtime}` + installs into fork | none |
| 7 | Patches 4 TSX files via anchor-based replace | none |
| 8 | Prints doctor hint | none |

```bash
opencues run opencode
```

**User touches**: 1 install command + 0-2 optional Y/n prompts.

**Time**: ~5 min cold (mostly `git clone` + `bun install`), <30s warm re-runs.

**Seams**: none — bun's contained-install path closes the only previous seam. The `~/opencode-cues/` fork itself stays after `opencues uninstall opencode` (it's your checkout of an external repo — same model as cloning any source repo to hack on).

---

## 3. Gemini CLI

```bash
opencues install gemini-cli
```

| Step | Action | User input |
|---|---|---|
| 1 | Preflight | none unless TTY |
| 2 | (If TTY) sudo-install offer for any system gaps | optional [Y/n] |
| 3 | `seed-configs --silent` | none |
| 4 | `git clone google-gemini/gemini-cli` pinned SHA → `~/gemini-cli-cues/` | none |
| 5 | `npm install` inside the fork (ships with Node — no separate dep) | none |
| 6 | Builds + installs `@opencues/{core,runtime}` into fork | none |
| 7 | Patches 3 TSX + esbuild config via anchor-based replace | none |
| 8 | `npm run build` — compiles patched sources into `packages/cli/dist/` | none |
| 9 | Prints doctor hint | none |

```bash
opencues run gemini-cli
```

**User touches**: 1 install command + 0-2 optional Y/n prompts.

**Time**: ~5 min cold, <60s warm.

**Seams**: none — Gemini's only dep is npm (which ships with Node) + git. Pure-clone-and-patch model, like opencode but without the bun requirement.

---

## 4. Chrome

```bash
opencues install chrome
```

| Step | Action | User input |
|---|---|---|
| 1 | Preflight | none unless TTY |
| 2 | Builds the MV3 extension (`typecheck` + `test` + `esbuild`) into `integrations/chrome/dist/` | none |
| 3 | (If `--wsl` or `--target <path>`) copies `dist/` + `manifest.json` to the target | none |
| 4 | Prints the path to load + `chrome://extensions` instructions | none |
| 5 | Prints doctor hint | none |

**Then the unavoidable manual part** (Chrome's design — there's no automation API for unpacked extension load):

| Step | Action | User input |
|---|---|---|
| a | Open `chrome://extensions` | 1 click |
| b | Toggle "Developer mode" | 1 click |
| c | Click "Load unpacked" | 1 click |
| d | Pick the path the installer printed | 1 selection |

Optional: install the native-messaging host for live `~/.cues/` sync + script execution:

```bash
# Copy the extension ID from chrome://extensions (it's a 32-char string)
opencues install chrome-host --extension-id <id>
```

| Step | Action | User input |
|---|---|---|
| 1 | Per-platform manifest written (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` on macOS, `~/.config/google-chrome/NativeMessagingHosts/` on Linux, `%LOCALAPPDATA%\opencues\` via `/mnt/c/` on WSL) | none |
| 2 | WSL: registers `.bat` shim in HKCU registry via `wsl.exe -d <distro> --shell-type login` | none |
| 3 | Marks host script executable | none |

**User touches**: 1 install command + 4 Chrome UI clicks + (optional) 1 extension-ID copy + 1 native-messaging-host install command = **5-7 total**.

**Seams**:
- **Unpacked load** (4 clicks in Chrome). This is fundamentally a Chrome design choice — no extension can install another extension. **Closes when we ship to the Chrome Web Store** (1 click instead of 4). Tracked under the pre-launch checklist.
- **Extension ID copy** for `chrome-host`. The ID is generated by Chrome the first time you load unpacked, so we genuinely don't know it until step (d) of the manual flow. **Closes with Web Store** (the ID becomes known + permanent).

---

## 5. Shell (`oc-shell`)

```bash
opencues install shell
```

| Step | Action | User input |
|---|---|---|
| 1 | Preflight — detects missing **tmux**, **bun**, system audio tools, TTS engines, brightness tools, sandbox confiner | none unless TTY |
| 2 | (If TTY + tools missing) offer to `sudo apt install …` system gaps in one batched command | optional [Y/n] |
| 3 | (If TTY + bun missing) offer to install bun into `~/.opencues/vendor/bun/` | optional [Y/n] |
| 4 | `seed-configs --silent` | none |
| 5 | Builds `@opencues/{core,runtime}` + stages into integration's `node_modules/` | none |
| 6 | `bun install` for OpenTUI/Solid deps | none |
| 7 | (NEW) Auto-runs `oc-install-tmux` if no usable tmux is on PATH and no vendored tmux exists. Tries prebuilt tarball first; falls through to source build if none available for the platform | none (unless source build needs deps it doesn't have, in which case it prints the apt/brew command) |
| 8 | (If `--link`) symlinks `oc-shell` + `oc-install-tmux` + `oc-install-shell-integration` to the target dir | none |
| 9 | Prints doctor hint | none |

```bash
oc-shell   # launch the wrapped shell with the OpenCues input box
```

**Optional one-time** (capture-current-line behaviour on Alt+Shift+↑):

```bash
oc-install-shell-integration   # appends one source line to ~/.bashrc/.zshrc/fish config
```

**User touches**: 1 install command + 0-2 optional Y/n prompts + (optional, ~10s) the shell-integration command.

**Time**: ~30s if prebuilt tmux exists for the platform; ~1-2 min if source build is needed.

**Seams**:
- **Prebuilt tmux not yet published** — the URL is wired but the GitHub release at `opencues/opencues/releases/tag/tmux-prebuilt-3.4` is empty today. Until someone runs the CI matrix (see `docs/install/tmux-prebuilt.md`), Linux/macOS users hit the source-build path which requires `gcc`/`make`/`libevent-dev`/`libncurses-dev`/`bison`/`pkg-config`. The build-deps are auto-detected and the apt/brew command is printed; user runs one `sudo apt install` then re-runs `opencues install shell`.
- **Shell-integration step is opt-in** — the capture-current-line behaviour requires a one-line addition to the user's rc. We don't auto-add it because rc modifications are user territory; the prompt makes it visible.

---

## Side-by-side seam count

| Integration | User commands | Optional Y/n prompts | Manual external UI | Seams |
|---|---|---|---|---|
| **claude-code** | 1 (`install`) | 0-1 (sudo-install offer if Linux deps missing) | none | none |
| **opencode** | 1 | 0-2 (sudo + bun) | none | none |
| **gemini-cli** | 1 | 0-1 | none | none |
| **chrome** | 1-2 (`install chrome` + optional `chrome-host`) | 0-1 | **4 Chrome clicks + extension-ID copy** | unpacked load (closes with Web Store) |
| **shell** | 1 | 0-2 (sudo + bun) | none | prebuilt tmux not yet published (closes with the CI matrix) |

## What "seamless" looks like end-state

For 4 of 5 integrations (everything except Chrome's pre-launch state):

```
$ npm install -g opencues
$ opencues install <host>
  ▸ macOS preflight — runtime notes for this install:
     ... [table]
  ▸ Install missing tools? [Y/n] y
  ▸ Install bun to ~/.opencues/vendor/bun/? [Y/n] y
  ✓ <host>
  ▸ verify your environment supports every feature: opencues doctor
$ <launch-command>
```

**Total touches**: 1 npm command + 1 install command + 1-2 Y/n keystrokes + 1 launch command = **3-5 user actions**.

For Chrome, add the unpacked-load 4 clicks (one-time per machine). For everything, add an LLM API key:

```bash
echo 'export CEREBRAS_API_KEY="csk-..."' >> ~/.bashrc
exec $SHELL -l
```

That's the floor. Every further reduction needs an external action by us — Web Store listing, prebuilt tmux release, future bundling of Bun.

---

## Remaining seams + the path to close each

| Seam | Where | How to close |
|---|---|---|
| Chrome unpacked-load (4 clicks) | Pre-launch | Submit to Chrome Web Store; user gets 1-click install. |
| Chrome extension-ID copy for host | Pre-launch | Web Store gives a stable public ID we hard-code into `chrome-host` install. |
| Prebuilt tmux not yet published | Tmux integration | Run the CI matrix in `docs/install/tmux-prebuilt.md`, upload 4 tarballs to a release. |
| LLM API key | Universal | We don't ship one; users get their own. Could offer the OpenCode Zen free-mode default for blanks-only zero-key onboarding (already supported, off by default). |
| Linux audio backend (`pactl`/`wpctl`/`amixer`) | Universal | Genuine — these are clients to user's audio daemon. Best we can do: detect + use. |
| Linux backlight permissions | `brightness _` blank | Genuine — `/sys/class/backlight/*` writes need setuid or udev. We can't bypass. |

The first three are tractable infrastructure work. The last three are either universal product decisions or genuine system-level constraints.
