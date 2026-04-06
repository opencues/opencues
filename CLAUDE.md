# CLAUDE.md - OpenCues

This document provides context for Claude sessions working on this project.

## Project Overview

**OpenCues** provides LLM-powered word alternatives for text editors. The core library analyzes text and suggests alternatives (synonyms, opposites, completions) that users can cycle through.

**Architecture**:
- **cues-core** — Pure TypeScript library for LLM analysis (prompts, resolver, HTTP adapter)
- **Integrations** — Editor-specific implementations that use cues-core

**Current Integrations**:
- **Claude Code** — via tweakcc patches (`integrations/claude-code/patches/`)

---

## Repository Structure

```
opencues/
├── CLAUDE.md                      # THIS FILE - project overview
├── cues.md                        # OpenCues config (tips, prompts, ignore)
├── blanks.md                      # Blank-fill modes (math, factual, grammar, etc.)
├── controls.md                    # Cue-controls (can be empty if using folders)
├── README.md                      # Public readme with install instructions
│
├── cues/                          # Folder-based word cue configs
│   ├── grammar/cue.md             # Base word alternatives
│   ├── legal/cue.md               # Legal terminology alternatives
│   ├── medical/cue.md             # Clinical terminology alternatives
│   └── financial/cue.md           # Financial terminology alternatives
│
├── controls/                      # Folder-based cue-controls (colocated scripts + state)
│   ├── volume/
│   │   ├── cue.md                 # Control config (type: control, blankKeywords, etc.)
│   │   ├── volume.sh              # Word-control script: up/down via key presses
│   │   ├── volume-blank.sh        # Blank-control script: get/set via Core Audio API
│   │   ├── VolCtl.cs              # C# source for Windows Core Audio API (compiled by setup.sh)
│   │   └── state.txt              # Runtime state (gitignored)
│   └── brightness/
│       ├── cue.md
│       ├── brightness.sh
│       └── state.txt              # Runtime state (gitignored)
│
├── packages/                      # Core packages
│   └── cues-core/                 # LLM analysis library
│       ├── src/
│       │   ├── resolver.ts        # CueResolver orchestration
│       │   ├── cues-md.ts         # cues.md parser (parseCuesMd, parseSingleCueMd)
│       │   ├── discover.ts        # Folder-based config discovery
│       │   ├── node-http-adapter.ts  # HTTPS with keep-alive
│       │   └── sources/           # ConfigSource, ClassifiedSourceGroup, ControlBlankSource, parsers
│       ├── prompts/               # Prompt references + documentation
│       │   ├── linked.txt         # Linked words prompt
│       │   └── references/        # Prompt documentation
│       └── dist/                  # Built output
│
├── integrations/claude-code/      # Claude Code integration
│   ├── patches/                   # tweakcc patches + installer
│   │   ├── setup.sh               # ONE-COMMAND INSTALLER
│   │   ├── cursorStateExport.ts   # Cursor position → JSON
│   │   ├── wordHighlight.ts       # Navigation, numbers, rendering, TTS
│   │   ├── dynamicHighlight.ts    # LLM integration, cycling, spans, TTS
│   │   ├── highlight-statusline.sh # Status line script
│   │   ├── claude-code-tips.json  # Per-word tips file
│   │   └── actions/               # Scripts (volume.sh, speak.sh, SpeakCtl.cs)
│   ├── docs/                      # Claude Code implementation docs
│   │   ├── navigation.md          # Keys, modes, visual states, cursor export
│   │   ├── cycling.md             # Numbers, alts, linked, spans, clearing
│   │   ├── alternatives.md        # Tips, LLM sources, blanks, auto-submit
│   │   ├── cue-controls.md         # Cue-controls + WSL guide
│   │   ├── status-line.md         # Status line setup, format, disabling
│   │   ├── config.md              # All config options
│   │   ├── architecture.md        # Architecture + data flow diagrams
│   │   └── prompting-guide.md     # Claude Code CLI tips
│   └── tests/                     # Integration tests
│
├── docs/                          # General documentation
│   ├── overview.md                # System layers, API, interfaces, usage examples
│   ├── features/                  # One file per feature concept (14 features)
│   │   ├── README.md              # Feature index
│   │   ├── navigation.md          # Feature 1: Word navigation
│   │   ├── cycling.md             # Feature 2: Word cycling
│   │   ├── ...                    # Features 3-14 (one file each)
│   │   └── status-display.md      # Feature 14: Status display
│   ├── guides/                    # Task-oriented how-tos
│   │   ├── adding-a-feature.md    # How to add a new feature
│   │   ├── adding-an-integration.md # How to add a new editor integration
│   │   ├── adding-a-cue-control.md # How to add a cue-control (external script trigger)
│   │   ├── porting-to-new-integration.md # Porting guide: contracts, pitfalls, edge cases
│   │   ├── parser-types.md        # Response parser types (alternatives, compute, answer, raw)
│   │   └── llm-providers.md       # LLM provider setup & benchmarks
│   └── prompt-design-learnings.md # Prompt engineering principles
│
└── tests/                         # Benchmarks & test data
    ├── benchmarks/                # LLM accuracy benchmarks
    └── results/                   # Benchmark results
```

---

## Quick Install (Claude Code)

```bash
git clone https://github.com/wkasekende/opencues ~/opencues
~/opencues/integrations/claude-code/patches/setup.sh
export GROQ_API_KEY="your-key"
```

The setup script:
1. Clones tweakcc from upstream
2. Copies and integrates patch files
3. Builds cues-core → ~/.claude/node_modules/
4. Applies patches to Claude Code

---

## Key References

- **README.md** — Features, install, configuration, troubleshooting
- **CONTRIBUTING.md** — How to extend the standard, build integrations, modify cues-core
- **docs/overview.md** — System architecture, core interfaces, API usage
- **docs/glossary.md** — All terminology (cues, blanks, sources, parsers, config files)
- **docs/guides/** — Task-oriented how-tos (adding features, integrations, cue-controls, parser types, LLM providers)
- **integrations/claude-code/docs/** — Claude Code implementation docs (8 files)
- **docs/features/** — 14 feature concepts (one file each)

---

## Build Commands

**After any change, use `setup.sh`** — it handles everything (build, copy, tweakcc rebuild, patch apply):

```bash
integrations/claude-code/patches/setup.sh
```

This is the **only reliable way** to apply changes. It:
1. Copies patch `.ts` files to tweakcc and **rebuilds tweakcc** (compiles patches into `dist/`)
2. Builds cues-core (`src/` → `dist/`) and copies to `~/.claude/node_modules/cues-core/`
3. Applies compiled patches to Claude Code's `cli.js`

**Do not** run `node dist/index.mjs --apply` directly after editing patch files — that uses the old compiled tweakcc output and your changes won't take effect.

After running setup.sh, **restart Claude Code** for changes to take effect.

> **Note:** Editing `.md` config files (`cues.md`, `blanks.md`, `controls.md`, `cues/`, `controls/`) does **not** require a restart — they hot-reload within ~2 seconds on the next keystroke.

```bash
# Re-apply patches only (after Claude Code updates, no source changes)
cd ~/tweakcc
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

---

> **Important:** See `integrations/claude-code/docs/architecture.md` § "Development Notes" for critical patch development rules (e.g., never use bare `require()` in patch files).

---

## Environment

- **API Key**: `GROQ_API_KEY` for Groq (default provider)
- **Debug**: `DEBUG=cues*` for debug logging
- **Config**: `~/.tweakcc/config.json` for Claude Code settings

---

*Last updated: April 2026*
