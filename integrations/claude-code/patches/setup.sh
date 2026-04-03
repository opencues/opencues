#!/bin/bash
#
# setup.sh - One-command setup for cues-patches + tweakcc
#
# Usage: ./setup.sh [tweakcc-dir]
#
# If no directory specified, clones tweakcc to ~/tweakcc
# Re-runs are fast: skips clone, npm install, and unchanged builds.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TWEAKCC_DIR="${1:-$HOME/tweakcc}"
CUES_CORE="$SCRIPT_DIR/../../../packages/cues-core"
NEEDS_TWEAKCC_BUILD=false

echo "=== OpenCues Setup ==="

# 1. Clone or reuse tweakcc
if [ ! -d "$TWEAKCC_DIR" ]; then
  echo "Cloning tweakcc..."
  git clone https://github.com/Piebald-AI/tweakcc "$TWEAKCC_DIR"
  cd "$TWEAKCC_DIR"
  npm install --legacy-peer-deps
  NEEDS_TWEAKCC_BUILD=true
elif [ ! -d "$TWEAKCC_DIR/src/patches" ]; then
  echo "Error: $TWEAKCC_DIR exists but doesn't look like tweakcc"
  exit 1
else
  cd "$TWEAKCC_DIR"
fi

# 2. Copy patch files (always — cheap, ensures latest)
PATCH_CHANGED=false
for f in cursorStateExport.ts wordHighlight.ts dynamicHighlight.ts; do
  if ! cmp -s "$SCRIPT_DIR/$f" "$TWEAKCC_DIR/src/patches/$f" 2>/dev/null; then
    PATCH_CHANGED=true
    break
  fi
done
if $PATCH_CHANGED; then
  cp "$SCRIPT_DIR/cursorStateExport.ts" "$TWEAKCC_DIR/src/patches/"
  cp "$SCRIPT_DIR/wordHighlight.ts" "$TWEAKCC_DIR/src/patches/"
  cp "$SCRIPT_DIR/dynamicHighlight.ts" "$TWEAKCC_DIR/src/patches/"
  echo "Copied patch files"
  NEEDS_TWEAKCC_BUILD=true
else
  echo "Patch files unchanged"
fi

# 3. Patch types.ts (skip if already done)
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
  highlightMode?: 'words' | 'numbers';
  highlightExportEnabled?: boolean;
  highlightExportPath?: string;
  numberDimming?: boolean;
  enableDynamicHighlight?: boolean;
  dynamicHighlightScriptPath?: string;
  dynamicHighlightAutoSubmit?: boolean;
  dynamicHighlightDebounceMs?: number;
  cueControlOverrides?: { [word: string]: { control: string; scriptPath?: string; upArgs?: string[]; downArgs?: string[]; }; };
\`;

const miscMatch = content.match(/export interface MiscConfig \\{[^}]+/);
if (miscMatch) {
  const insertPos = miscMatch.index + miscMatch[0].length;
  content = content.slice(0, insertPos) + additions + content.slice(insertPos);
  fs.writeFileSync('$TYPES_FILE', content);
  console.log('Patched types.ts');
} else {
  console.error('Error: Could not find MiscConfig interface');
  process.exit(1);
}
"
  NEEDS_TWEAKCC_BUILD=true
fi

# 4. Patch defaultSettings.ts (skip if already done)
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
    highlightMode: 'words',
    highlightExportEnabled: true,
    highlightExportPath: '/tmp/claude-highlight-state.json',
    numberDimming: true,
    enableDynamicHighlight: true,
    dynamicHighlightScriptPath: '~/.claude/llm-analyze.sh',
    dynamicHighlightAutoSubmit: true,
    dynamicHighlightDebounceMs: 500,
    cueControlOverrides: { volume: { control: 'volume', upArgs: ['up', '5'], downArgs: ['down', '5'] } },
\`;

const miscMatch = content.match(/misc:\\s*\\{/);
if (miscMatch) {
  const insertPos = miscMatch.index + miscMatch[0].length;
  content = content.slice(0, insertPos) + additions + content.slice(insertPos);
  fs.writeFileSync('$DEFAULTS_FILE', content);
  console.log('Patched defaultSettings.ts');
} else {
  console.error('Error: Could not find misc object');
  process.exit(1);
}
"
  NEEDS_TWEAKCC_BUILD=true
fi

# 5. Patch index.ts (skip if already done)
INDEX_FILE="$TWEAKCC_DIR/src/patches/index.ts"
if ! grep -q "writeCursorStateExport" "$INDEX_FILE"; then
  node -e "
const fs = require('fs');
let content = fs.readFileSync('$INDEX_FILE', 'utf8');

const importAddition = \`
import { writeCursorStateExport } from './cursorStateExport';
import { writeWordHighlight } from './wordHighlight';
import { writeDynamicHighlight } from './dynamicHighlight';
\`;

const lastImport = content.lastIndexOf('import ');
const lastImportEnd = content.indexOf(';', lastImport) + 1;
content = content.slice(0, lastImportEnd) + '\\n' + importAddition + content.slice(lastImportEnd);

const patchCode = \`

  // --- Cues Patches ---
  {
    let result: string | null;
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
        cueControlOverrides: config.settings.misc.cueControlOverrides,
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
  }

\`;

const writeBackMatch = content.match(/\\/\\/ =+\\s*\\n\\s*\\/\\/ Write the modified content back/);
if (writeBackMatch) {
  const insertPos = writeBackMatch.index;
  content = content.slice(0, insertPos) + patchCode + '\\n' + content.slice(insertPos);
  fs.writeFileSync('$INDEX_FILE', content);
  console.log('Patched index.ts');
} else {
  console.error('Error: Could not find Write the modified content back section');
  process.exit(1);
}
"
  NEEDS_TWEAKCC_BUILD=true
fi

# 6. Build cues-core (skip if dist is newer than src)
if [ -d "$CUES_CORE" ]; then
  NEWEST_SRC=$(find "$CUES_CORE/src" -name '*.ts' -newer "$CUES_CORE/dist/index.js" 2>/dev/null | head -1)
  if [ ! -f "$CUES_CORE/dist/index.js" ] || [ -n "$NEWEST_SRC" ]; then
    echo "Building cues-core..."
    cd "$CUES_CORE"
    npm run build --silent 2>/dev/null || npm run build
    cd "$TWEAKCC_DIR"
  else
    echo "cues-core up to date"
  fi

  mkdir -p ~/.claude/node_modules/cues-core
  cp "$CUES_CORE"/dist/*.js "$CUES_CORE"/dist/*.d.ts ~/.claude/node_modules/cues-core/ 2>/dev/null || true
  [ -d "$CUES_CORE/dist/sources" ] && cp -r "$CUES_CORE/dist/sources" ~/.claude/node_modules/cues-core/

  cat > ~/.claude/node_modules/cues-core/package.json << 'EOF'
{
  "name": "cues-core",
  "version": "1.0.0",
  "main": "index.js",
  "types": "index.d.ts"
}
EOF
fi

# 7. Copy supporting files (cheap — always run)
cp "$SCRIPT_DIR/claude-code-tips.json" ~/.claude/ 2>/dev/null || true
mkdir -p ~/.claude/actions
cp "$SCRIPT_DIR/actions/"* ~/.claude/actions/ 2>/dev/null && chmod +x ~/.claude/actions/*.sh 2>/dev/null || true
cp "$SCRIPT_DIR/highlight-statusline.sh" ~/.claude/ 2>/dev/null && chmod +x ~/.claude/highlight-statusline.sh 2>/dev/null || true

# 7b. Compile cue-control .exe files on WSL (skip on native Linux)
if [ -f /mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe ]; then
  CSC="/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
  WIN_USER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r\n')
  WIN_TMP="/mnt/c/Users/$WIN_USER"
  for CS_FILE in "$SCRIPT_DIR/actions/"*.cs; do
    [ -f "$CS_FILE" ] || continue
    BASE=$(basename "$CS_FILE" .cs)
    EXE="$HOME/.claude/actions/${BASE}.exe"
    if [ ! -f "$EXE" ] || [ "$CS_FILE" -nt "$EXE" ]; then
      cp "$CS_FILE" "$WIN_TMP/${BASE}.cs"
      "$CSC" /nologo /optimize "/out:C:\\Users\\${WIN_USER}\\${BASE}.exe" "C:\\Users\\${WIN_USER}\\${BASE}.cs" 2>/dev/null
      if [ -f "$WIN_TMP/${BASE}.exe" ]; then
        cp "$WIN_TMP/${BASE}.exe" "$EXE"
        echo "Compiled ${BASE}.exe"
      fi
      rm -f "$WIN_TMP/${BASE}.cs" "$WIN_TMP/${BASE}.exe" 2>/dev/null
    fi
  done
fi

# 8. Build tweakcc (skip if no changes)
cd "$TWEAKCC_DIR"
if $NEEDS_TWEAKCC_BUILD || [ ! -f "$TWEAKCC_DIR/dist/index.mjs" ]; then
  echo "Building tweakcc..."
  npm run build
else
  echo "tweakcc up to date"
fi

# 9. Apply to Claude Code
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" 2>/dev/null | head -1)
if [ -n "$CLI_JS" ]; then
  echo "Applying patches..."
  TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply

  if node --check "$CLI_JS" 2>/dev/null; then
    echo "Syntax OK"
  else
    echo "Warning: Syntax check failed"
  fi
else
  echo "Claude Code cli.js not found."
  echo "  cd $TWEAKCC_DIR"
  echo "  CLI_JS=\$(find ~/.claude -name 'cli.js' -path '*claude-code*' | head -1)"
  echo "  TWEAKCC_CC_INSTALLATION_PATH=\"\$CLI_JS\" node dist/index.mjs --apply"
fi

echo ""
echo "=== Setup Complete ==="
