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
│   ├── docs/                      # Claude Code feature docs
│   │   ├── systems-diagram.md     # Architecture diagram
│   │   ├── action-word-overrides.md # Action words guide
│   │   ├── status-line-integration.md # Status line setup
│   │   └── claude-code-prompting.md   # Claude Code CLI tips
│   ├── references/                # Feature quick-reference cards
│   │   ├── word-highlight.md
│   │   ├── dynamic-highlight.md
│   │   ├── status-line.md
│   │   ├── action-word-overrides.md
│   │   ├── config.md
│   │   └── variable-map.md
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

## Documentation by Integration

### Claude Code

| Doc | Purpose |
|-----|---------|
| `integrations/claude-code/docs/tweakcc-cues-installation.md` | Full install guide |
| `integrations/claude-code/docs/implementation-notes.md` | How patching works |
| `integrations/claude-code/docs/systems-diagram.md` | Architecture overview |
| `integrations/claude-code/references/word-highlight.md` | Word highlight reference |
| `integrations/claude-code/references/dynamic-highlight.md` | Dynamic highlight reference |
| `integrations/claude-code/references/config.md` | Config file reference |

### General (cues-core)

| Doc | Purpose |
|-----|---------|
| `docs/cues-system.md` | System overview |
| `docs/llm-providers.md` | LLM providers, config & benchmarks |
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

*Last updated: March 2026*
