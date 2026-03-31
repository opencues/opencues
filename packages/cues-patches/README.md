# cues-patches

Custom patches for tweakcc that add LLM-powered word alternatives to Claude Code.

## Quick Install

```bash
# 1. Clone repos
git clone https://github.com/anthropics/tweakcc ~/tweakcc
git clone https://github.com/wkasekende/cues-system ~/cues-system

# 2. Install tweakcc dependencies
cd ~/tweakcc && npm install

# 3. Run setup script (patches tweakcc + installs cues-core)
~/cues-system/packages/cues-patches/setup.sh ~/tweakcc

# 4. Set API key
export GROQ_API_KEY="your-key"

# 5. Build and apply
cd ~/tweakcc && npm run build
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

## Contents

```
cues-patches/
├── setup.sh                  # Automated setup script
├── cursorStateExport.ts      # Exports cursor position to JSON
├── wordHighlight.ts          # Ctrl+Alt navigation, numbers, gender
├── dynamicHighlight.ts       # LLM alternatives, cycling, spans
├── types-additions.ts        # Reference: types to add
├── defaultSettings-additions.ts  # Reference: defaults to add
├── index-additions.ts        # Reference: index.ts changes
├── actions/                  # Action word scripts
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
CUES_PATCHES=~/cues-system/packages/cues-patches

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
cd ~/cues-system/packages/cues-core
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
| Ctrl+Alt+Up/Down | Increment numbers, flip gender, cycle alternatives |
| Escape | Clear highlight |

Words with LLM alternatives appear dimmed. Type `_` for fill-in-the-blank.

## Dependencies

- **cues-core** - LLM analysis module (sibling package)
- **GROQ_API_KEY** - API key for Groq (default provider)

## See Also

- [cues-core](../cues-core/) - The LLM analysis module
- [tweakcc docs](https://github.com/wkasekende/tweakcc-) - Full documentation
