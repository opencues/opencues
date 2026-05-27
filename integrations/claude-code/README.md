# OpenCues for Claude Code

> Part of **[OpenCues](../../README.md)**. Other integrations:
> [OpenCode](../opencode/README.md) · [Gemini CLI](../gemini-cli/README.md) ·
> [Chrome](../chrome/README.md) · [Shell](../shell/README.md).

`@opencues/claude-code` — patches Claude Code's CLI via [tweakcc](https://github.com/Piebald-AI/tweakcc) to add real-time word alternatives, blanks, and cue-blanks inline in your prompts.

> **tweakcc is just our patcher tool.** Every stock tweakcc patch (verbose-property, opusplan1m, thinker-symbol-*, worktree-mode, the launch banner, etc.) is disabled — only the OpenCues v2 wiring lands in cli.js. Users who want tweakcc's other features should run stock tweakcc separately.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | Claude Code 2.1.x — tested on 2.1.110 (cli.js shape) and 2.1.150 (native bun-binary shape, 2.1.113+ cutover). Patch source is the same for both; tweakcc 4.0.13+ handles `.bun` ELF extract/repack. |
| Source | `integrations/claude-code/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed to `~/claude-code-cues/node_modules/@opencues/`) |

---

## Install

### Prerequisites

You need the `opencues` CLI on PATH. If you haven't set that up yet,
follow [Quickstart → Bootstrap the `opencues` CLI](../../README.md#2-bootstrap-the-opencues-cli)
in the root README — that covers Node, pnpm, the clone, and the
shell alias. The rest of this guide assumes `opencues` runs.

### Install command

```bash
opencues install claude-code
```

That clones a pinned `@anthropic-ai/claude-code` into
`~/claude-code-cues/` and patches it in place. Your native `claude`
install is never touched.

### Custom fork location

If your `claude` CLI lives at a non-standard path:

```bash
opencues install claude-code --target /path/to/cli.js
```

The installer (`opencues install claude-code`) chains two scripts:

1. **`opencues seed-configs --silent`** (shared `~/.cues/` writes — used by all native hosts)
   - First-time copy of `defaults/{cues,blanks,opencues}.md + cues/ + blanks/ + scripts/` → `~/.cues/`
   - Sync of library files (`.sh` / `.cs` / `.ps1`) every install — overwrites stale, never overwrites your `.md` edits
   - Self-heal a 0-byte `~/.cues/OPENCUES.md`
   - Compile colocated `.cs` → `.exe` (WSL only)

2. **CC-specific setup.sh** (default behavior: nuke + rebuild from scratch)
   - `npm install @anthropic-ai/claude-code` — pinned to exact version (2.1.110 for the cli.js fork at `~/claude-code-cues/`; 2.1.150+ for the native-binary fork at `~/claude-code-cues-150/`). See [UPGRADING.md](UPGRADING.md) for the cross-shape install dance.
   - Clones tweakcc into `<CC_FORK>/.cues/tweakcc/` (the patcher lives inside the fork)
   - Builds + installs `@opencues/{core,runtime}` into `<CC_FORK>/node_modules/@opencues/`
   - Installs `statusline.sh` into `<CC_FORK>/.cues/`
   - Patches tweakcc to wire OpenCues v2 + disable every stock patch
   - Builds tweakcc + verifies dist contains v2 wiring (fail loud if not)
   - Applies tweakcc to cli.js + verifies the boot landed (fail loud if not)

**Install times**: ~1m 5s warm (default) / ~3-4 min cold (first install on a fresh machine).
For dev iteration on patch sources, use `--keep-state` (skips nuke + npm install + git clone) → ~39s.

> **Future:** post-publish, the same script runs as `npx @opencues/claude-code`. Same flags, same behaviour.

---

## Verify

After install, restart `claude-cues` (or whichever Claude CLI you patched) and try:

| Test | What it checks |
|---|---|
| Type `[your draft question] improve prompt _` | **Prompt-improver blank** — the headline daily-driver: rewrites your rough prompt into a structured one before you send it to Claude. |
| Type `[your draft] add a paragraph about security _` | **Transform blank** — extends your existing draft with the requested addition, in place. |
| Type `format as bullet points _ apples bananas oranges` | **Transform blank** — formatting instruction with surrounding content. |
| Type `opencues settings _`, cycle Up | **Selector / satellite** — slide-out for runtime settings (voice-mode, tips-mode, …). |
| Type `i want to ultrathink this`, Ctrl+Alt+Right to `ultrathink`, Ctrl+Alt+Up | **Word cycle** with tooltip — the shipped `ultrathink` cue offers Tab / deep thinking / think harder. |
| Type `volume _` | Scripted system blank — proves the spawn-process path works (auto-fills with current OS volume). |

If any of these fail, tail `/tmp/opencues.log` in another shell — the runtime writes diagnostics there regardless of whether the TUI swallows stderr.

---

## Configuration — where your `.md` files live

OpenCues reads configs from **one or more `.cues/` directories** in priority order:

| Source | Location | Purpose |
|---|---|---|
| `$OPENCUES_HOME` env var | wherever you set it | Top-priority override (CI / power users / dotfiles repo) |
| Project-level | `<cwd>/.cues/` | Per-project overrides — cd into your project, those configs apply |
| User-level | `~/.cues/` | Global defaults — apply everywhere unless overridden |

Project-level wins on name conflicts (cue source name, blank mode name, blank name). Hot-reload polls every search path on every keystroke — edit any file, changes take effect within ~2s.

**Each directory has the same shape:**
```
.cues/
├── CUES.md          word sources + LLM prompts
├── BLANKS.md        cue-blank declarations
├── OPENCUES.md      settings / state (voice-mode, tips-mode, etc.)
├── cues/            folder-based cue sources (one folder per source)
│   └── <name>/CUE.md
└── blanks/          folder-based cue-blank configs
    └── <name>/BLANK.md
```

**Seed `~/.cues/` from the repo's defaults:**

```bash
pnpm exec opencues seed-configs
```

Idempotent — copies any file that doesn't already exist at the destination, skips files you've already created. Preview first with `-- --dry-run`.

**Per-project example:**

```bash
mkdir -p ~/projects/legal-review/.cues/cues/legal-doc
cat > ~/projects/legal-review/.cues/cues/legal-doc/CUE.md <<'EOF'
---
match: \b(plaintiff|defendant|tort|estoppel)\b
---
Suggest formal legal alternatives, prefer Latin terminology where appropriate.
EOF

cd ~/projects/legal-review
claude-cues
# .cues/cues/legal-doc/CUE.md is now active alongside ~/.cues defaults
```

The OpenCues Settings blank (`OPENCUES.md` → `voice-mode`, `tips-mode`, etc.) is **user-level only** — the runtime reads/writes `~/.cues/OPENCUES.md` (or `$OPENCUES_HOME/OPENCUES.md` when set), seeded from `defaults/OPENCUES.md` by `opencues seed-configs` and self-healed (re-seeded if empty) by every `opencues install <host>` run.

---

## Update workflow

```bash
cd opencues
git pull
pnpm install                              # picks up dep changes
pnpm exec opencues install claude-code             # rebuilds + redeploys
# Restart claude-cues
```

`.md` config files (`CUES.md`, `BLANKS.md`, `cues/*`, `blanks/*`) hot-reload within ~2s on the next keystroke — no install needed for config edits.

---

## What gets installed where

**Compact footprint: everything CC-specific lives inside the CC fork dir** (e.g. `~/claude-code-cues/`). One directory = one CC blast radius.

```
~/claude-code-cues/                 (CC fork — npm-installed locally, single CC blast radius)
├── package.json                    pin @anthropic-ai/claude-code: "2.1.110" or "2.1.150" (exact, no caret)
├── node_modules/
│   ├── @anthropic-ai/claude-code/cli.js   patched in place
│   └── @opencues/
│       ├── core/                  built @opencues/core (CueResolver, parsers, sources)
│       └── runtime/               built @opencues/runtime (Navigation, Cycling, BlankFill)
└── .cues/
    ├── statusline.sh              CC's statusline command (absolute path baked into
    │                              ~/.claude/settings.json — works from any cwd)
    ├── tweakcc/                   our patcher tool (re-cloned every install)
    └── patch-state/               tweakcc's config + cli.js.backup

~/.cues/                        (USER-LEVEL — shared by CC + OpenCode)
├── CUES.md, BLANKS.md, OPENCUES.md   user-editable config (never overwritten)
├── cues/<name>/CUE.md             folder-based cue configs
├── blanks/<name>/               folder-based cue-blanks — colocated with their helpers:
│   ├── brightness/                  BLANK.md + brightness.sh + BrightCtl.exe + brightness-set.ps1
│   ├── volume/                      BLANK.md + volume.sh + VolCtl.exe
│   └── opencues/                    CUE.md + opencues-blank.sh
└── scripts/                       shared utilities (speak.sh + SpeakCtl.exe — TTS for all hosts)
```

**Compact, decoupled, predictable**:
- Uninstalling CC (`rm -rf ~/claude-code-cues`) doesn't break OC — it reads `~/.cues/` independently
- TTS works on OC even if CC was never installed (`~/.cues/scripts/speak.sh` is shared)
- `require("@opencues/runtime")` from cli.js resolves via Node's standard upward `node_modules` walk — no symlinks
- The statusline path in `~/.claude/settings.json` is absolute, so it works from every project you launch claude-cues in

**Runtime state** (NOT created by install — appears when CC runs):
- `/tmp/opencues.log`
- `/tmp/opencues-status-<pid>.json`
- `/tmp/opencues-cursor-state-<pid>.json`

These are runtime IPC files; OS rotates `/tmp/`.

---

## Removing

```bash
pnpm exec opencues uninstall claude-code
```

Reverts `cli.js` from the backup in `~/claude-code-cues/.cues/patch-state/`, then removes `~/claude-code-cues/.cues/` entirely. Two operations, one dir to clean. Preview first with `--dry-run`.

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — overall repo shape + stage tracker
- [`integrations/claude-code/docs/`](docs/) — feature reference (navigation, cycling, alternatives, blanks, status line, etc.)
- [`integrations/claude-code/patches/README.md`](patches/README.md) — patch architecture + development notes
- [`CLAUDE.md`](../../CLAUDE.md) — internal project notes including the `claude-cues` vs `claude` install distinction
