# OpenCues

<!-- Badges: uncomment when ready
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/opencues/opencues/actions/workflows/ci.yml/badge.svg)](https://github.com/opencues/opencues/actions)
[![GitHub](https://img.shields.io/github/stars/opencues/opencues?style=social)](https://github.com/opencues/opencues)
[![Discord](https://img.shields.io/discord/DISCORD_ID?label=Discord)](https://discord.gg/INVITE)
-->

An open standard for real-time guidance as you type. OpenCues works on top of any text input — LLM prompts, word processors, mobile keyboards — providing alternatives, suggestions, and context before you press enter. Define all behaviour in `.md` config files; integrations bring them to life.

<!-- ![Demo](assets/demo.gif) -->

## Why OpenCues?

Most writing tools suggest after you submit. OpenCues suggests *while* you type — word by word, in real time. Navigate to any word, see alternatives, cycle through them, and keep typing. It's an open standard, not a product: define your cues in `.md` files, and any editor integration brings them to life.

- **Editor-agnostic** — the standard lives in config files, not code
- **Real-time** — suggestions appear as you type, not after
- **Extensible** — add new word sources, blank modes, or hardware controls with just a config file
- **Local-first** — runs on your machine, your API keys, your data

## Supported Editors

| Editor | Status | Integration | Compatible with |
|--------|--------|-------------|-----------------|
| **Claude Code** | Available | `integrations/claude-code/` (via [tweakcc](https://github.com/Piebald-AI/tweakcc) patches) | Claude Code 2.1.110+ |
| **OpenCode** | Available | `integrations/opencode/` (TUI patches) | OpenCode 1.4.x |
| **Chrome** | Beta | `integrations/chrome/` (MV3 extension) | Chrome 121+ |
| **VS Code** | Planned | Extension | — |

## The Standard

OpenCues is built on `.md` config files — monolithic or folder-based. All prompts, modes, and behaviour live here, not in code.

| Config | What it defines | Example |
|--------|----------------|---------|
| **cues.md** | Word tips and LLM prompt sources for word alternatives | `### grammar` with synonym/opposite/creative prompt |
| **blanks.md** | Fill-in-the-blank modes with prompt + parser per mode | `### math` with `parser: compute` |
| **controls.md** | Cue-controls — words that trigger external scripts | `"volume"` runs a volume control script |
| **cues/{name}/cue.md** | Folder-based word source (config in frontmatter, prompt in body) | `cues/legal/cue.md` for legal terminology |
| **controls/{name}/** | Self-contained control with colocated script | `controls/volume/cue.md` + `volume.sh` |

Integrations read these files via `@opencues/core` (the reference implementation in pure TypeScript). Folder-based configs are auto-discovered and merge with monolithic files (folder wins on name conflict). To build an integration for a new editor, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Install

**Prerequisites:** Node.js 18+, [pnpm](https://pnpm.io), a [Groq API key](https://console.groq.com) (free), plus the host editor you want to integrate with.

```bash
# Get a Groq key on PATH before launching the host editor
echo 'export GROQ_API_KEY="your-key"' >> ~/.bashrc && source ~/.bashrc

# Clone + install (one time)
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues
pnpm install
pnpm build

# Install the integration you want
pnpm exec opencues install claude-code     # patches Claude Code (or: claude, cc)
pnpm exec opencues install opencode        # patches an OpenCode 1.4.x fork
pnpm exec opencues install chrome          # builds the MV3 extension
pnpm exec opencues install --all           # all three

# Launch (claude-code + opencode only — chrome auto-loads in browser)
pnpm exec opencues run claude-code
pnpm exec opencues run opencode
```

| Integration | Install command | Compatible with | Launch |
|---|---|---|---|
| **Claude Code** | `opencues install claude-code` | Claude Code 2.1.110+ | `opencues run claude-code` (or just `claude-cues` once on PATH) |
| **OpenCode** | `opencues install opencode` | OpenCode 1.4.x | `opencues run opencode` |
| **Chrome** | `opencues install chrome` | Chrome 121+ | Load unpacked at `chrome://extensions` (path printed by installer) |

For per-host details (paths it touches, uninstall, troubleshooting): see each integration's README under `integrations/<host>/README.md`.

### What each install does

Every `opencues install <host>` is one command, end-to-end — no manual `bun install` / `cargo build` / extra setup after.

| Host | Steps the installer runs | Runnable with `opencues run <host>` after? |
|---|---|---|
| `claude-code` | Clone tweakcc (if missing) + build our runtime + install under `~/.claude/opencues/` + patch `cli.js` in place | ✓ (runs `claude-cues` / `claude`) |
| `opencode` | Clone the fork + `bun install` fork deps + build our runtime + install into fork's `node_modules/@opencues/` + patch 3 TSX files | ✓ (runs `bun run dev` in the fork) |
| `chrome` | Build MV3 extension + copy dist/ to `--target` if provided | ✗ — load unpacked at `chrome://extensions` yourself |
| `codex` | Clone the fork + build Rust bridge crate + drop launch helper | **Pre-alpha** — TUI patches still TODO, see `integrations/codex/HANDOFF.md` |

### Where things land

| Path | Purpose |
|---|---|
| `~/.claude/opencues/` | Everything `@opencues/claude-code` owns — `core/`, `runtime/`, `scripts/`, `patch-state/`, `tips.json`, `statusline.sh`. Uninstall is `rm -rf` of this dir + `cli.js` revert. |
| `~/claude-code-cues/` | Local Claude Code install the integration patches (optional — auto-detects a native install too) |
| `~/opencode-cues/` | OpenCode fork the integration clones + patches |
| `~/codex-cues/` | Codex fork the integration clones + patches |
| `~/.opencues/` | User-level configs — `cues.md`, `blanks.md`, `controls.md`, `opencues.md`, plus `cues/` and `controls/` folders. Read by every host. |
| `<cwd>/.opencues/` | Project-level config overrides. Read by native hosts (claude-code, opencode, codex) automatically via cwd. **Not by chrome** — opt in with `opencues sync chrome --include <path>`. |
| `<repo>/defaults/` | Seed source for `opencues seed-configs` + Chrome's bake-time defaults. Never read at runtime; it's part of the code pipeline, not user configuration. |
| `/tmp/opencues.log` | Runtime debug log when a patched host runs |

Uninstall is one command per integration: `opencues uninstall <host>` (or `--all`). Run `opencues which` for a live blast-radius view with ✓ / − markers showing what's actually on disk.

## Features

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Step controls (configurable increment), cycle alternatives |
| Escape | Clear highlight |

### What you get

- **Navigation** — move between words with keyboard
- **Visual cues** — words dim when alternatives are available
- **Alternatives** — cycle through synonyms, opposites, creative suggestions
- **Blanks** — type `_` and get completions (`The capital of France is _` → `Paris`)
- **Cue-controls** — `volume` triggers system volume control
- **Control-bound blanks** — `volume _` auto-populates with actual system volume; cycle to change it
- **Step controls** — `1.5f` → `2f` → `2.5f`, works with any suffix (`px`, `em`, `%`)
- **List controls** — `affirmation _` cycles through "I am strong", "I am brave", ... (cycle to `_` to dismiss)
- **Dynamic list controls** — `HN posts _` fetches live Hacker News titles; Up/Down scrolls through them
- **Prompt improver** — `improve prompt _` uses LLM to rewrite your prompt; cycle through 3 improved versions
- **API controls** — `Tokyo weather _` fetches live weather; `Reddit Stock _` fetches stock price
- **Secondary display** — highlighted words show cue-tips
- **Hot-reload config** — edit any `.md` config file and changes take effect in ~2s, no restart needed

> New to the terminology? See [docs/glossary.md](docs/glossary.md) for definitions of cues, blanks, controls, and sources.

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                       OpenCues                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  packages/opencues-core/          Runtime module                │
│  ├── resolver.ts              CueResolver orchestration     │
│  ├── cues-md.ts               Config parser (cues/blanks.md)│
│  ├── node-http-adapter.ts     HTTPS with keep-alive         │
│  └── sources/                 ConfigSource, parsers...      │
│                                                             │
│  integrations/claude-code/patches/       Claude Code integration       │
│  ├── setup.sh                 One-command installer         │
│  ├── wordHighlight.ts         Navigation + rendering        │
│  ├── dynamicHighlight.ts      LLM integration + cycling     │
│  └── cursorStateExport.ts     Cursor position export        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     tweakcc (upstream)                      │
│                                                             │
│  Patch infrastructure — regex-based cli.js modification     │
│  Cloned automatically by setup.sh                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code                            │
│                                                             │
│  Patched cli.js with:                                       │
│  • Word highlight rendering (ANSI codes)                    │
│  • Keyboard handlers (Ctrl+Alt+Arrow)                       │
│  • LLM call on keystroke (debounced)                        │
│  • require("~/.claude/opencues/core")                       │
└─────────────────────────────────────────────────────────────┘
```

## Requirements

OpenCues is a patch layer — each integration attaches to a host that
you run separately. The only universal requirements are Node.js (for
the `opencues` CLI) and an LLM API key; everything else depends on
which editor you're patching.

### As a user (installing an integration)

| Universal | Check |
|-----------|-------|
| Node.js 18+ | `node --version` |
| Groq API key (or any OpenAI-compatible provider) | set `GROQ_API_KEY` or use `opencues set-key groq` |

Per integration — these are the HOST's requirements, which you would
need whether or not you used OpenCues:

| Integration | What you need first | Check |
|-------------|---------------------|-------|
| `claude-code` | Claude Code CLI 2.1.110+ on PATH | `claude --version` |
| `opencode`    | OpenCode fork checkout + [bun](https://bun.sh/) | `bun --version` |
| `codex`       | codex-rs checkout + [Rust toolchain](https://rustup.rs/) | `cargo --version` |
| `chrome`      | Chrome 121+ | `chrome://version` |

A Claude-Code-only user never needs bun or Rust. An OpenCode user needs
bun because OpenCode itself is a bun app, not because OpenCues requires it.

### As a developer (working on OpenCues)

| Universal | Check |
|-----------|-------|
| Node.js 18+ | `node --version` |
| pnpm 8+ | `pnpm --version` |
| Git | `git --version` |
| Groq API key (for LLM smoke tests in `tests/`) | `echo $GROQ_API_KEY` |

Only if you're modifying the patches for a specific integration:

| Touching... | Extra tool |
|-------------|-----------|
| `integrations/opencode/` patches | bun |
| `integrations/codex/` crates | Rust toolchain (1.75+) |
| `integrations/chrome/` extension | (none — pure TS/rollup) |
| `integrations/claude-code/` patches | (none — pure TS via tweakcc) |

Run `pnpm install && pnpm build` once after cloning; then work on each
integration's patches using the per-integration README under
`integrations/<host>/`.

## Packages

### `@opencues/core`

Pure TypeScript module for LLM-based text analysis. No I/O dependencies. Source: `packages/opencues-core/`.

- **CueResolver** — orchestrates multiple sources, merges results
- **ConfigSource** — generic config-driven LLM source (one per `###` section in `.md` files)
- **ClassifiedSourceGroup** — wraps blank modes with fast/LLM classification
- **ControlBlankSource** — bridges blanks with cue-controls (auto-populate + cycling)
- **buildSourcesFromConfig** — factory: parses `cues.md` + `blanks.md` + controls → `CueSource[]`
- **NodeHttpAdapter** — HTTPS with connection keep-alive, ~200ms latency to Groq

### `@opencues/runtime`

Host-agnostic runtime + per-host adapter bands. Source: `packages/opencues-runtime/`.

- Modules: Navigation, Cycling, BlankFill, DimRender, Statusline, TTS, ConfigLoader, ...
- State classes: HighlightState, DynDefs, SpanFillState, etc.
- Adapter bands: `adapters/cc/v2.1/`, `adapters/oc/v1.4/`, `adapters/chrome/v1/`
- Hoisted controls: `src/controls/` (StocksControl, WeatherControl, HackerNewsControl, etc.)

### Per-host integrations

- `integrations/claude-code/` — Claude Code (tweakcc patches; runtime installed to `~/.claude/opencues/`)
- `integrations/opencode/` — OpenCode (clone fork at pinned SHA + bootstrap copy)
- `integrations/chrome/` — Chrome MV3 extension (esbuild bundle + popup)

Each is its own npm-publishable package (`@opencues/claude-code`, `@opencues/opencode`, `@opencues/chrome`).

## Status line (optional)

Shows the highlighted word and its tip in Claude Code's status bar:

```
agents (1/3) - Spawn parallel workers via Task tool
```

**Enable:** Run `/statusline` in Claude Code and set the command to:
```
~/.claude/opencues/statusline.sh
```

**Disable:** Run `/statusline` again and clear the command.

See [status line docs](integrations/claude-code/docs/status-line.md) for details.

## Configuration

Settings are in `~/.tweakcc/config.json`:

```json
{
  "misc": {
    "enableWordHighlight": true,
    "enableDynamicHighlight": true,
    "highlightMode": "words",
    "numberDimming": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enableWordHighlight` | `true` | Enable Ctrl+Alt+Arrow navigation |
| `enableDynamicHighlight` | `true` | Enable LLM alternatives |
| `highlightMode` | `"words"` | `"numbers"` or `"words"` |
| `numberDimming` | `true` | Dim step-pattern matches in gray |
| `highlightExportEnabled` | `true` | Write highlight state JSON for status line |

## Updating

```bash
cd ~/opencues
pnpm exec opencues update    # pulls, rebuilds, redeploys every detected install
```

For per-host re-install only: `pnpm exec opencues install <host>` re-runs the integration's full install pipeline.

## Removing

`uninstall` reverts the patches each integration applied to its host.
It does **not** touch your user configs, the cloned OpenCues repo, or
(for OpenCode) the OpenCode fork itself — those stay put so you can
re-install without losing settings.

```bash
pnpm exec opencues uninstall claude-code   # reverts cli.js + removes ~/.claude/opencues/
pnpm exec opencues uninstall opencode      # git checkout 3 patched files + removes fork node_modules entries
pnpm exec opencues uninstall chrome        # removes integrations/chrome/dist + (if --target was used) the deploy
pnpm exec opencues uninstall --all         # all three
```

Preview any of these with `--dry-run` before executing. `opencues which`
shows every path that would be affected, before or after.

### Fully removing OpenCues from your machine

`uninstall` only handles the host-side patches. To go further, clean
each layer explicitly:

```bash
# 1. Revert host patches (as above)
pnpm exec opencues uninstall --all

# 2. Remove user-level configs (voice-mode, tips, custom cues, ...)
rm -rf ~/.opencues

# 3. Remove the OpenCues clone itself
rm -rf ~/opencues

# 4. (OpenCode only) remove the OpenCode fork dir — uninstall leaves
#    this in place because it's your OpenCode checkout, not ours
rm -rf ~/opencode-cues      # or whatever --target you used
```

### If uninstall partially fails

The OpenCode uninstall reverts three patched files with `git checkout --`.
If the fork's working tree is dirty (you edited those files), git will
refuse and the uninstaller logs the skipped file. Stash or commit your
changes, then re-run `opencues uninstall opencode`. The other two
integrations (`claude-code`, `chrome`) are idempotent — re-running is
safe.

### Disable individual features

Per-feature gates live in `~/.tweakcc/config.json` under `misc.*` (e.g. `enableWordHighlight`, `enableDynamicHighlight`, `highlightExportEnabled`). Toggle to `false` and restart the patched binary.

## Troubleshooting

See [FAQ.md](FAQ.md) for common questions on install, uninstall, where
things live, and per-integration paths.

### Diagnostics

```bash
pnpm exec opencues doctor              # full cross-host install + env check with suggested fixes
pnpm exec opencues which               # every relevant path with ✓ / -
pnpm exec opencues logs --tail         # follow /tmp/opencues.log
pnpm exec opencues check-keys          # verify GROQ_API_KEY / FINNHUB_API_KEY actually work
```

### Words don't turn gray

Work through these in order:

1. **Did you restart the host editor?** Patches only take effect after a restart.
2. **Is the API key on PATH?** `export GROQ_API_KEY=...` in a terminal session is not enough — the host won't see it unless it's in `~/.bashrc` (and you've started a new session since adding it). `pnpm exec opencues check-keys` validates configured keys.
3. **Did install finish successfully?** `pnpm exec opencues doctor` shows what's missing.
4. **Check runtime loaded:** `ls ~/.claude/opencues/runtime/` should list dist files.
5. **Enable debug logging:** `pnpm exec opencues debug on` then tail `opencues logs --tail`.

### Syntax error after patching

```bash
# Restore original
cp ~/.tweakcc/cli.js.backup $(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)

# Re-run setup
~/opencues/integrations/claude-code/patches/setup.sh
```

### setup.sh fails to patch

tweakcc may have changed. Check for pattern matches:

```bash
grep "MiscSettings" ~/tweakcc/src/types.ts
grep "misc:" ~/tweakcc/src/defaultSettings.ts
```

## Extending blanks.md

`blanks.md` ships with 10 blank modes: math, factual, translation, unit conversion, spelling, color codes, HTTP codes, timezone, roman numerals, and grammar. You can add your own.

Each `### section` under `## Prompt` is a blank mode. The system picks which mode to use via a three-stage pipeline:

1. **`match` regex** — instant. If the text matches, that mode is selected immediately.
2. **`keywords`** — instant. Checked if no regex matches.
3. **`### classifier` LLM** — ~200ms fallback for ambiguous inputs.

**When adding a new mode, you must update two things:**

1. Add your `### section` with `match`/`keywords`/`parser`/`priority` and a prompt
2. Update `### classifier` — add examples for your mode AND add it to the `Output ONLY: MODE=...` line

If you skip step 2, inputs that miss your fast-match keywords will silently fall to grammar instead of your new mode. The classifier won't know your mode exists.

**Word sources** in `cues.md` are simpler — all word-scoped `alternatives`-parser sources get combined into a single LLM call automatically. Domain sources should include a `match` regex so the LLM only applies their instructions for matching words. Sources without `match` are treated as base instructions that apply to every word — make sure they don't contradict each other.

See [CONTRIBUTING.md](CONTRIBUTING.md) for full details and pitfalls.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to:
- **Extend the standard** — add new word sources, blank modes, or cue-controls to the `.md` config files
- **Build an integration** — bring OpenCues to a new editor or tool using opencues-core
- **Improve opencues-core** — modify the core library, run tests, submit changes

New to OpenCues? The [glossary](docs/glossary.md) explains all terminology — cues, blanks, cue-controls, sources, parsers, and more.

<!-- ## Community

- [Discord](https://discord.gg/INVITE) — questions, feedback, feature requests
- [GitHub Discussions](https://github.com/opencues/opencues/discussions) — ideas, Q&A
-->
- [Twitter/X](https://x.com/openCues_) — announcements
<!-- - [Reddit](https://www.reddit.com/r/OpenCues/) — community (private until launch) -->

## License

<!-- TODO: Switch to open-source license before launch -->
Proprietary. All rights reserved. See [LICENSE](LICENSE).
