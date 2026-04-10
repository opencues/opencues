# OpenCues

<!-- Badges: uncomment when ready
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/opencues/opencues/actions/workflows/ci.yml/badge.svg)](https://github.com/opencues/opencues/actions)
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

| Editor | Status | Integration |
|--------|--------|-------------|
| **Claude Code** | Available | via [tweakcc](https://github.com/Piebald-AI/tweakcc) patches |
| **VS Code** | Planned | Extension |
| **Chrome** | Planned | Extension ([tracking](docs/guides/adding-an-integration.md)) |

## The Standard

OpenCues is built on `.md` config files — monolithic or folder-based. All prompts, modes, and behaviour live here, not in code.

| Config | What it defines | Example |
|--------|----------------|---------|
| **cues.md** | Word tips and LLM prompt sources for word alternatives | `### grammar` with synonym/opposite/creative prompt |
| **blanks.md** | Fill-in-the-blank modes with prompt + parser per mode | `### math` with `parser: compute` |
| **controls.md** | Cue-controls — words that trigger external scripts | `"volume"` runs a volume control script |
| **cues/{name}/cue.md** | Folder-based word source (config in frontmatter, prompt in body) | `cues/legal/cue.md` for legal terminology |
| **controls/{name}/** | Self-contained control with colocated script | `controls/volume/cue.md` + `volume.sh` |

Integrations read these files via `cues-core` (the reference implementation in pure TypeScript). Folder-based configs are auto-discovered and merge with monolithic files (folder wins on name conflict). To build an integration for a new editor, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Install (Claude Code)

**Prerequisites:** Node.js 18+, Claude Code, a [Groq API key](https://console.groq.com) (free).

```bash
# 1. Add your Groq key to ~/.bashrc (must be set before Claude Code starts)
echo 'export GROQ_API_KEY="your-key"' >> ~/.bashrc && source ~/.bashrc

# 2. Clone and install
git clone https://github.com/wkasekende/opencues ~/opencues
~/opencues/integrations/claude-code/patches/setup.sh
```

Restart Claude Code. Done.

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
│  packages/cues-core/          Runtime module                │
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
│  • require("~/.claude/node_modules/cues-core")              │
└─────────────────────────────────────────────────────────────┘
```

## Requirements

| Requirement | Check |
|-------------|-------|
| Node.js 18+ | `node --version` |
| Claude Code | `which claude` |
| Groq API key | [console.groq.com](https://console.groq.com) |

## Packages

### cues-core

Pure TypeScript module for LLM-based text analysis. No I/O dependencies.

- **CueResolver** — orchestrates multiple sources, merges results
- **ConfigSource** — generic config-driven LLM source (one per `###` section in `.md` files)
- **ClassifiedSourceGroup** — wraps blank modes with fast/LLM classification
- **ControlBlankSource** — bridges blanks with cue-controls (auto-populate + cycling)
- **buildSourcesFromConfig** — factory: parses `cues.md` + `blanks.md` + controls → `CueSource[]`
- **NodeHttpAdapter** — HTTPS with connection keep-alive, ~200ms latency to Groq

### integrations/claude-code

Integrates cues-core into Claude Code via [tweakcc](https://github.com/Piebald-AI/tweakcc).

- **patches/setup.sh** — one-command installer
- **patches/wordHighlight.ts** — word navigation, number handling, ANSI rendering
- **patches/dynamicHighlight.ts** — LLM integration, alternative cycling, span groups
- **patches/cursorStateExport.ts** — exports cursor position to JSON

Other integrations (VS Code, web, etc.) can be added under `integrations/`.

## Status line (optional)

Shows the highlighted word and its tip in Claude Code's status bar:

```
agents (1/3) - Spawn parallel workers via Task tool
```

**Enable:** Run `/statusline` in Claude Code and set the command to:
```
/home/YOUR_USER/.claude/highlight-statusline.sh
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

When Claude Code updates:

```bash
cd ~/tweakcc
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

When OpenCues updates:

```bash
cd ~/opencues && git pull
~/opencues/integrations/claude-code/patches/setup.sh
```

## Removing

### Remove patches (restore original Claude Code)

```bash
cp ~/.tweakcc/cli.js.backup $(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
```

### Remove supporting files

```bash
rm ~/.claude/claude-code-tips.json
rm ~/.claude/highlight-statusline.sh
rm -rf ~/.claude/node_modules/cues-core
rm -rf ~/.claude/actions
```

### Disable individual features

In `~/.tweakcc/config.json`:

```json
{
  "misc": {
    "enableWordHighlight": false,
    "enableDynamicHighlight": false,
    "highlightExportEnabled": false
  }
}
```

## Troubleshooting

### Words don't turn gray

Work through these in order:

1. **Did you restart Claude Code?** Patches only take effect after a restart.
2. **Is the API key in `~/.bashrc`?** `export GROQ_API_KEY=...` in a terminal session is not enough — Claude Code won't see it unless it's in `~/.bashrc` (and you've started a new session since adding it). Check: `echo $GROQ_API_KEY`
3. **Did setup.sh finish successfully?** It should print `Setup Complete`. If it printed `ERROR: Claude Code not found`, patches were never applied — install Claude Code first, then re-run `setup.sh`.
4. **Check cues-core loaded:** `node -e "require(process.env.HOME+'/.claude/node_modules/cues-core')"`
5. **Enable debug logging:** `DEBUG=cues* claude` — look for resolver output as you type.

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
- **Build an integration** — bring OpenCues to a new editor or tool using cues-core
- **Improve cues-core** — modify the core library, run tests, submit changes

New to OpenCues? The [glossary](docs/glossary.md) explains all terminology — cues, blanks, cue-controls, sources, parsers, and more.

<!-- ## Community

- [Discord](https://discord.gg/INVITE) — questions, feedback, feature requests
- [GitHub Discussions](https://github.com/opencues/opencues/discussions) — ideas, Q&A
- [Twitter/X](https://twitter.com/opencues) — announcements
-->

## License

<!-- TODO: Switch to open-source license before launch -->
Proprietary. All rights reserved. See [LICENSE](LICENSE).
