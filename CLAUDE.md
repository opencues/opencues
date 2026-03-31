# CLAUDE.md - Cues System

This document provides context for Claude sessions working on this project.

## Project Overview

**cues-system** provides LLM-powered word alternatives for text editors. The core library analyzes text and suggests alternatives (synonyms, opposites, completions) that users can cycle through.

**Architecture**:
- **cues-core** — Pure TypeScript library for LLM analysis (prompts, resolver, HTTP adapter)
- **Integrations** — Editor-specific implementations that use cues-core

**Current Integrations**:
- **Claude Code** — via tweakcc patches (`integrations/claude-code/patches/`)

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
│       ├── prompts/               # LLM system prompts (.txt) + references
│       │   ├── grammar.txt        # Word alternatives prompt
│       │   ├── blank_*.txt        # Fill-in-the-blank prompts (math, factual, grammar)
│       │   ├── classifier.txt     # Mode classification prompt
│       │   ├── linked.txt         # Linked words prompt
│       │   └── references/        # Prompt documentation
│       └── dist/                  # Built output
│
├── integrations/claude-code/      # Claude Code integration
│   ├── patches/                   # tweakcc patches + installer
│   │   ├── setup.sh               # ONE-COMMAND INSTALLER
│   │   ├── cursorStateExport.ts   # Cursor position → JSON
│   │   ├── wordHighlight.ts       # Navigation, numbers, gender, rendering
│   │   ├── dynamicHighlight.ts    # LLM integration, cycling, spans
│   │   ├── highlight-statusline.sh # Status line script
│   │   ├── claude-code-tips.json  # Per-word tips file
│   │   └── actions/               # Action word scripts (volume.sh)
│   ├── docs/                      # Claude Code feature documentation
│   │   ├── systems-diagram.md     # Architecture + data flow diagrams
│   │   ├── word-highlight.md      # Navigation modes, keys, behaviour
│   │   ├── dynamic-highlight.md   # LLM triggers, tips, blanks, clearing
│   │   ├── status-line.md         # Status line setup, format, disabling
│   │   ├── action-word-overrides.md # External action scripts + WSL guide
│   │   ├── config.md              # All config options
│   │   └── claude-code-prompting.md # Claude Code CLI tips
│   └── tests/                     # Integration tests
│
├── docs/                          # General documentation
│   ├── cues-system.md             # System overview
│   ├── llm-providers.md           # LLM providers, config & benchmarks
│   ├── blank-system.md            # Fill-in-the-blank feature
│   ├── blank-position-detection.md # Blank grammar rules
│   └── prompt-design-learnings.md # Prompt engineering principles
│
└── tests/                         # Benchmarks & test data
    ├── benchmarks/                # LLM accuracy benchmarks
    └── results/                   # Benchmark results
```

---

## Quick Install (Claude Code)

```bash
git clone https://github.com/wkasekende/cues-system ~/cues-system
~/cues-system/integrations/claude-code/patches/setup.sh
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

### Claude Code Integration (integrations/claude-code)

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

## Documentation

### Claude Code (`integrations/claude-code/docs/`)

| Doc | Purpose |
|-----|---------|
| `systems-diagram.md` | Architecture + data flow diagrams |
| `word-highlight.md` | Navigation modes, keys, behaviour |
| `dynamic-highlight.md` | LLM triggers, tips, blanks, clearing |
| `status-line.md` | Status line setup, format, disabling |
| `action-word-overrides.md` | External action scripts + WSL guide |
| `config.md` | All config options |
| `claude-code-prompting.md` | Claude Code CLI tips |

### General (`docs/`)

| Doc | Purpose |
|-----|---------|
| `cues-system.md` | Architecture, feature concepts, API |
| `llm-providers.md` | Provider config & benchmarks |
| `blank-system.md` | Fill-in-the-blank classification |
| `blank-position-detection.md` | Blank grammar rules |
| `prompt-design-learnings.md` | Prompt engineering principles |

---

## Adding New Integrations

To add a new editor integration:

1. Create `integrations/<editor>/` with integration code
2. Add `integrations/<editor>/docs/` for editor-specific documentation
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
integrations/claude-code/patches/setup.sh

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

*Last updated: April 2026*
