# OpenCues for OpenCode

`@opencues/oc` — patches an [OpenCode](https://github.com/sst/opencode) TUI fork to add real-time word alternatives, blanks, and cue-controls inline in your prompts. Native rendering via the TUI's syntax-highlighting layer.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | OpenCode 1.4.x (pinned to v1.4.11 / SHA `5e9d5c7`) |
| Source | `integrations/oc/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (installed into the fork's `node_modules/`) |

---

## Install (from a clone)

```bash
git clone https://github.com/opencues/opencues
cd opencues
pnpm install
pnpm --filter @opencues/oc dev-install
```

By default the installer clones the OpenCode fork to `$HOME/opencode-cues`. To install against an existing fork at a different path:

```bash
pnpm --filter @opencues/oc dev-install -- --target /path/to/your/opencode-fork
```

The installer:
1. Clones `sst/opencode` at the pinned SHA into the target dir (or reuses an existing clone)
2. Builds `@opencues/core` + `@opencues/runtime` (turbo-cached)
3. Copies built artefacts into the fork's `node_modules/@opencues/{core,runtime}/`
4. Copies `opencuesBootstrap.ts` into the fork's TUI source as `opencues.ts`
5. Patches `app.tsx`, `component/prompt/index.tsx`, and `feature-plugins/home/footer.tsx` via Python sed-style edits (idempotent)

> **Future:** post-publish, the same script runs as `npx @opencues/oc`. Same flags, same behaviour.

---

## Run the patched fork

```bash
cd ~/opencode-cues       # or your --target dir
bun install
bun run dev
```

Watch `/tmp/opencues.log` in a second shell for the boot line:

```
[HH:MM:SS][info] OpenCues runtime starting (OpenCode v1.4)
```

---

## Verify

| Test | What it checks |
|---|---|
| Type `5f`, position cursor on it, Up/Down | Numeric cycling: `5f → 5.5f → 6f` |
| Type `voice-mode active`, cycle Up | Selector/satellite via the `@opencues/runtime` settings control |
| Type `weather _ paris` | LLM/HTTP control: fills with current Paris weather |
| Status bar at bottom of TUI shows tip when a word is highlighted | `opencuesTip()` SolidJS signal wired into `home/footer.tsx` |

If something fails, the runtime writes diagnostics to `/tmp/opencues.log`.

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
pnpm --filter @opencues/oc seed-configs
```

Idempotent — copies any file that doesn't already exist at the destination, skips files you've already created. Preview first with `-- --dry-run`.

**Per-project example:**

```bash
mkdir -p ~/projects/contract-review/.opencues
cat > ~/projects/contract-review/.opencues/cues.md <<'EOF'
## Prompt
### legal
match: \b(plaintiff|defendant|tort|estoppel)\b
---
Suggest formal legal alternatives, prefer Latin terminology where appropriate.
EOF

cd ~/projects/contract-review
bun run dev   # in your opencode-cues fork
# .opencues/cues.md is now active alongside ~/.opencues defaults
```

The OpenCues Settings control (`opencues.md` → `voice-mode`, `tips-mode`, etc.) follows the same precedence: project file wins, else user file (auto-created on first write).

---

## Update workflow

```bash
cd opencues
git pull
pnpm install
pnpm --filter @opencues/oc dev-install   # rebuilds + redeploys into fork
cd ~/opencode-cues && bun run dev        # restart the fork
```

`.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/*`, `controls/*`) hot-reload within ~2s on the next keystroke. Set `OPENCUES_HOME` to point at a non-default config root if you keep your configs separately from the repo.

---

## What gets installed where

| Path | Contents |
|---|---|
| `<fork>/node_modules/@opencues/core/` | Built `@opencues/core` |
| `<fork>/node_modules/@opencues/runtime/` | Built `@opencues/runtime` |
| `<fork>/packages/opencode/src/cli/cmd/tui/opencues.ts` | Bootstrap copy (the `opencuesBootstrap.ts` source) |
| `<fork>/packages/opencode/src/cli/cmd/tui/app.tsx` | Patched: mounts the runtime + forwards keyboard events |
| `<fork>/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | Patched: publishes textarea ref + onContentChange handler |
| `<fork>/packages/opencode/src/cli/cmd/tui/feature-plugins/home/footer.tsx` | Patched: renders OpenCues tip alongside MCP status |

The fork itself stays a regular OpenCode checkout — you can `git pull upstream` and reapply patches as long as the file shapes haven't shifted dramatically.

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — repo layout + stage tracker
- [`integrations/oc/patches/opencuesBootstrap.ts`](patches/opencuesBootstrap.ts) — the actual bootstrap (read for what gets injected)
- [`@opencues/runtime` adapter band](../../packages/opencues-runtime/adapters/oc/v1.4/) — the OC v1.4 host adapter (what `boot()` resolves to)
