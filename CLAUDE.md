# CLAUDE.md - Cues System

This document provides context for Claude sessions working on this project.

## Project Overview

**cues-system** provides LLM-powered word alternatives for text editors. The core library analyzes text and suggests alternatives (synonyms, opposites, completions) that users can cycle through.

**Architecture**:
- **cues-core** — Pure TypeScript library for LLM analysis (prompts, resolver, HTTP adapter)
- **Integrations** — Editor-specific implementations that use cues-core

**Current Integrations**:
- **Claude Code** — via tweakcc patches (`claude-code/patches/`)

---

## Repository Structure

```
cues-system/
├── CLAUDE.md                      # THIS FILE - project overview
├── README.md                      # Public readme with install instructions
│
├── packages/                      # Core packages
│   └── cues-core/                 # LLM analysis library
│       ├── src/
│       │   ├── prompts.ts         # GRAMMAR, MATH, FACTUAL prompts
│       │   ├── resolver.ts        # CueResolver orchestration
│       │   ├── node-http-adapter.ts  # HTTPS with keep-alive
│       │   ├── classifier.ts      # looksLikeMath, looksLikeFactual
│       │   └── sources/           # GrammarSource, MathSource, FactualSource
│       └── dist/                  # Built output
│
├── claude-code/                   # Claude Code integration (all in one place)
│   ├── patches/                   # tweakcc patches
│   │   ├── setup.sh               # ONE-COMMAND INSTALLER
│   │   ├── cursorStateExport.ts   # Cursor position → JSON
│   │   ├── wordHighlight.ts       # Navigation, numbers, gender, rendering
│   │   ├── dynamicHighlight.ts    # LLM integration, cycling, spans
│   │   ├── types-additions.ts     # TypeScript types to add
│   │   ├── defaultSettings-additions.ts  # Default values to add
│   │   ├── index-additions.ts     # Integration code to add
│   │   ├── actions/               # Action word scripts (volume.sh)
│   │   └── claude-code-tips.json  # Per-word tips file
│   ├── docs/                      # Implementation documentation
│   │   ├── tweakcc-cues-installation.md  # Install guide
│   │   ├── implementation-notes.md       # Patching details
│   │   ├── systems-diagram.md            # Architecture diagram
│   │   ├── word-highlight-system.md      # Word highlight deep-dive
│   │   ├── dynamic-highlight-system.md   # Dynamic highlight deep-dive
│   │   └── ...
│   ├── references/                # Feature references
│   │   ├── word-highlight.md      # Full word highlight reference
│   │   ├── dynamic-highlight.md   # Full dynamic highlight reference
│   │   ├── config.md              # Config file reference
│   │   └── ...
│   └── tests/                     # Claude Code specific tests
│
├── docs/                          # General documentation
│   ├── cues-system.md             # System overview
│   ├── gpt-oss.md                 # LLM model documentation
│   ├── groq-cerebras-benchmarks.md  # Model benchmarks
│   └── prompt-optimization.md     # Prompt design notes
│
├── benchmarks/                    # Performance benchmarks
└── examples/                      # Usage examples
```

---

## Quick Install (Claude Code)

```bash
git clone https://github.com/wkasekende/cues-system ~/cues-system
~/cues-system/claude-code/patches/setup.sh
export GROQ_API_KEY="your-key"
```

The setup script:
1. Clones tweakcc from upstream
2. Copies and integrates patch files
3. Builds cues-core → ~/.claude/node_modules/
4. Applies patches to Claude Code

---

## Key Components

### cues-core

Pure TypeScript library with no I/O dependencies. Provides:

| Component | Purpose |
|-----------|---------|
| `CueResolver` | Orchestrates multiple sources, merges results by priority |
| `GrammarSource` | Word alternatives via LLM (synonym, opposite, creative) |
| `MathSource` | Evaluates math expressions (`4 * 12 = _` → `48`) |
| `FactualSource` | Answers factual questions (`Capital of France is _` → `Paris`) |
| `NodeHttpAdapter` | HTTPS with connection keep-alive, ~200ms to Groq |

### Claude Code Integration (cues-patches)

Patches Claude Code via tweakcc to add:

| Feature | Description |
|---------|-------------|
| Word navigation | Ctrl+Alt+Left/Right to highlight words |
| Number increment | Ctrl+Alt+Up/Down on numbers |
| Gender flip | "boy" ↔ "girl", "he" ↔ "she" |
| LLM alternatives | Words dim gray when alternatives available |
| Fill-in-the-blank | Type `_` for completions |
| Action words | "volume" triggers system volume |

---

## Documentation by Integration

### Claude Code

| Doc | Purpose |
|-----|---------|
| `claude-code/docs/tweakcc-cues-installation.md` | Full install guide |
| `claude-code/docs/implementation-notes.md` | How patching works |
| `claude-code/docs/systems-diagram.md` | Architecture overview |
| `claude-code/references/word-highlight.md` | Word highlight reference |
| `claude-code/references/dynamic-highlight.md` | Dynamic highlight reference |
| `claude-code/references/config.md` | Config file reference |

### General (cues-core)

| Doc | Purpose |
|-----|---------|
| `docs/cues-system.md` | System overview |
| `docs/gpt-oss.md` | LLM model info |
| `docs/groq-cerebras-benchmarks.md` | Model benchmarks |
| `packages/cues-core/src/prompts.ts` | All LLM prompts (source of truth) |

---

## Adding New Integrations

To add a new editor integration:

1. Create `packages/cues-<editor>/` with integration code
2. Create `<editor>/docs/` for editor-specific documentation
3. Use cues-core for LLM analysis:

```typescript
import { createResolver, GrammarSource, NodeHttpAdapter } from 'cues-core';

const httpAdapter = new NodeHttpAdapter({
  providerOverrides: { "api.groq.com": { max_tokens: 400 } }
});

const resolver = createResolver([
  GrammarSource({ httpAdapter }),
  // MathSource, FactualSource as needed
]);

const result = await resolver.resolve({
  words: ["The", "quick", "fox"],
  targetIndices: [1, 2]  // only analyze "quick" and "fox"
});
// result.cues = { 1: ["fast", "slow", "rapid"], 2: ["wolf", "dog", "hound"] }
```

---

## Build Commands

```bash
# Build cues-core
cd packages/cues-core && npm run build

# Run Claude Code setup
claude-code/patches/setup.sh

# Re-apply patches after Claude Code updates
cd ~/tweakcc
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

---

## Environment

- **API Key**: `GROQ_API_KEY` for Groq (default provider)
- **Debug**: `DEBUG=cues*` for debug logging
- **Config**: `~/.tweakcc/config.json` for Claude Code settings

---

*Last updated: March 2026*
