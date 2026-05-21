# OpenCues for Claude Code

`@opencues/claude-code` — patches Claude Code's CLI via [tweakcc](https://github.com/Piebald-AI/tweakcc) to add real-time word alternatives, blanks, and cue-blanks inline in your prompts.

> **tweakcc is just our patcher tool.** Every stock tweakcc patch (verbose-property, opusplan1m, thinker-symbol-*, worktree-mode, the launch banner, etc.) is disabled — only the OpenCues v2 wiring lands in cli.js. Users who want tweakcc's other features should run stock tweakcc separately.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | Claude Code 2.1.110+ (2.1.x line) |
| Source | `integrations/claude-code/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed to `~/claude-code-cues/node_modules/@opencues/`) |

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

The installer (`opencues install claude-code`) chains two scripts:

1. **`opencues seed-configs --silent`** (shared `~/.cues/` writes — used by all native hosts)
   - First-time copy of `defaults/{cues,blanks,opencues}.md + cues/ + blanks/ + scripts/` → `~/.cues/`
   - Sync of library files (`.sh` / `.cs` / `.ps1`) every install — overwrites stale, never overwrites your `.md` edits
   - Self-heal a 0-byte `~/.cues/OPENCUES.md`
   - Compile colocated `.cs` → `.exe` (WSL only)

2. **CC-specific setup.sh** (default behavior: nuke + rebuild from scratch)
   - `npm install @anthropic-ai/claude-code` — pinned to exact version 2.1.110
   - Clones tweakcc into `<CC_FORK>/.opencues/tweakcc/` (the patcher lives inside the fork)
   - Builds + installs `@opencues/{core,runtime}` into `<CC_FORK>/node_modules/@opencues/`
   - Installs `statusline.sh` into `<CC_FORK>/.opencues/`
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
| Type `volume _`, cycle Up | Cue-blank: auto-populates with system volume, Up/Down changes it |
| Type `opencues settings _`, cycle Up | Selector/satellite via the `OpenCuesSettingsBlank` runtime class |
| Type `weather _ paris` | LLM/HTTP cue-blank: fills with current Paris weather |
| Cycle any cyclable word | TTS announces the cycled value (uses `~/.cues/scripts/speak.sh` — shared by all native hosts) |
| Verify highlighted word shows tip in the status bar | Statusline export → `highlight-statusline.sh` |

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
pnpm --filter @opencues/claude-code seed-configs
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
pnpm --filter @opencues/claude-code dev-install    # rebuilds + redeploys
# Restart claude-cues
```

`.md` config files (`CUES.md`, `BLANKS.md`, `cues/*`, `blanks/*`) hot-reload within ~2s on the next keystroke — no install needed for config edits.

---

## What gets installed where

**Compact footprint: everything CC-specific lives inside the CC fork dir** (e.g. `~/claude-code-cues/`). One directory = one CC blast radius.

```
~/claude-code-cues/                 (CC fork — npm-installed locally, single CC blast radius)
├── package.json                    pin @anthropic-ai/claude-code: "2.1.110" (exact, no caret)
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
- `/tmp/opencues-highlight-state-<pid>.json`
- `/tmp/opencues-cursor-state.json`

These are runtime IPC files; OS rotates `/tmp/`.

---

## Removing

```bash
pnpm --filter @opencues/claude-code dev-uninstall -- \
  --target ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js
```

Reverts `cli.js` from the backup in `~/claude-code-cues/.opencues/patch-state/`, then removes `~/claude-code-cues/.opencues/` entirely. Two operations, one dir to clean. Preview first with `--dry-run`.

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — overall repo shape + stage tracker
- [`integrations/claude-code/docs/`](docs/) — feature reference (navigation, cycling, alternatives, blanks, status line, etc.)
- [`integrations/claude-code/patches/README.md`](patches/README.md) — patch architecture + development notes
- [`CLAUDE.md`](../../CLAUDE.md) — internal project notes including the `claude-cues` vs `claude` install distinction
