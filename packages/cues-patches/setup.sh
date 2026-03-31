#!/bin/bash
#
# setup.sh - One-command setup for cues-patches + tweakcc
#
# Usage: ./setup.sh [tweakcc-dir]
#
# If no directory specified, clones tweakcc to ~/tweakcc
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TWEAKCC_DIR="${1:-$HOME/tweakcc}"

echo "=== Cues System Setup ==="
echo ""

# 1. Clone or update tweakcc
if [ ! -d "$TWEAKCC_DIR" ]; then
  echo "Cloning tweakcc to $TWEAKCC_DIR..."
  git clone https://github.com/anthropics/tweakcc "$TWEAKCC_DIR"
  cd "$TWEAKCC_DIR"
  npm install
elif [ ! -d "$TWEAKCC_DIR/src/patches" ]; then
  echo "Error: $TWEAKCC_DIR exists but doesn't look like tweakcc"
  exit 1
else
  echo "Using existing tweakcc at $TWEAKCC_DIR"
  cd "$TWEAKCC_DIR"
fi

# 2. Copy patch files
echo ""
echo "Copying patch files..."
cp "$SCRIPT_DIR/cursorStateExport.ts" "$TWEAKCC_DIR/src/patches/"
cp "$SCRIPT_DIR/wordHighlight.ts" "$TWEAKCC_DIR/src/patches/"
cp "$SCRIPT_DIR/dynamicHighlight.ts" "$TWEAKCC_DIR/src/patches/"
echo "  Copied 3 patch files"

# 3. Add types to types.ts
echo ""
echo "Patching types.ts..."
TYPES_FILE="$TWEAKCC_DIR/src/types.ts"
if ! grep -q "enableCursorStateExport" "$TYPES_FILE"; then
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$TYPES_FILE', 'utf8');

const additions = \`
  // --- Cues Patches ---
  enableCursorStateExport?: boolean;
  cursorStateExportPath?: string;
  enableWordHighlight?: boolean;
  highlightColor?: 'white' | 'cyan' | 'yellow' | 'inverse' | 'underline';
  highlightIndexFromLeft?: boolean;
  highlightWrap?: boolean;
  highlightAutoScroll?: boolean;
  highlightClearOnEscape?: boolean;
  highlightClearOnNavigation?: boolean;
  highlightWordPattern?: 'whitespace' | 'alphanum' | string;
  highlightMode?: 'words' | 'numbers' | 'gender' | 'both';
  highlightExportEnabled?: boolean;
  highlightExportPath?: string;
  numberDimming?: boolean;
  enableDynamicHighlight?: boolean;
  dynamicHighlightScriptPath?: string;
  dynamicHighlightAutoSubmit?: boolean;
  dynamicHighlightDebounceMs?: number;
  actionWordOverrides?: { [word: string]: { action: string; scriptPath?: string; upArgs?: string[]; downArgs?: string[]; }; };
\`;

// Find MiscSettings interface and insert before its closing }
const miscMatch = content.match(/export interface MiscSettings \\{[^}]+/);
if (miscMatch) {
  const insertPos = miscMatch.index + miscMatch[0].length;
  content = content.slice(0, insertPos) + additions + content.slice(insertPos);
  fs.writeFileSync('$TYPES_FILE', content);
  console.log('  Added types to MiscSettings');
} else {
  console.error('  Error: Could not find MiscSettings interface');
  process.exit(1);
}
"
else
  echo "  Already patched"
fi

# 4. Add defaults to defaultSettings.ts
echo ""
echo "Patching defaultSettings.ts..."
DEFAULTS_FILE="$TWEAKCC_DIR/src/defaultSettings.ts"
if ! grep -q "enableCursorStateExport" "$DEFAULTS_FILE"; then
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$DEFAULTS_FILE', 'utf8');

const additions = \`
    // --- Cues Patches ---
    enableCursorStateExport: true,
    cursorStateExportPath: '/tmp/claude-cursor-state.json',
    enableWordHighlight: true,
    highlightColor: 'white',
    highlightIndexFromLeft: false,
    highlightWrap: false,
    highlightAutoScroll: true,
    highlightClearOnEscape: true,
    highlightClearOnNavigation: false,
    highlightWordPattern: 'whitespace',
    highlightMode: 'numbers',
    highlightExportEnabled: true,
    highlightExportPath: '/tmp/claude-highlight-state.json',
    numberDimming: true,
    enableDynamicHighlight: true,
    dynamicHighlightScriptPath: '~/.claude/llm-analyze.sh',
    dynamicHighlightAutoSubmit: true,
    dynamicHighlightDebounceMs: 500,
    actionWordOverrides: { volume: { action: 'volume', upArgs: ['up', '5'], downArgs: ['down', '5'] } },
\`;

// Find misc: { and insert after the opening brace
const miscMatch = content.match(/misc:\\s*\\{/);
if (miscMatch) {
  const insertPos = miscMatch.index + miscMatch[0].length;
  content = content.slice(0, insertPos) + additions + content.slice(insertPos);
  fs.writeFileSync('$DEFAULTS_FILE', content);
  console.log('  Added defaults to misc object');
} else {
  console.error('  Error: Could not find misc object');
  process.exit(1);
}
"
else
  echo "  Already patched"
fi

# 5. Add imports and patch calls to index.ts
echo ""
echo "Patching index.ts..."
INDEX_FILE="$TWEAKCC_DIR/src/patches/index.ts"
if ! grep -q "writeCursorStateExport" "$INDEX_FILE"; then
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$INDEX_FILE', 'utf8');

// Add imports after the last import statement
const importAddition = \`
import { writeCursorStateExport } from './cursorStateExport';
import { writeWordHighlight } from './wordHighlight';
import { writeDynamicHighlight } from './dynamicHighlight';
\`;

const lastImport = content.lastIndexOf('import ');
const lastImportEnd = content.indexOf(';', lastImport) + 1;
content = content.slice(0, lastImportEnd) + '\\n' + importAddition + content.slice(lastImportEnd);

// Add patch application code before the final write
const patchCode = \`

  // --- Cues Patches ---
  if (config.settings.misc?.enableCursorStateExport) {
    const exportPath = config.settings.misc?.cursorStateExportPath || '/tmp/claude-cursor-state.json';
    if ((result = writeCursorStateExport(content, exportPath))) content = result;
  }

  if (config.settings.misc?.enableWordHighlight) {
    const highlightConfig = {
      enableWordHighlight: config.settings.misc.enableWordHighlight,
      highlightColor: config.settings.misc.highlightColor,
      highlightIndexFromLeft: config.settings.misc.highlightIndexFromLeft,
      highlightWrap: config.settings.misc.highlightWrap,
      highlightAutoScroll: config.settings.misc.highlightAutoScroll,
      highlightClearOnEscape: config.settings.misc.highlightClearOnEscape,
      highlightClearOnNavigation: config.settings.misc.highlightClearOnNavigation,
      highlightWordPattern: config.settings.misc.highlightWordPattern,
      highlightMode: config.settings.misc.highlightMode,
      highlightExportEnabled: config.settings.misc.highlightExportEnabled,
      highlightExportPath: config.settings.misc.highlightExportPath,
      numberDimming: config.settings.misc.numberDimming,
      actionWordOverrides: config.settings.misc.actionWordOverrides,
    };
    if ((result = writeWordHighlight(content, highlightConfig))) content = result;
  }

  if (config.settings.misc?.enableDynamicHighlight !== false && config.settings.misc?.enableWordHighlight) {
    const dynamicConfig = {
      enableDynamicHighlight: true,
      dynamicHighlightScriptPath: config.settings.misc?.dynamicHighlightScriptPath || '~/.claude/llm-analyze.sh',
      dynamicHighlightAutoSubmit: config.settings.misc?.dynamicHighlightAutoSubmit || false,
      dynamicHighlightDebounceMs: config.settings.misc?.dynamicHighlightDebounceMs || 500,
    };
    if ((result = writeDynamicHighlight(content, dynamicConfig))) content = result;
  }

\`;

// Find where to insert - look for the final writeFileSync or return statement
const writeMatch = content.match(/writeFileSync|return content/);
if (writeMatch) {
  let insertPos = content.lastIndexOf('\\n', writeMatch.index) + 1;
  insertPos = content.lastIndexOf('\\n', insertPos - 2) + 1;
  content = content.slice(0, insertPos) + patchCode + content.slice(insertPos);
  fs.writeFileSync('$INDEX_FILE', content);
  console.log('  Added imports and patch calls');
} else {
  console.error('  Error: Could not find insertion point');
  process.exit(1);
}
"
else
  echo "  Already patched"
fi

# 6. Build cues-core and install
echo ""
echo "Building cues-core..."
CUES_CORE="$SCRIPT_DIR/../cues-core"
if [ -d "$CUES_CORE" ]; then
  cd "$CUES_CORE"
  npm install --silent 2>/dev/null || npm install
  npm run build --silent 2>/dev/null || npm run build

  mkdir -p ~/.claude/node_modules/cues-core
  cp dist/*.js dist/*.d.ts ~/.claude/node_modules/cues-core/ 2>/dev/null || true
  [ -d dist/sources ] && cp -r dist/sources ~/.claude/node_modules/cues-core/

  cat > ~/.claude/node_modules/cues-core/package.json << 'EOF'
{
  "name": "cues-core",
  "version": "1.0.0",
  "main": "index.js",
  "types": "index.d.ts"
}
EOF
  echo "  Installed to ~/.claude/node_modules/cues-core/"
else
  echo "  Warning: cues-core not found at $CUES_CORE"
fi

# 7. Copy supporting files
echo ""
echo "Installing supporting files..."
cp "$SCRIPT_DIR/claude-code-tips.json" ~/.claude/ 2>/dev/null && echo "  Copied tips file" || true
mkdir -p ~/.claude/actions
cp "$SCRIPT_DIR/actions/"* ~/.claude/actions/ 2>/dev/null && chmod +x ~/.claude/actions/*.sh 2>/dev/null && echo "  Copied action scripts" || true

# 8. Build tweakcc
echo ""
echo "Building tweakcc..."
cd "$TWEAKCC_DIR"
npm run build

# 9. Find and apply to Claude Code
echo ""
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" 2>/dev/null | head -1)
if [ -n "$CLI_JS" ]; then
  echo "Applying patches to Claude Code..."
  TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply

  echo ""
  echo "Verifying..."
  if node --check "$CLI_JS" 2>/dev/null; then
    echo "  Syntax OK"
  else
    echo "  Warning: Syntax check failed"
  fi
else
  echo "Claude Code cli.js not found. After installing Claude Code, run:"
  echo "  cd $TWEAKCC_DIR"
  echo "  CLI_JS=\$(find ~/.claude -name 'cli.js' -path '*claude-code*' | head -1)"
  echo "  TWEAKCC_CC_INSTALLATION_PATH=\"\$CLI_JS\" node dist/index.mjs --apply"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Set GROQ_API_KEY in your shell profile:"
echo "     export GROQ_API_KEY=\"your-key\""
echo ""
echo "  2. Restart Claude Code"
echo ""
echo "Test: Type a number, press Ctrl+Alt+Left, then Ctrl+Alt+Up"
