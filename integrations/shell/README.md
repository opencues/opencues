# @opencues/shell

> Part of **[OpenCues](../../README.md)**. Other integrations:
> [Claude Code](../claude-code/README.md) · [OpenCode](../opencode/README.md) ·
> [Gemini CLI](../gemini-cli/README.md) · [Chrome](../chrome/README.md).

Wraps your interactive shell in a private tmux session and exposes
an OpenCues input box you can slide up at any time. Type with full
OpenCues support — cues, blanks, cycling, agent-rewrite — and the
result pastes back into the shell at your cursor.

Built on Bun + OpenTUI + SolidJS. The system tmux is never touched;
a private one is vendored under `~/.opencues/vendor/tmux/`.

---

## Installation

### Prerequisites

You need the `opencues` CLI on PATH. If you haven't set that up yet,
follow [Quickstart → Bootstrap the `opencues` CLI](../../README.md#2-bootstrap-the-opencues-cli)
in the root README — that covers Node, pnpm, the clone, and the
shell alias.

This integration also needs:

- **Bun** ≥ 1.0 — the input box is a Bun + OpenTUI app:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- A C toolchain for building tmux 3.4 from source. The first run of
  `oc-install-tmux` (below) probes for what's missing; install the
  package manager equivalents of `gcc`, `make`, `pkg-config`,
  `bison`, `libevent-dev`, `libncurses-dev`.

### Install command

```bash
opencues install shell
```

That builds `@opencues/{core,runtime}`, stages them into the
integration's local `node_modules`, installs OpenTUI via Bun, and
(optionally) symlinks the user-facing commands into a `PATH`
location.

### Putting commands on your `PATH`

```bash
opencues install shell --link ~/.local/bin
```

Three executables get symlinked:

| Command | Purpose |
|---|---|
| `oc-shell` | Launch the wrapped shell session. |
| `oc-install-tmux` | Build the vendored tmux 3.4 into `~/.opencues/vendor/tmux/`. Run once before your first `oc-shell`. |
| `oc-install-shell-integration` | Optional. Wires up the *capture current readline buffer on Alt+Shift+↑* behaviour by writing a snippet to `~/.opencues/shell-integration.{bash,zsh,fish}` and appending one source line to your rc. |

All other binaries (`oc-edit`, `oc-popup`, `oc-shell-init`,
`oc-open-input`, `oc-editd`) are internal — `oc-shell` extends its
own `PATH` to reach them, so they never appear on yours.

### First-time setup

```bash
# 1. Build the vendored tmux 3.4 (~30 seconds, one-time)
oc-install-tmux

# 2. (Optional) capture-current-line shell integration
oc-install-shell-integration
```

---

## Usage

```bash
oc-shell
```

You get your normal `$SHELL` prompt in your current directory. A
brand bar at the very bottom of the terminal advertises the active
chords.

### Keybindings

All advertised chords live on **Alt+Shift+arrow** — your fingers stay
on one modifier group across contexts:

| Chord | Action |
|---|---|
| **Alt+Shift+↑** | Open the OpenCues input box. With shell-integration installed, the line you were typing at the prompt is captured + cleared and seeded as initial text. |
| **Alt+Shift+↓** | Cancel: close the input box. If a line was captured on open, it's restored to your shell prompt. |
| **Alt+Shift+→** | Submit: paste the textarea contents into the shell prompt. |
| **Alt+Shift+←** | Exit `oc-shell`, returning you to your original terminal. |

Unadvertised aliases (do the same thing without crowding the bar):
`Ctrl+S` / `Ctrl+Alt+S` (submit), `Esc` / `Ctrl+Q` / `Ctrl+Alt+Q`
(cancel), `Ctrl+Alt+X` (exit), `F2` (open — fallback for emulators
that swallow Alt+Shift+↑).

Inside the input box, every OpenCues binding works as in the other
host integrations: type and watch cues highlight, `_` triggers blank
lookup, **Ctrl+Alt+↑/↓** cycles a word's alternatives, etc.

### Try it out

Useful first-things-to-try inside the input box, after submitting
they paste into your shell prompt:

| Type | What happens |
|---|---|
| `[Your prompt] improve prompt _` | Rewrites your rough text into a structured prompt. Submit to send it to whichever CLI you're about to invoke. |
| `[Your prompt] add a paragraph about security _` | Extends your existing text with the requested addition, in place. |
| `[your list] format as bullet points _` | Formats the body as bullets. Useful when composing a markdown comment / commit message before pasting. |
| `[your text] translate to french _` | Replaces with the French translation. |
| `opencues settings _` | Slide-out selector for runtime settings — cycle a setting with Ctrl+Alt+Right/Left, cycle the value with Ctrl+Alt+Up/Down. |

---

## Configuration

`@opencues/shell` reads the same config tree as the other hosts:

```
$OPENCUES_HOME              (env override; top priority)
<cwd>/.cues/                (project-level)
~/.cues/                    (user-level)
```

Inside any of those:

- `OPENCUES.md` — runtime settings (voice-mode, agent-debounce-ms, …)
- `CUES.md` — cue master file (project metadata, tips, ignore, sources)
- `BLANKS.md` — blank-pack master file
- `cues/<name>/CUE.md` — individual cue packs
- `blanks/<name>/BLANK.md` — individual blank packs
- `USER.md` (user-level only) — user context (for the
  `user-context-mode` feature)

A first install seeds defaults into `~/.cues/`:

```bash
opencues seed-configs
```

---

## Uninstall

```bash
opencues uninstall shell
```

Removes the staged `@opencues/{core,runtime}` from this package's
`node_modules` and any symlinks created by `--link`. The vendored
tmux and the shell-integration rc line are left in place — remove
manually if you want them gone:

```bash
rm -rf ~/.opencues/vendor/tmux
# Then edit ~/.bashrc / ~/.zshrc / ~/.config/fish/config.fish to
# remove the line marked "# OpenCues shell-integration".
```

---

## Architecture

See [CLAUDE.md](./CLAUDE.md) for the full design. In short:

- `oc-shell` wraps your `$SHELL` in a private tmux session
  (`-L opencues-<pid>`, `-f conf/oc-shell.tmux.conf`).
- A persistent daemon (`oc-editd`) pre-loads `~/.cues/` and serves
  the parsed config snapshot over a unix socket — the input box
  skips file I/O on every open.
- The input box is a **lazy-spawn tmux pane**: Alt+Shift+↑ runs
  `bin/oc-open-input`, which `split-window`s a 15-row pane below
  the shell running `oc-edit --keep-alive --target-pane <shell pane>`
  (the Bun + OpenTUI host of the OpenCues runtime).
- On submit, `oc-edit` calls `tmux send-keys -t <shell>` to paste,
  then `tmux kill-pane` on itself. The idle layout is just the
  shell + brand bar — no extra rows, no border.

[DAEMON-PLAN.md](./DAEMON-PLAN.md) documents the daemon design.
