---
last_updated: 2026-04-01
---

# Claude Code Patches

Custom patches for tweakcc that add LLM-powered word alternatives to Claude Code.

## Quick Install

```bash
# 1. Clone opencues
git clone https://github.com/opencues/opencues ~/opencues

# 2. Run setup (clones tweakcc, patches everything, builds, applies)
~/opencues/integrations/claude-code/patches/setup.sh

# 3. Set API key (add to ~/.bashrc for persistence)
export GROQ_API_KEY="your-key"

# 4. Restart Claude Code
claude
```

That's it. The setup script:
- Clones tweakcc to ~/tweakcc
- Installs dependencies
- Copies and integrates patch files
- Builds cues-core
- Applies patches to Claude Code

## Contents

```
patches/
├── setup.sh                  # Automated setup script
├── cursorStateExport.ts      # Exports cursor position to JSON
├── wordHighlight.ts          # Ctrl+Alt navigation, numbers, rendering
├── dynamicHighlight.ts       # LLM alternatives, cycling, spans
├── types-additions.ts        # Reference: types to add
├── defaultSettings-additions.ts  # Reference: defaults to add
├── index-additions.ts        # Reference: index.ts changes
├── actions/                  # Cue-control scripts
│   └── volume.sh
└── claude-code-tips.json     # Per-word tips (instant lookup)
```

## Manual Installation

If the setup script doesn't work, follow these steps:

### 1. Clone vanilla tweakcc

```bash
git clone https://github.com/anthropics/tweakcc ~/tweakcc
cd ~/tweakcc && npm install
```

### 2. Copy patch files

```bash
CUES_PATCHES=~/opencues/integrations/claude-code/patches

cp $CUES_PATCHES/cursorStateExport.ts ~/tweakcc/src/patches/
cp $CUES_PATCHES/wordHighlight.ts ~/tweakcc/src/patches/
cp $CUES_PATCHES/dynamicHighlight.ts ~/tweakcc/src/patches/
```

### 3. Modify tweakcc source files

**src/types.ts** - Add contents of `types-additions.ts` to the `MiscSettings` interface.

**src/defaultSettings.ts** - Add contents of `defaultSettings-additions.ts` to the `misc` object.

**src/patches/index.ts** - Add imports and patch calls from `index-additions.ts`.

### 4. Build and install cues-core

```bash
cd ~/opencues/packages/cues-core
npm install && npm run build

mkdir -p ~/.claude/node_modules/cues-core
cp dist/*.js dist/*.d.ts ~/.claude/node_modules/cues-core/
cp -r dist/sources ~/.claude/node_modules/cues-core/
```

### 5. Install supporting files

```bash
cp $CUES_PATCHES/claude-code-tips.json ~/.claude/

mkdir -p ~/.claude/actions
cp $CUES_PATCHES/actions/* ~/.claude/actions/
chmod +x ~/.claude/actions/*.sh
```

### 6. Set API key and build

```bash
export GROQ_API_KEY="your-key"

cd ~/tweakcc && npm run build
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
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

- **cues-core** - LLM analysis module (sibling package)
- **GROQ_API_KEY** - API key for Groq (default provider)

## See Also

- [cues-core](../../../packages/cues-core/) - The LLM analysis module
- [Full documentation](../docs/) - Implementation guides and references
