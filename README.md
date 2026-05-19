# OpenCues

<!-- Badges: uncomment when ready
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/opencues/opencues/actions/workflows/ci.yml/badge.svg)](https://github.com/opencues/opencues/actions)
[![GitHub](https://img.shields.io/github/stars/opencues/opencues?style=social)](https://github.com/opencues/opencues)
[![Discord](https://img.shields.io/discord/DISCORD_ID?label=Discord)](https://discord.gg/INVITE)
-->

An open standard for real-time guidance as you type. OpenCues works on top of any text input — LLM prompts, word processors, mobile keyboards — providing alternatives, suggestions, and context before you press enter. Define all behaviour in `.md` config files; integrations bring them to life.

> **In 30 seconds — the vocabulary**
>
> - **Cue** — a word the runtime offers alternatives for. You navigate to it with Ctrl+Alt+arrow and cycle synonyms with Ctrl+Alt+Up/Down. The buffer stays as you typed it until you cycle.
> - **Blank** — a `_` you type. The runtime auto-fills it (`volume _` → `70%`, `capital of france _` → `Paris`, `enable debug logging _` → `debug-mode on`). Each blank is gated by a keyword or by free-form lookup.
> - **Auditor** — an inline rewriter that composes with other auditors (grammar, clarity, tone, ...) into one LLM call per agent tick.
>
> Everything else in this README assumes these three.

<!-- TODO: drop a demo gif at assets/demo.gif and uncomment the line below. ~10s loop of: type "the happy dog" → cycle "happy", then type "volume _" → see "70%", then type "enable debug logging _" → see "debug-mode on". -->
<!-- ![Demo](assets/demo.gif) -->

## Why OpenCues?

Most writing tools suggest after you submit. OpenCues suggests *while* you type — word by word, in real time. Navigate to any word, see alternatives, cycle through them, and keep typing. It's an open standard, not a product: define your cues in `.md` files, and any editor integration brings them to life.

- **Editor-agnostic** — the standard lives in config files, not code
- **Real-time** — suggestions appear as you type, not after
- **Extensible** — add new word sources, blank modes, or hardware-bound blanks with just a config file
- **Local-first** — runs on your machine, your API keys, your data

## Supported Editors

| Editor | Status | Integration | Compatible with |
|--------|--------|-------------|-----------------|
| **Claude Code** | Available | `integrations/claude-code/` (via [tweakcc](https://github.com/Piebald-AI/tweakcc) patches) | Claude Code 2.1.110+ |
| **OpenCode** | Available | `integrations/opencode/` (TUI patches) | OpenCode 1.4.x |
| **Chrome** | Beta | `integrations/chrome/` (MV3 extension) | Chrome 121+ |
| **Gemini CLI** | Beta | `integrations/gemini-cli/` (TSX source patches) | Gemini CLI 0.41.x |
| **VS Code** | Planned | Extension | — |

## The Standard

OpenCues is built on `.md` config files — three master files plus folder-based sources. All prompts, modes, and behaviour live here, not in code. Three surfaces: **cues** (system→user, suggested over plain text), **blanks** (user→system, gated by `_`), **auditors** (system→buffer, composed inline rewrites).

| Config | What it defines | Example |
|--------|----------------|---------|
| **OPENCUES.md** | Runtime settings (voice-mode, tips-mode, debug-mode, cursor-navigate, surface enable flags, LLM routing). User-level only. | `voice-mode: active`, `transform-blank-mode: on` |
| **CUES.md** | Cue-surface master: project metadata + `ignore:` (words never cued) + `disable:` (skip cue ids at this layer). | `name: my-project`, `disable: [spelling]` |
| **BLANKS.md** | Blank-surface master: project metadata + `ignore:` + `disable:` for blank ids. | `disable: [stocks]` |
| **AUDITORS.md** | Auditor-surface master: project metadata + `disable:` for auditor ids. | `disable: [grammar]` |
| **cues/{name}/CUE.md** | Folder-based cue source. Static cues put a JSON words map in the body; LLM cues declare `match:`/`keywords:` and put the prompt in the body. | `defaults/cues/legal/CUE.md` for legal terminology, `defaults/cues/grammar/CUE.md` with a synonym prompt |
| **blanks/{name}/BLANK.md** | Folder-based blank with optional colocated script or runtime class. | `defaults/blanks/volume/BLANK.md` + `volume-blank.sh` |
| **auditors/{name}/AUDITOR.md** | Inline-rewrite concern (grammar, clarity, tone, ...) — body is the prompt fragment. Multiple auditors compose into one LLM call per agent tick. | `defaults/auditors/grammar/AUDITOR.md` |

Integrations read these files via `@opencues/core` (the reference implementation in pure TypeScript). Folder-based configs are auto-discovered. To build an integration for a new editor, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Try it in 5 minutes

Quickest path to a patched Claude Code with cues live. Replaces five separate commands with one chain you can paste:

```bash
# 1. Free LLM key — Groq's free tier covers every feature.
#    https://console.groq.com/keys to grab one. Set it BEFORE step 2:
export GROQ_API_KEY="your-key"
# Or after step 2 (works on any shell, no .bashrc/.zshrc edits):
#   opencues set-key groq your-key  →  writes ~/.cues/.env (chmod 600)

# 2. Clone + bootstrap + patch Claude Code, one chain.
git clone https://github.com/opencues/opencues ~/opencues && \
  cd ~/opencues && pnpm install && pnpm build && \
  pnpm exec opencues install claude-code

# 3. Launch the patched fork.
claude-cues
```

That's it. **Launch with `claude-cues`, not `claude`** — `claude-cues` is the patched fork on your PATH; your existing `claude` install stays untouched.

### Your first three prompts (and what to expect)

Type these into `claude-cues` to confirm the three surfaces are live. Each one should give a visible result inside 1-2 seconds.

| Type | What you should see |
|---|---|
| `the happy dog` | The word **happy** subtly dims (cue marker). Press **Ctrl+Alt+Right** to navigate to it, then **Ctrl+Alt+Up** — the word swaps to `joyful` / `cheerful` / etc. Down to revert. |
| `volume _` | The `_` becomes `70%` (or whatever your system volume is). Ctrl+Alt+Up steps it by 6%. This proves keyword-bound blanks + scripts. |
| `enable debug logging _` | The whole phrase becomes `debug-mode on` (a satellite pair). One backspace wipes both words at once. This proves the fluid-config feature flipped `~/.cues/OPENCUES.md`. |

Once you've seen those three, every other feature works the same way — see § Features for the catalogue.

### Stuck? Run this first

```bash
opencues doctor           # cross-host install diagnostics + suggested fixes
tail /tmp/opencues.log    # everything the runtime logged — boots, LLM calls, errors
opencues which            # what's installed where + which pin
```

If `claude-cues` launches but cues never fire, it's almost always (a) a missing API key, (b) Ctrl+Alt+arrow being eaten by your desktop's workspace switcher (Linux especially), or (c) the runtime didn't boot. `opencues doctor` catches the first; the second needs an OS-level unbind; the third shows up in `/tmp/opencues.log` within seconds of typing.

> **Heads-up:** OpenCues installs a **separate, patched copy of the editor at a pinned version** — it doesn't modify your existing one. Claude Code is pinned to v2.1.110, cloned into `~/claude-code-cues/`, and exposed as `claude-cues` on your PATH. OpenCode is pinned to v1.14.17 (sha `40ba8f3`), cloned into `~/opencode-cues/`. Gemini CLI is pinned to v0.41.2, cloned into `~/gemini-cli-cues/`. All pins live in `integrations/<host>/pin.json`. Your native `claude`, your existing OpenCode install, and your native `gemini` stay untouched. Uninstall (`opencues uninstall <host>`) just removes the patched copy — no rollback work on the originals. See § Where things land for the per-host paths. **No npm/Homebrew package yet** — clone-and-build is the only path until v1 publishes.

## Install

**Prerequisites:** Node.js 18+, [pnpm](https://pnpm.io), at least one LLM provider API key, plus the host editor you want to integrate with.

OpenCues supports **six LLM providers** out of the box: Groq (default — free tier), Cerebras, OpenAI, Anthropic, OpenRouter, and Gemini. Set the env key for whichever you want; pick different ones per feature in `~/.cues/OPENCUES.md` (see [docs/guides/llm-providers.md](docs/guides/llm-providers.md)). Setting both `GROQ_API_KEY` and `CEREBRAS_API_KEY` enables auto-fallback between them.

```bash
# Clone + install (one time)
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues
pnpm install
pnpm build

# Store the API key (works on any shell — writes ~/.cues/.env chmod 600).
# For other providers (cerebras, openai, anthropic, openrouter, gemini)
# set the corresponding env var instead — see docs/guides/llm-providers.md.
pnpm exec opencues set-key groq your-key

# (Or, if you'd rather use env vars in your shell config:
#   bash: echo 'export GROQ_API_KEY="your-key"' >> ~/.bashrc && source ~/.bashrc
#   zsh : echo 'export GROQ_API_KEY="your-key"' >> ~/.zshrc  && source ~/.zshrc
#   fish: set -Ux GROQ_API_KEY your-key)

# Install the integration you want
pnpm exec opencues install claude-code     # patches Claude Code (or: claude, cc)
pnpm exec opencues install opencode        # patches an OpenCode 1.4.x fork
pnpm exec opencues install chrome          # builds the MV3 extension
pnpm exec opencues install chrome-host \
  --extension-id <id-from-chrome-extensions>  # optional — live ~/.cues/ sync
pnpm exec opencues install gemini-cli      # patches a Gemini CLI 0.41.x fork
pnpm exec opencues install --all           # all four (chrome-host is separate)

# Launch (claude-code, opencode, gemini-cli — chrome auto-loads in browser)
pnpm exec opencues run claude-code
pnpm exec opencues run opencode
pnpm exec opencues run gemini-cli
```

| Integration | Install command | Compatible with | Launch |
|---|---|---|---|
| **Claude Code** | `opencues install claude-code` | Claude Code 2.1.110+ | `opencues run claude-code` (or just `claude-cues` once on PATH) |
| **OpenCode** | `opencues install opencode` | OpenCode 1.4.x | `opencues run opencode` |
| **Chrome** | `opencues install chrome` (+ `opencues install chrome-host` for live `~/.cues/` sync) | Chrome 121+ | Load unpacked at `chrome://extensions` (path printed by installer) |
| **Gemini CLI** | `opencues install gemini-cli` | Gemini CLI 0.41.x | `opencues run gemini-cli` |

For per-host details (paths it touches, uninstall, troubleshooting): see each integration's README under `integrations/<host>/README.md`.

### What each install does

Every `opencues install <host>` is one command, end-to-end — no manual `bun install` / `cargo build` / extra setup after.

| Host | Steps the installer runs | Runnable with `opencues run <host>` after? |
|---|---|---|
| `claude-code` | seed-configs (shared `~/.cues/`) + nuke-and-rebuild from scratch inside `~/claude-code-cues/` (clone tweakcc, build runtime + core, patch cli.js, verify). ~1m warm install. tweakcc is just our patcher — every stock tweakcc patch is disabled, only OpenCues v2 wiring lands. | ✓ (runs `claude-cues` / `claude`) |
| `opencode` | Clone the fork + `bun install` fork deps + build our runtime + install into fork's `node_modules/@opencues/` + patch 3 TSX files | ✓ (runs `bun run dev` in the fork) |
| `chrome` | Build MV3 extension + copy dist/ to `--target` if provided | ✗ — load unpacked at `chrome://extensions` yourself |
| `chrome-host` | Drop a local native-messaging host + register it with Chrome (manifest + WSL `.bat` shim + HKCU registry on Windows). Requires `--extension-id <id>` from `chrome://extensions`. After install, edits to `~/.cues/` push into every open tab in ~300ms — no rebuild, no refresh, no `sync chrome --watch` daemon. | ✗ — Chrome spawns the host on demand |
| `gemini-cli` | Clone the fork + `npm install` fork deps + build our runtime + install into fork's `node_modules/@opencues/` + patch 4 source files (3 TSX + esbuild config) + `npm run build` the fork | ✓ (runs `node packages/cli/dist/index.js` from the fork) |

### Where things land

| Path | Purpose |
|---|---|
| `~/claude-code-cues/` | Everything `@opencues/claude-code` owns lives inside this CC fork: `node_modules/@opencues/{core,runtime}/` (runtime), `.cues/{statusline.sh,scripts/,patch-state/}` (support files), and the patched `cli.js`. Uninstall is `rm -rf` of this dir + tweakcc revert. Mirrors OpenCode's compact footprint. |
| `~/opencode-cues/` | OpenCode fork the integration clones + patches |
| `~/gemini-cli-cues/` | Gemini CLI fork the integration clones + patches. `node_modules/@opencues/{core,runtime}/` (runtime) + `packages/cli/src/ui/opencues.ts` (bootstrap) + 4 patched source files. |
| `~/.cues/` | User-level configs — `OPENCUES.md` (runtime settings) plus the three master files (`CUES.md`, `BLANKS.md`, `AUDITORS.md`) and their per-source folders (`cues/`, `blanks/`, `auditors/`). Read by every host. |
| `<cwd>/.cues/` | Project-level config overrides. Read by native hosts (claude-code, opencode, gemini-cli) automatically via cwd. Chrome with the `chrome-host` installed reads `~/.cues/` live (or `$OPENCUES_HOME` if set); without the host, only the extension's bake-time defaults apply. |
| `<repo>/defaults/` | Seed source for `opencues seed-configs` + Chrome's bake-time defaults. Never read at runtime; it's part of the code pipeline, not user configuration. |
| `/tmp/opencues.log` | Runtime debug log when a patched host runs |

Uninstall is one command per integration: `opencues uninstall <host>` (or `--all`). Run `opencues which` for a live blast-radius view with ✓ / − markers showing what's actually on disk.

## Features

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Cycle alternatives, step blank values (configurable increment) |
| Escape | Clear highlight |

### What you get

- **Navigation** — move between words with keyboard
- **Visual cues** — words dim when alternatives are available
- **Alternatives** — cycle through synonyms, opposites, creative suggestions
- **Blanks** — type `_` and get completions (`The capital of France is _` → `Paris`)
- **Cue-blanks** — `volume _` auto-populates with current system volume; Up/Down changes it
- **List blanks** — `affirmation _` cycles through "I am strong", "I am brave", ... (cycle to `_` to dismiss)
- **Dynamic list blanks** — `HN posts _` fetches live Hacker News titles; Up/Down scrolls through them
- **Prompt improver** — `improve prompt _` uses LLM to rewrite your prompt; cycle through 3 improved versions
- **API blanks** — `Tokyo weather _` fetches live weather; `Reddit Stock _` fetches stock price
- **Inline agent** — `agentically correct spelling _` arms a continuous rewrite loop; the agent fixes your text on every typing pause until you `stop task _`. Auditors (`auditors/<name>/AUDITOR.md`) compose into the agent's prompt so the same loop can carry grammar/clarity/tone concerns at once. Statusline shows `[task: <prompt>]` while armed.
- **Secondary display** — highlighted words show cue-tips
- **Hot-reload config** — edit any `.md` config file and changes take effect in ~2s, no restart needed
- **Sandboxed third-party packs** — JS blanks run under a Figma-style capability contract (declared network hosts, per-secret bindings, output sanitization, rate quotas). `opencues review <pack>` audits any pack before install; see [Security](#security)

> New to the terminology? See [docs/glossary.md](docs/glossary.md) for definitions of cues, blanks, cue-blanks, and sources.

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                       OpenCues                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  packages/opencues-core/      LLM analysis library            │
│  ├── resolver.ts              CueResolver orchestration       │
│  ├── cues-md.ts               Config parser (CUES.md, CUE.md, etc.) │
│  ├── node-http-adapter.ts     HTTPS with keep-alive           │
│  └── sources/                 ConfigSource, parsers...        │
│                                                               │
│  packages/opencues-runtime/   Host-agnostic runtime           │
│  ├── src/modules/             Navigation, Cycling, BlankFill, │
│  │                            DimRender, TTS, Statusline,...  │
│  ├── src/blanks/              StocksBlank, WeatherBlank,     │
│  │                            HackerNewsBlank, PromptImprover-│
│  │                            Blank, OpenCuesSettingsBlank... │
│  └── adapters/cc/v2.1/        boot.ts — the CC adapter band   │
│                                                               │
│  integrations/claude-code/patches/      CC integration glue   │
│  ├── setup.sh                 The install pipeline            │
│  ├── opencuesRuntime.ts       v2 patch — injects a thin       │
│  │                            bootstrap that lazy-requires    │
│  │                            @opencues/runtime/.../boot.js   │
│  └── highlight-statusline.sh  CC's statusline command         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                tweakcc (our patcher tool)                   │
│                                                             │
│  Patch infrastructure — regex-based cli.js modification.    │
│  Re-cloned every install into <CC_FORK>/.opencues/tweakcc/. │
│  ALL stock tweakcc patches disabled — only OpenCues v2      │
│  wiring lands in cli.js.                                    │
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
│  • require("@opencues/runtime") — bare specifier resolves   │
│    via the CC fork's own node_modules (no symlinks needed)  │
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

**Recommended for full security on scripted blanks**: install
[bubblewrap](https://github.com/containers/bubblewrap) so blanks
that declare `sandbox: strict` (volume, brightness, anything that
spawns a script) run with OS-level confinement.

| Platform | Install | Status if missing |
|---|---|---|
| Linux / WSL2 | `apt install bubblewrap` (Debian/Ubuntu) / `dnf install bubblewrap` (Fedora) / `pacman -S bubblewrap` (Arch) | Scripted blanks still run but without OS-level confinement. `opencues doctor` flags it. |
| macOS | Already installed (`/usr/bin/sandbox-exec` ships with macOS) | — |
| Windows native | Not yet supported | Strict-sandbox blanks fall back unwrapped |

Run `opencues doctor` after install to confirm everything's wired.

Per integration — these are the HOST's requirements, which you would
need whether or not you used OpenCues:

| Integration | What you need first | Check |
|-------------|---------------------|-------|
| `claude-code` | Claude Code CLI 2.1.110+ on PATH | `claude --version` |
| `opencode`    | OpenCode fork checkout + [bun](https://bun.sh/) | `bun --version` |
| `chrome`      | Chrome 121+ | `chrome://version` |
| `gemini-cli`  | Node 18+ (the install clones a Gemini CLI 0.41.x fork itself) | `node --version` |

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
- **BlankSource** — keyword-bound blank dispatcher (auto-populate + cycling for `volume _`, `stocks aapl _`, etc.)
- **FluidBlankSource** — free-form `_` lookup (P1 segment + P3 answer pipeline) for any unmatched blank
- **RoutedWordSourceGroup** — per-word dispatch of word-cue sources via `match`/`keywords`/priority. Spelling is just a regular ConfigSource cue at `defaults/cues/spelling/CUE.md` shipped at priority 80; no dedicated class.
- **buildSourcesFromConfig** — factory: parses master files (`CUES.md`, `BLANKS.md`, `AUDITORS.md`) + per-source folders (`cues/<name>/CUE.md`, `blanks/<name>/BLANK.md`, `auditors/<name>/AUDITOR.md`) → `CueSource[]`
- **NodeHttpAdapter** — HTTPS with connection keep-alive, ~200ms latency to Groq

### `@opencues/runtime`

Host-agnostic runtime + per-host adapter bands. Source: `packages/opencues-runtime/`.

- Modules: Navigation, Cycling, BlankFill, DimRender, Statusline, TTS, ConfigLoader, ...
- State classes: HighlightState, DynDefs, SpanFillState, etc.
- Adapter bands: `adapters/cc/v2.1/`, `adapters/oc/v1.4/`, `adapters/chrome/v1/`
- Hoisted blanks: `src/blanks/` (StocksBlank, WeatherBlank, HackerNewsBlank, etc.)

### Per-host integrations

- `integrations/claude-code/` — Claude Code (tweakcc patches; runtime + support files installed inside the CC fork at `~/claude-code-cues/`)
- `integrations/opencode/` — OpenCode (clone fork at pinned SHA + bootstrap copy)
- `integrations/chrome/` — Chrome MV3 extension (esbuild bundle + popup)

Each is its own npm-publishable package (`@opencues/claude-code`, `@opencues/opencode`, `@opencues/chrome`, `@opencues/gemini-cli`).

## Status line (optional)

Shows the highlighted word and its tip in Claude Code's status bar:

```
agents (1/3) - Spawn parallel workers via Task tool
```

**Enable:** Run `/statusline` in Claude Code and set the command to:
```
~/claude-code-cues/.opencues/statusline.sh
```

**Disable:** Run `/statusline` again and clear the command.

See [status line docs](integrations/claude-code/docs/status-line.md) for details.

## Configuration

Your user-level OpenCues config lives at `~/.cues/`:

```
~/.cues/
├── OPENCUES.md              # Runtime settings (frontmatter): voice-mode, tips-mode,
│                            # debug-mode, cursor-navigate, fluid-blank-mode,
│                            # transform-blank-mode, word-cues-mode, agent-debounce-ms,
│                            # llm-provider + per-feature LLM keys, nested `settings:`.
├── CUES.md                  # Cue master (project-level overridable). frontmatter only.
├── cues/<name>/CUE.md       # Per-cue folder (legal, medical, financial, spelling, …)
├── BLANKS.md                # Blank master.
├── blanks/<name>/BLANK.md   # Per-blank folder (with optional colocated scripts or runtime classes)
├── AUDITORS.md              # Auditor master.
└── auditors/<name>/AUDITOR.md  # Per-auditor — body is the inline-rewrite prompt fragment
```

Project-level overrides live at `<cwd>/.cues/` and merge on top of user-level for the native hosts (Claude Code, OpenCode). Chrome reads only what `opencues sync chrome` has bundled (user-level by default; opt-in for projects). See `docs/features/chrome-sync.md`.

System settings (in `~/.cues/OPENCUES.md`) — the same scalars are cyclable inside the host via the `opencues` cue-blank:

| Setting | Values | Description |
|---|---|---|
| `voice-mode` | `active` / `inactive` | TTS reads tips aloud on navigation |
| `tips-mode` | `on` / `off` | Show secondary-display tips |
| `debug-mode` | `on` / `off` | Verbose logging in the host's debug surface |
| `cursor-navigate` | `active` / `inactive` | Highlight follows cursor to navigable words |
| `word-cues-mode` | `on` / `off` | LLM word-cue surface (legal, medical, ...) registered |
| `fluid-blank-mode` | `on` / `off` | Free-form `_` lookup pipeline registered |
| `transform-blank-mode` | `on` / `off` | Imperative `_` + agent-task lifecycle (`agentically X _`) registered |
| `agent-debounce-ms` | number (default 1000) | Pause-after-keystroke before the inline agent fires. Misparse → 1000. |

Run `pnpm exec opencues seed-configs` to populate `~/.cues/` from the shipped defaults the first time. Hot-reloads on every edit (~2.5s for native hosts; chrome polls a `.version` hash — see `docs/features/chrome-hot-reload.md`).

CC-specific patch toggles (e.g. `enableWordHighlight`, `numberDimming`) live in tweakcc's config under `~/claude-code-cues/.opencues/patch-state/config.json`. They're rarely changed; defaults work for everyone.

## LLM providers

Every cue surface (word-cues, fluid-blank, transform-blank, agent-rewrite, prompt-improver, answer) makes an OpenAI-shaped chat-completions call. Set `llm-provider` and `llm-model` in `~/.cues/OPENCUES.md` frontmatter, plus the corresponding API-key env var.

### Recommended (any one is enough)

| Provider | Model | Why |
|---|---|---|
| **Groq** | `openai/gpt-oss-120b` | Fastest end-to-end. LPU inference puts inline word-cues comfortably inside the sub-second budget. Free tier covers every OpenCues feature. `GROQ_API_KEY` from [console.groq.com/keys](https://console.groq.com/keys). |
| **Cerebras** | `gpt-oss-120b` | Same model weights as Groq, hosted on wafer-scale silicon. Slightly higher TTFT, marginally better quality on long-prompt surfaces (FluidBlank P1 SEGMENT, AgentRewrite). Pairs with Groq as automatic failover via `withFallback()`. `CEREBRAS_API_KEY`. |
| **Gemini** | `gemini-3.1-flash-lite` | Google's latency-tuned variant. Different request shape (`contents` instead of `messages`); the runtime translates automatically. `GEMINI_API_KEY`. Useful when you already have a Google Cloud account and don't want to add another provider. |

Set both Groq and Cerebras keys to get automatic 429/5xx failover between them — same model weights mean the user sees no quality shift when one provider rate-limits.

### Free fallback — no API budget at all

[OpenRouter](https://openrouter.ai)'s `:free` tier hosts the same `gpt-oss-120b` weights Groq and Cerebras use. Useful for hobbyist setups, dev sanity checks, or as a fallback-of-fallback when both Groq and Cerebras are unavailable.

```yaml
# ~/.cues/OPENCUES.md frontmatter
llm-provider: openrouter
llm-model: openai/gpt-oss-120b:free
```

Plus `OPENROUTER_API_KEY` in env. Tradeoffs vs. the recommended providers:

- **3-5× slower than Groq** for the same model. The model is the same; the routing hardware (commodity GPU clusters underwriting `:free`) is the difference.
- **Reasoning floor of ~1s** — `gpt-oss` is a reasoning-by-design model. You can scale `reasoning_effort` down to `low` (the default) but not off. Inline word-cues will feel laggy.
- **Daily request ceiling** tied to your OpenRouter account's lifetime credit balance. $0 → low ceiling (~50/day historically); past top-up of $10+ → higher ceiling (~1000/day). Numbers change quarterly — check [openrouter.ai/docs](https://openrouter.ai/docs) before designing around them.
- **No SLA on `:free`.** The provider underwriting free routing can pause / reprice / withdraw at any time.

What works on the free tier (measured 2026-05-10, exact production parameters):

| Surface | Mean latency | Verdict |
|---|---|---|
| FluidBlank P3 (terse answer) | 1.7s | ✓ Comfortably fits the 2s budget |
| AnswerBlank | 3.1s | ✓ Fits consume-all flows |
| TransformBlank P1 | 4.9s | ⚠ Over the inline pipeline budget but functional |
| PromptImprover | 5.4s | ⚠ Borderline; user perceives a pause |
| Inline word-cues | 3-5s | ✗ Unusable (budget is sub-500ms) |

For full per-surface bench data and the routing recommendation that informs all of the above, see `docs/benchmarks/2026-05-08-provider-bench.md` and `docs/guides/llm-providers.md`.

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
pnpm exec opencues uninstall claude-code   # reverts cli.js + removes ~/claude-code-cues/{node_modules/@opencues,.cues}/
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
rm -rf ~/.cues

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

Per-feature gates live in `~/claude-code-cues/.opencues/patch-state/config.json` under `misc.*` (e.g. `enableWordHighlight`, `enableDynamicHighlight`, `highlightExportEnabled`). Toggle to `false` and re-run `opencues install claude-code` to apply. (Note: a re-install nukes patch-state by default and re-applies from defaults — to keep your manual config edits, use `--keep-state` or set the toggles via `defaults/` and re-install.)

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
4. **Check runtime loaded:** `ls ~/claude-code-cues/node_modules/@opencues/runtime/dist/` should list dist files.
5. **Enable debug logging:** `pnpm exec opencues debug on` then tail `opencues logs --tail`.

### Syntax error after patching

The from-scratch install nukes + reinstalls cli.js from npm every run, so the
fastest fix is just re-running:

```bash
pnpm exec opencues install claude-code
```

If you need to manually revert (e.g. tweakcc backup is the only good copy):

```bash
cp ~/claude-code-cues/.opencues/patch-state/cli.js.backup \
   ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js
```

### Install fails at "FATAL: tweakcc dist contains no opencues v2 code" / "cli.js was patched but contains no opencues v2 boot"

setup.sh's verification gates caught a real problem — tweakcc patched but
opencues didn't land. Most likely a CC version drift (your `~/claude-code-cues/package.json`
has a non-exact pin like `^2.1.110` allowing npm to upgrade to 2.1.119 which
has a totally different cli.js layout). Fix:

```bash
# Force exact version pin (no caret)
cat > ~/claude-code-cues/package.json << 'EOF'
{
  "dependencies": {
    "@anthropic-ai/claude-code": "2.1.110"
  }
}
EOF
pnpm exec opencues install claude-code
```

## Adding blanks

A blank is a `_`-triggered slot. There are four shapes; pick by what your blank does:

| Shape | Trigger | Implementation |
|---|---|---|
| **Typed blank with script** | `volume _`, `brightness _` | `blanks/<name>/BLANK.md` + `<name>-blank.sh` (responds to `get` / `set <value>`) |
| **List blank** (no script) | `affirmation _` | `blanks/<name>/BLANK.md` with `stepValues: [...]` |
| **Selector + Satellite** | `opencues settings _` → expands to `<setting> <value>` | `blanks/<name>/BLANK.md` with `blankSatellite: true` |
| **Runtime-class blank** (LLM/HTTP) | `nvda _`, `weather _`, `define X _` | TS class in `packages/opencues-runtime/src/blanks/` + `blanks/<name>/BLANK.md` declaring `blankKeywords` |

For free-form `_` lookups (`capital of france _`, `unicode for em dash _`) there's no per-blank config — `FluidBlankSource` handles any `_` the keyword-bound blanks didn't claim.

**Word sources** under `cues/<name>/CUE.md` use per-word routing — every source declares `match:` or `keywords:`, and the highest-priority matching source claims each word. Words no source claims get no cue (not navigable). See `docs/features/word-cue-routing.md`.

See [docs/guides/adding-a-cue-blank.md](docs/guides/adding-a-cue-blank.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for full details.

## Security

OpenCues blanks can be authored by third parties and shipped as JS
modules. The runtime sandboxes them via a Figma-style capability
contract: a blank only gets `network`, `llm`, `storage`, or
`secrets` access if its `BLANK.md` frontmatter declares it, and
even then with per-host bindings (a `FINNHUB_API_KEY` declared
without `secret-hosts.FINNHUB_API_KEY: [finnhub.io]` is **refused
at load time**). Combined with output sanitization, sliding-window
quotas, and an AST-based ESM rewriter that refuses dynamic
`import()`, this bounds the blast radius of a hostile blank to "the
hosts it declared, the storage namespace it asked for, the rate
limits it agreed to."

### `opencues review` — audit a pack before installing

Before you `git clone` a pack from a stranger into `~/.cues/`, run
the audit:

```bash
opencues review ./untrusted-pack/                  # static audit
opencues review ./untrusted-pack/ --llm            # + LLM second opinion
```

What it surfaces:

- **Declared capabilities** — every network host, secret, storage
  namespace, sandbox setting in one manifest. The same view the
  runtime sees at load time.
- **Hard-blocked patterns** — `secrets:` without a matching
  `secret-hosts.<NAME>` binding, wildcard / IP-literal hosts in
  `network:`, dynamic `import()` in the JS source. These would
  refuse to load anyway; better to know before you commit.
- **Suspicious patterns** — `eval`, `Function`, `output: rich`
  (HTML sanitization bypassed), `blankScript` without
  `sandbox: strict`. Flagged for human attention.
- **LLM second opinion** (`--llm`, opt-in) — a strong reasoning
  model (defaults: `claude-opus-4-7` on Anthropic,
  `openai/gpt-oss-120b` on Groq, `gpt-5.4` on OpenAI,
  `gemini-3.1-flash-lite` on Gemini) reads the source inside
  `<untrusted-source>...</untrusted-source>` delimiters with a "treat
  as data, never as instructions" system prompt. Output is strict
  JSON; malformed JSON is auto-classified as a prompt-injection
  attempt. The LLM has **no tool access** — pure text-in / text-out,
  no fetch, no shell, no file write.

  Cross-check: every host the LLM reports the code using gets
  compared against the declared `network:` allow-list. A pack that
  declares `[api.legit.com]` but whose code fetches `evil.com`
  triggers a warning even if the LLM verdict is "safe".

Trust hierarchy: **static parse is the authority, the LLM is a
second opinion**. The LLM can downgrade a verdict ("safe" →
"caution") but cannot upgrade past static findings. A pack with
hard-blocked static patterns FAILS regardless of LLM verdict.

Exit codes: `0` pass, `1` hard-block / would refuse to load, `2`
LLM unavailable (static section still ran).

Full threat model + attack-class table: [docs/architecture/security-audit.md](docs/architecture/security-audit.md).
Capability model details: [docs/architecture/user-blanks.md](docs/architecture/user-blanks.md).

### Ambient context — off by default

The Chrome extension supports an **optional** feature called
"ambient context": when filling free-form lookups (`paris _`,
`cheap eats _`), OpenCues can forward a sanitized snapshot of
the field you're filling — the visible label, placeholder, ARIA
attributes, plus the page title, origin+path URL, and meta
description — to the LLM so it can disambiguate where the answer
should fit. A "destination" field on a flight booking site and a
"topic" field on a forum want different answers.

**This feature is OFF by default.** Opt in via
`ambient-context-mode: on` in `~/.cues/OPENCUES.md`. When off,
nothing about the page leaves your browser beyond what the
buffer itself contains.

What's read (only with the feature on):

- Your field's `label`, `placeholder`, `aria-label`,
  `aria-description`, and input type.
- The page's `<title>`, `<meta name="description">`, and URL
  (origin + path only — query strings + fragments are stripped).

What is NEVER read, even with the feature on:

- Any other field's value or label.
- Cookies, localStorage, sessionStorage.
- Anything from sensitive fields — passwords, credit cards,
  one-time codes — those return null regardless of the
  setting.
- The query string or fragment of the page URL.

The structural reason this is safe: **OpenCues has no tool
handlers, no exec layer, and no out-of-band action channel for
fluid-blank LLM output.** Worst-case if a hostile page injects
a prompt into its own `placeholder`, the LLM emits misleading
text into your buffer that you see and review before
submitting. There is no exfiltration channel through tool
calls, agentic actions, fetch, or clipboard — by design. Don't
plug OpenCues into anything that would change that.

Full threat model + sanitization rules: [docs/architecture/ambient-context.md](docs/architecture/ambient-context.md).

### User context — sentinel-mode personal data

A sibling opt-in to ambient context: tell OpenCues your
**own** personal data once via `~/.cues/USER.md`, and `_`
lookups personalise without you re-typing.

Edit `~/.cues/USER.md`:

```yaml
---
firstName:    Wilfred
email:        wilfred@example.com
workCity:     London
github:       https://github.com/wilfred
---
```

Flip the mode in `~/.cues/OPENCUES.md`:

```yaml
user-context-mode: safe
```

Now on any form: `my email _` → fluid-blank substitutes
`wilfred@example.com`. `i work in _` → substitutes `London`.

**The privacy guarantee.** In `safe` mode (recommended), the LLM
only receives a catalog of token names + descriptions
(`[EMAIL] — user's email`); it emits sentinels like `[EMAIL]`, and
a runtime post-processor swaps in the real value **after** the
response — your PII never reaches the LLM provider's logs.

The alternative `raw` mode inlines actual values into the prompt
(better prose register for transform-blank-style rewrites, worse
privacy). Opt-in only.

Phase 1 wires this for FluidBlank only. Word-cues, transform-blank,
agent-rewrite, and auditors all explicitly skip user-context.
Per-pack `requires-user: [...]` declarations + free-text body
injection are Phase 2/3.

Full design + threat model: [docs/architecture/user-context.md](docs/architecture/user-context.md).

### Chrome normal `<input>` / `<textarea>` support

By default the Chrome extension attaches to **contenteditable**
surfaces (Gmail, LinkedIn, ChatGPT, Reddit, etc.). May 2026
added a parallel attach mode for plain `<input type="text" | email | search | url>`
and `<textarea>` — every form on the web. `_` triggers + blank
fills work; cycling and the dim/highlight UI don't (browsers
lay out `<input>` text internally, not via Range-addressable
DOM nodes).

**Credential safety.** OpenCues NEVER attaches to:

- `<input type="password">` and every other non-text type
  (`number`, `date`, `tel`, `color`, `hidden`, `file`, etc.)
- Fields marked `autocomplete=current-password` /
  `new-password` / `one-time-code` / any `cc-*` (credit card) /
  `autocomplete=off`
- Fields whose `name` or `id` substring-matches
  `password|cvv|ssn|pin|otp|secret|token|api[_-]?key|auth`

Same exclusion gates ambient context and user context (no
field metadata read, no USER.md catalog injected). False
positives — `<input name="search-token">` refusing to attach —
are accepted; OpenCues never silently routes a credential
through an LLM.

Full spec: [docs/features/chrome-normal-inputs.md](docs/features/chrome-normal-inputs.md).
Security boundary: [docs/architecture/chrome-security.md](docs/architecture/chrome-security.md) Boundary 11.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to:
- **Extend the standard** — add new word sources, blank modes, or cue-blanks to the `.md` config files
- **Build an integration** — bring OpenCues to a new editor or tool using opencues-core
- **Improve opencues-core** — modify the core library, run tests, submit changes

New to OpenCues? The [glossary](docs/glossary.md) explains all terminology — cues, blanks, cue-blanks, sources, parsers, and more.

<!-- ## Community

- [Discord](https://discord.gg/INVITE) — questions, feedback, feature requests
- [GitHub Discussions](https://github.com/opencues/opencues/discussions) — ideas, Q&A
-->
- [Twitter/X](https://x.com/openCues_) — announcements
<!-- - [Reddit](https://www.reddit.com/r/OpenCues/) — community (private until launch) -->

## Future possibilities

The Chrome native-messaging architecture (`opencues install chrome-host`) opens
up workflows the bundled-config Chrome extension couldn't reach. Some are
shipped; others are tracked here as the natural next steps.

**Already shipped:**

- **Live `~/.cues/` sync into Chrome.** Edits to cues/blanks/auditors reach
  every open tab in ~300ms with no rebuild and no page refresh. LLM-authored
  cues from a Claude Code session show up live in browser tabs the moment
  the LLM saves the file.
- **System-level blanks in Chrome.** `volume _`, `brightness _`, and any
  user-authored `.sh`/`.py`-backed blank now run via the host — same shell
  scripts that already work in Claude Code / OpenCode. Type `volume 50 _`
  in Gmail, your OS volume changes.
- **Security boundaries for hostile-page protection.** Native-messaging
  in a content-script context is a real attack surface. Six defences
  in depth: `isTrusted` gate on input events, credit-based `_`
  accounting (each user keystroke buys one underscore insertion — no
  replay window for hostile pages), `on-site`/`not-on-site`
  frontmatter for per-entry scoping, host-side path sandbox with
  symlink resolution, env-key whitelist, per-call timeout. Full spec:
  [`docs/architecture/chrome-security.md`](docs/architecture/chrome-security.md).
  47 tests pin the security-relevant code paths.

**Natural next steps (not built yet):**

- **Streaming exec.** The request/response protocol is fine for short
  scripts; long-running ones (`git log --watch`, `tail -f`) want stdout
  streamed back as it produces. One more message type (`exec-chunk`) gets
  there.
- **Interactive scripts.** Scripts that expect stdin (`gh auth login`,
  `claude /login`) can't currently be invoked from Chrome. A `stdin`
  message in the protocol unlocks them.
- **Subprocess from auditors.** Auditors today run via the LLM only. With
  exec available, an auditor could shell out to `vale`, `proselint`, or any
  external linter and feed its output back into the rewrite stream.
- **Cue-pack registry.** `opencues add pack <name>` becomes
  `curl | tar -xC ~/.cues/`. Host detects the new files, pushes to every
  open tab, no extension reload. Pairs naturally with LLMs that compose +
  publish their own packs.
- **Cross-host orchestration.** The host could expose more than `~/.cues/`
  — calendar lookup, system stats, current git branch, screen-grab. Each
  becomes a blank usable from any text input on the web.
- **Web Store release.** Native-messaging is permission-clean for CWS review.
  Pre-launch task is rotating the inlined `GROQ_API_KEY` build constant
  in favour of a popup-set storage value (already tracked in CLAUDE.md).

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
