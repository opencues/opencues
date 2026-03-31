# cues-patches

Custom patches for tweakcc that add LLM-powered word alternatives to Claude Code.

## Contents

```
cues-patches/
├── cursorStateExport.ts      # Exports cursor position to JSON
├── wordHighlight.ts          # Ctrl+Alt navigation, numbers, gender
├── dynamicHighlight.ts       # LLM alternatives, cycling, spans
├── types-additions.ts        # Add to tweakcc src/types.ts
├── defaultSettings-additions.ts  # Add to tweakcc src/defaultSettings.ts
├── index-additions.ts        # Add to tweakcc src/patches/index.ts
├── actions/                  # Action word scripts
│   └── volume.sh
└── claude-code-tips.json     # Per-word tips (instant lookup)
```

## Installation

### 1. Clone vanilla tweakcc

```bash
git clone https://github.com/anthropics/tweakcc
cd tweakcc
npm install
```

### 2. Copy patch files

```bash
CUES_PATCHES="/path/to/cues-system/packages/cues-patches"

cp $CUES_PATCHES/cursorStateExport.ts src/patches/
cp $CUES_PATCHES/wordHighlight.ts src/patches/
cp $CUES_PATCHES/dynamicHighlight.ts src/patches/
```

### 3. Modify tweakcc source files

**src/types.ts** - Add contents of `types-additions.ts` to the `MiscSettings` interface.

**src/defaultSettings.ts** - Add contents of `defaultSettings-additions.ts` to the `misc` object.

**src/patches/index.ts** - Add imports and patch calls from `index-additions.ts`.

### 4. Install cues-core

```bash
cd ~/.claude
npm install cues-core
```

### 5. Install supporting files

```bash
# Tips file
cp $CUES_PATCHES/claude-code-tips.json ~/.claude/

# Action scripts
mkdir -p ~/.claude/actions
cp $CUES_PATCHES/actions/* ~/.claude/actions/
chmod +x ~/.claude/actions/*.sh
```

### 6. Set API key

```bash
export GROQ_API_KEY="your-key"
```

### 7. Build and apply

```bash
cd /path/to/tweakcc
npm run build

CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply

# Verify
node --check "$CLI_JS"
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
