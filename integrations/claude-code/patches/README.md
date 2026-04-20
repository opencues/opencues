---
last_updated: 2026-04-20
---

# Claude Code Patches

The patch sources that get compiled into [tweakcc](https://github.com/Piebald-AI/tweakcc) and applied to Claude Code's `cli.js`. Maintained as `.ts` files; tweakcc transpiles + injects them at apply time.

## Quick install (preferred)

From the cloned opencues repo:

```bash
pnpm install
pnpm exec opencues install claude-code
# or with explicit cli.js path:
pnpm exec opencues install claude-code --target /path/to/cli.js
```

The `opencues install claude-code` command runs `setup.sh` (this directory) under the hood. See `integrations/claude-code/README.md` for the user-facing flow.

## What setup.sh does

1. Clones tweakcc from upstream into `integrations/claude-code/tweakcc/`
2. Copies the `.ts` patches into tweakcc's `src/patches/`
3. Patches tweakcc's `types.ts`, `defaultSettings.ts`, and `src/patches/index.ts` (one-time wiring)
4. Builds `@opencues/core` + `@opencues/runtime` (turbo-cached)
5. Installs everything under `~/.claude/opencues/`:
   - `core/`, `runtime/` — built artefacts
   - `tips.json`, `statusline.sh`, `actions/` — supporting files
   - `patch-state/` — tweakcc config + `cli.js.backup` (via `TWEAKCC_CONFIG_DIR` override)
6. Builds tweakcc with the patches compiled in
7. Applies the patches to the detected `cli.js` (auto-finds under `~/.claude` or `~/claude-code-cues`; explicit path via `--target`)

## Contents of this directory

```
patches/
├── setup.sh                  # The install pipeline (called by opencues install claude-code)
├── opencuesRuntime.ts        # Boot + controlInvoke wiring (the v2.x patch)
├── cursorStateExport.ts      # Exports cursor position to JSON
├── wordHighlight.ts          # Ctrl+Alt navigation, numbers, rendering
├── dynamicHighlight.ts       # LLM alternatives, cycling, spans
├── types-additions.ts        # Reference: types added to tweakcc's MiscSettings
├── defaultSettings-additions.ts  # Reference: defaults added to tweakcc
├── index-additions.ts        # Reference: wiring added to tweakcc src/patches/index.ts
├── actions/                  # OS-bound scripts copied to ~/.claude/opencues/scripts/
│   ├── speak.sh, brightness.sh
│   ├── BrightCtl.cs, SpeakCtl.cs   # WSL: compiled to .exe by setup.sh
│   └── brightness-set.ps1
├── highlight-statusline.sh   # Status-line script copied to ~/.claude/opencues/statusline.sh
└── claude-code-tips.json     # Per-word tips JSON copied to ~/.claude/opencues/tips.json
```

## Manual installation (fallback)

If `opencues install claude-code` fails for some reason, you can run the setup script directly:

```bash
cd ~/opencues
pnpm install
pnpm build       # builds @opencues/core + @opencues/runtime
integrations/claude-code/patches/setup.sh ~/opencues/integrations/claude-code/tweakcc
```

If your Claude Code install is at a non-standard path (e.g. WSL `claude-cues`):

```bash
CLI_JS=/home/$USER/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js
TWEAKCC_CONFIG_DIR=~/.claude/opencues/patch-state \
  TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" \
  node ~/opencues/integrations/claude-code/tweakcc/dist/index.mjs --apply
```

## Features

After installation:

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Step controls (configurable increment), cycle alternatives |
| Escape | Clear highlight |

Words with LLM alternatives appear dimmed. Type `_` for fill-in-the-blank.

## Dependencies

- **`@opencues/core`** + **`@opencues/runtime`** — built from `packages/` and installed to `~/.claude/opencues/`
- **GROQ_API_KEY** — API key for Groq (default provider)

## See Also

- [`@opencues/core`](../../../packages/opencues-core/) — the LLM analysis library
- [`@opencues/runtime`](../../../packages/opencues-runtime/) — the host-agnostic runtime + adapter bands
- [Full documentation](../docs/) — implementation guides and references
- [`integrations/claude-code/README.md`](../README.md) — user-facing install + verify + uninstall + blast-radius
