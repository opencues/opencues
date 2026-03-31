#!/bin/bash
#
# setup.sh - Automated setup for cues-patches
#
# Usage: ./setup.sh /path/to/tweakcc
#

set -e

TWEAKCC_DIR="${1:-$HOME/tweakcc}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Setting up cues-patches in: $TWEAKCC_DIR"

# Check tweakcc exists
if [ ! -d "$TWEAKCC_DIR/src/patches" ]; then
  echo "Error: $TWEAKCC_DIR/src/patches not found"
  echo "Usage: ./setup.sh /path/to/tweakcc"
  exit 1
fi

# 1. Copy patch files
echo "Copying patch files..."
cp "$SCRIPT_DIR/cursorStateExport.ts" "$TWEAKCC_DIR/src/patches/"
cp "$SCRIPT_DIR/wordHighlight.ts" "$TWEAKCC_DIR/src/patches/"
cp "$SCRIPT_DIR/dynamicHighlight.ts" "$TWEAKCC_DIR/src/patches/"

# 2. Add types to types.ts
echo "Patching types.ts..."
TYPES_FILE="$TWEAKCC_DIR/src/types.ts"
if ! grep -q "enableCursorStateExport" "$TYPES_FILE"; then
  # Find MiscSettings interface and add our fields before the closing brace
  # This looks for the last } in MiscSettings interface
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
  echo "  types.ts already patched"
fi

# 3. Add defaults to defaultSettings.ts
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
  echo "  defaultSettings.ts already patched"
fi

# 4. Add imports and patch calls to index.ts
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
  // Find the start of the line containing this
  let insertPos = content.lastIndexOf('\\n', writeMatch.index) + 1;
  // Go back a bit more to be safe
  insertPos = content.lastIndexOf('\\n', insertPos - 2) + 1;
  content = content.slice(0, insertPos) + patchCode + content.slice(insertPos);
  fs.writeFileSync('$INDEX_FILE', content);
  console.log('  Added imports and patch calls to index.ts');
} else {
  console.error('  Error: Could not find insertion point in index.ts');
  process.exit(1);
}
"
else
  echo "  index.ts already patched"
fi

# 5. Build cues-core and install
echo "Building and installing cues-core..."
CUES_CORE="$SCRIPT_DIR/../cues-core"
if [ -d "$CUES_CORE" ]; then
  cd "$CUES_CORE"
  npm install --silent 2>/dev/null || true
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
  echo "  cues-core installed to ~/.claude/node_modules/cues-core/"
else
  echo "  Warning: cues-core not found at $CUES_CORE"
fi

# 6. Copy supporting files
echo "Installing supporting files..."
cp "$SCRIPT_DIR/claude-code-tips.json" ~/.claude/ 2>/dev/null && echo "  Copied tips file" || true
mkdir -p ~/.claude/actions
cp "$SCRIPT_DIR/actions/"* ~/.claude/actions/ 2>/dev/null && chmod +x ~/.claude/actions/*.sh && echo "  Copied action scripts" || true

echo ""
echo "Done! Next steps:"
echo "  1. Set GROQ_API_KEY in your shell profile"
echo "  2. cd $TWEAKCC_DIR && npm run build"
echo "  3. node dist/index.mjs --apply"
echo "  4. Restart Claude Code"
