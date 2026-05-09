---
last_updated: 2026-04-26
---

# Claude Code Patches

The patch sources that get compiled into [tweakcc](https://github.com/Piebald-AI/tweakcc) and applied to Claude Code's `cli.js`. tweakcc is just our patcher tool — every stock tweakcc patch is disabled, only the OpenCues wiring lands.

## Quick install (preferred)

From the cloned opencues repo:

```bash
pnpm install
pnpm exec opencues install claude-code
# or with explicit cli.js path:
pnpm exec opencues install claude-code --target /path/to/cli.js
```

## Install pipeline

`opencues install claude-code` runs two scripts in order:

1. **`opencues seed-configs --silent`** (top-level CLI, owns shared `~/.cues/` writes)
   - First-time copy of `defaults/{cues,blanks}.md + OPENCUES.md + cues/ + blanks/ + scripts/` → `~/.cues/`
   - Sync of library files (`.sh` / `.cs` / `.ps1`) from `defaults/{blanks,scripts}/` — overwrites stale, never overwrites `.md`
   - Self-heal: re-seed a 0-byte `~/.cues/OPENCUES.md` (would otherwise silently break `opencues ___` blank-fills)
   - Compile colocated `.cs` → `.exe` (WSL only — `BrightCtl.exe`, `VolCtl.exe`, `SpeakCtl.exe`)

2. **`integrations/claude-code/patches/setup.sh`** (CC-specific only)
   - Default behavior: nuke + rebuild from scratch (`~/claude-code-cues/{node_modules/@anthropic-ai, node_modules/@opencues, .cues/}`). `--keep-state` flag skips the nuke for dev iteration.
   - `npm install @anthropic-ai/claude-code` — pinned to exact version 2.1.110 (no caret) so cli.js is bit-identical every install.
   - `git clone tweakcc` into `<CC_FORK>/.opencues/tweakcc/` — the patcher lives inside the fork too (compact footprint).
   - Patch tweakcc's `types.ts` (add OpenCues fields), `defaultSettings.ts` (set OpenCues defaults + flip `showTweakcc{Version,PatchesApplied}` to false), `src/patches/index.ts` (wire `writeOpenCuesRuntimeV2` into the orchestrator + disable every other tweakcc patch).
   - Build `@opencues/{core,runtime}` and install into `<CC_FORK>/node_modules/@opencues/`.
   - Install statusline.sh into `<CC_FORK>/.opencues/statusline.sh`.
   - Auto-fix `~/.claude/settings.json`'s `statusLine.command` if it points at a stale path.
   - Build tweakcc + **verify** dist contains the wiring (fail loud if missing).
   - Apply tweakcc to cli.js + **verify** cli.js contains `@opencues/runtime` (fail loud if seam-miss).

The whole pipeline is rocksolid against drift because:

- **CC version pinned exact** — no `^` allows npm to upgrade past 2.1.110
- **Tweakcc cloned fresh per install** — no stale state can accumulate
- **Two verification gates** — build + apply both checked at install time

## Install times

| Path | Cold (no caches) | Warm (caches present) |
|---|---|---|
| Default (from-scratch) | ~3-4 min | **~1m 5s** |
| `--keep-state` (dev only) | n/a | **~39s** |

`--keep-state` skips `rm -rf` + `npm install @anthropic-ai/claude-code` + `git clone tweakcc` + `npm install` of tweakcc deps. Use it when iterating on patch source files. The default (always-from-scratch) is the rocksolid path.

## What gets shipped

After a successful install, the patched cli.js contains exactly:
- The OpenCues boot injection (`@opencues/runtime` require + dispatchKey wiring at the S1/S3/S6 seams)
- Nothing else from tweakcc

No `verbose-property` token-count modification, no `opusplan1m` model option, no `thinker-symbol-*` spinner customization, no `worktree-mode` commands, no banner. Users who want tweakcc's other features should run stock tweakcc separately against their cli.js.

## Layout

```
integrations/claude-code/patches/
├── setup.sh                  # CC-specific install pipeline (called by opencues install)
├── opencuesRuntime.ts        # The patch source — boot + blankInvoke wiring at S1/S3/S6
└── highlight-statusline.sh   # CC's statusline command — copied to <CC_FORK>/.opencues/statusline.sh
```

Cross-host scripts (`speak.sh`, `SpeakCtl.cs`, brightness/volume helpers) live under `defaults/blanks/<name>/` and `defaults/scripts/`, NOT here — they're managed by `opencues seed-configs` and shared by every native host (CC + OC).

## Manual installation (fallback)

If `opencues install claude-code` fails for some reason, you can run setup.sh directly:

```bash
cd ~/opencues
pnpm install
pnpm build       # builds @opencues/core + @opencues/runtime
integrations/claude-code/patches/setup.sh
```

That runs the same nuke-and-rebuild flow. Pass `--keep-state` for incremental.

## Features

After installation:

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Cycle alternatives, step blank values (configurable increment) |
| Escape | Clear highlight |

Words with LLM alternatives appear dimmed. Type `_` for fill-in-the-blank.

## Dependencies

- **`@opencues/core`** + **`@opencues/runtime`** — built from `packages/` and installed to `<CC_FORK>/node_modules/@opencues/`
- **GROQ_API_KEY** — API key for Groq (default provider)

## See Also

- [`@opencues/core`](../../../packages/opencues-core/) — the LLM analysis library
- [`@opencues/runtime`](../../../packages/opencues-runtime/) — the host-agnostic runtime + adapter bands
- [Full documentation](../docs/) — implementation guides and references
- [`integrations/claude-code/README.md`](../README.md) — user-facing install + verify + uninstall + blast-radius
