# OpenCues for Claude Code

`@opencues/claude-code` — patches Claude Code's CLI via [tweakcc](https://github.com/Piebald-AI/tweakcc) to add real-time word alternatives, blanks, and cue-controls inline in your prompts.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | Claude Code 2.1.110+ (2.1.x line) |
| Source | `integrations/claude-code/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed to `~/.claude/opencues/`) |

---

## Install (from a clone)

```bash
git clone https://github.com/opencues/opencues
cd opencues
pnpm install
pnpm --filter @opencues/claude-code dev-install
```

If your `claude` CLI lives at a non-standard path (e.g. you use [`claude-cues`](../../CLAUDE.md#claude-installs) at `~/claude-code-cues/`):

```bash
pnpm --filter @opencues/claude-code dev-install -- \
  --target ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js
```

The installer:
1. Builds `@opencues/core` + `@opencues/runtime` (turbo-cached)
2. Installs both under **one dir**: `~/.claude/opencues/`
3. Builds tweakcc with the patches under `patches/`
4. Applies patches to the detected `cli.js` (backup at `~/.claude/opencues/patch-state/cli.js.backup`)

> **Future:** post-publish, the same script runs as `npx @opencues/claude-code`. Same flags, same behaviour.

---

## Verify

After install, restart `claude-cues` (or whichever Claude CLI you patched) and try:

| Test | What it checks |
|---|---|
| Type `5f`, position cursor on it, Ctrl+Alt+Up | Numeric cycling: `5f → 5.5f → 6f` |
| Type `voice-mode active`, cycle Up | Selector/satellite + `@opencues/runtime` settings control |
| Type `weather _ paris` | LLM/HTTP control: fills with current Paris weather |
| Cycle any cyclable word | TTS announces the cycled value (uses `~/.claude/opencues/scripts/speak.sh`) |
| Verify highlighted word shows tip in the status bar | Statusline export → `highlight-statusline.sh` |

If any of these fail, tail `/tmp/opencues.log` in another shell — the runtime writes diagnostics there regardless of whether the TUI swallows stderr.

---

## Configuration — where your `.md` files live

OpenCues reads configs from **one or more `.opencues/` directories** in priority order:

| Source | Location | Purpose |
|---|---|---|
| `$OPENCUES_HOME` env var | wherever you set it | Top-priority override (CI / power users / dotfiles repo) |
| Project-level | `<cwd>/.opencues/` | Per-project overrides — cd into your project, those configs apply |
| User-level | `~/.opencues/` | Global defaults — apply everywhere unless overridden |

Project-level wins on name conflicts (cue source name, blank mode name, control name). Hot-reload polls every search path on every keystroke — edit any file, changes take effect within ~2s.

**Each directory has the same shape:**
```
.opencues/
├── cues.md          word sources + LLM prompts
├── blanks.md        blank-fill modes
├── controls.md      cue-control declarations
├── opencues.md      settings / state (voice-mode, tips-mode, etc.)
├── cues/            folder-based cue sources (one folder per source)
│   └── <name>/cue.md
└── controls/        folder-based control configs
    └── <name>/cue.md
```

**Seed `~/.opencues/` from the repo's defaults:**

```bash
pnpm --filter @opencues/claude-code seed-configs
```

Idempotent — copies any file that doesn't already exist at the destination, skips files you've already created. Preview first with `-- --dry-run`.

**Per-project example:**

```bash
mkdir -p ~/projects/legal-review/.opencues/cues/legal-doc
cat > ~/projects/legal-review/.opencues/cues/legal-doc/cue.md <<'EOF'
---
match: \b(plaintiff|defendant|tort|estoppel)\b
---
Suggest formal legal alternatives, prefer Latin terminology where appropriate.
EOF

cd ~/projects/legal-review
claude-cues
# .opencues/cues/legal-doc/cue.md is now active alongside ~/.opencues defaults
```

The OpenCues Settings control (`opencues.md` → `voice-mode`, `tips-mode`, etc.) follows the same precedence: project file wins, else user file (auto-created on first write).

---

## Update workflow

```bash
cd opencues
git pull
pnpm install                              # picks up dep changes
pnpm --filter @opencues/claude-code dev-install    # rebuilds + redeploys
# Restart claude-cues
```

`.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/*`, `controls/*`) hot-reload within ~2s on the next keystroke — no install needed for config edits.

---

## What gets installed where

**Everything @opencues/claude-code owns lives under one dir:**

```
~/.claude/opencues/
├── core/                 built @opencues/core (CueResolver, parsers, sources)
├── runtime/              built @opencues/runtime (Navigation, Cycling, BlankFill, controls/)
├── tips.json             pre-computed word tips (read by ConfigLoader)
├── statusline.sh         status-line script (wire via /statusline)
├── actions/              OS-bound scripts (speak.sh, brightness.sh) + WSL .exe shims
└── patch-state/        tweakcc's config + cli.js.backup
                          (redirected from ~/.tweakcc/ via TWEAKCC_CONFIG_DIR)
```

Plus `<cli.js>` itself is patched in place. Backup lives inside `~/.claude/opencues/patch-state/`.

**Runtime state** (NOT created by install — appears when CC runs):
- `/tmp/opencues.log`
- `/tmp/opencues-highlight-state-<pid>.json`
- `/tmp/opencues-cursor-state.json`

These are runtime IPC files; OS rotates `/tmp/`.

---

## Removing

```bash
pnpm --filter @opencues/claude-code dev-uninstall -- \
  --target ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js
```

Reverts `cli.js` from the backup in `~/.claude/opencues/patch-state/`, then removes `~/.claude/opencues/` entirely. Two operations, one dir to clean. Preview first with `--dry-run`.

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — overall repo shape + stage tracker
- [`integrations/claude-code/docs/`](docs/) — feature reference (navigation, cycling, alternatives, blanks, status line, etc.)
- [`integrations/claude-code/docs/architecture.md`](docs/architecture.md) — patch architecture + development notes
- [`CLAUDE.md`](../../CLAUDE.md) — internal project notes including the `claude-cues` vs `claude` install distinction
