# OpenCues for VS Code

LLM word alternatives, `_`-gated blank fill-ins, and auditors in
VS Code's prose editors (markdown, plaintext, git commit messages, and
any language you allowlist). Decoration-based rendering, status-bar
tips, full blank support — no fork, no patched files.

## Install

### Prerequisites

- Node 18+ and pnpm (for building from the repo clone)
- VS Code 1.85+ (desktop; WSL/SSH remotes supported — the extension
  runs remote-side)
- An LLM API key (Groq by default): `opencues set-key groq` or
  `export GROQ_API_KEY=...`

### Install command

```bash
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues && pnpm install
pnpm exec opencues install vscode
```

Then reload VS Code windows (`Developer: Reload Window`) and open a
markdown file.

### Custom extensions dir

```bash
node integrations/vscode/bin/install.cjs install --extensions-dir /path/to/extensions
```

### Verbose output

Install logs to `/tmp/opencues-install-vscode.log`.

## Run

There is nothing to launch — VS Code loads the extension. `opencues run
vscode` drift-checks the bundle (rebuilding if the repo's source
changed since install) and prints the reload step.

## Uninstall

```bash
opencues uninstall vscode
```

Removes the staged runtime, the bundle, and the extensions-dir
symlinks. `~/.cues/` (your configs) is never touched. Reload VS Code
windows to deactivate.

## Verify

- Status bar shows a `$(lightbulb)` tip when a cue is highlighted.
- `opencues doctor` → VS Code section all green.
- Type `weather london _` in a markdown file.

## Configuration

Settings (`Ctrl+,` → search "opencues"):

| Setting | Default | Meaning |
|---|---|---|
| `opencues.enabled` | `true` | Master switch for this window |
| `opencues.languages` | `markdown, plaintext, git-commit, restructuredtext, latex` | Language IDs OpenCues attaches to. Prose only by default — `_` is an identifier character in code |
| `opencues.maxCueDocumentWords` | `500` | Above this word count, word-cue/sentence-cue analysis is disabled (blanks and `_`-invoked rewrites keep working). `0` disables the gate |

Keybindings (only active while a cue is navigable — multi-cursor and
other defaults are untouched otherwise):

| Key | Action |
|---|---|
| `Ctrl+Alt+←` / `→` | Navigate between cues |
| `Ctrl+Alt+↑` / `↓` | Cycle alternatives |
| `Escape` | Dismiss the highlight |

Cue/blank configs are the shared `~/.cues/` (+ `<workspace>/.cues/`
for project-level) — the same files every OpenCues host reads.
Hot-reload applies within ~2s of an edit.

## Where things live (blast radius)

| Path | What |
|---|---|
| `integrations/vscode/node_modules/@opencues/` | Staged runtime + core + drift marker |
| `integrations/vscode/dist/` | The esbuild extension bundle |
| `~/.vscode/extensions/opencues.opencues-vscode` | Symlink → this folder (also `~/.vscode-server/…` on remotes) |
| `~/.cues/` | Shared user configs — seeded on install, NEVER removed by uninstall |

No VS Code files are modified; uninstall reverts everything above
except `~/.cues/`.

## Update workflow

`git pull` then `opencues run vscode` (drift self-heal rebuilds
automatically) or `opencues install vscode`, then reload windows.

## See also

- [`PLAN.md`](PLAN.md) — design decisions + risk register
- [`CLAUDE.md`](CLAUDE.md) — dev notes, manual test pass
- [`docs/features/`](../../docs/features/) — feature reference
