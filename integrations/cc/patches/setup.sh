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
CUES_CORE="$SCRIPT_DIR/../../../packages/opencues-core"
OC_RUNTIME="$SCRIPT_DIR/../../../packages/opencues-runtime"
NEEDS_TWEAKCC_BUILD=false
CLEAN_INSTALL=false
TWEAKCC_DIR=""

for arg in "$@"; do
  if [ "$arg" = "--clean" ]; then
    CLEAN_INSTALL=true
  elif [[ "$arg" != --* ]] && [ -z "$TWEAKCC_DIR" ]; then
    TWEAKCC_DIR="$arg"
  fi
done
TWEAKCC_DIR="${TWEAKCC_DIR:-$HOME/tweakcc}"

echo "=== OpenCues Setup ==="

# Check Node.js >= 18
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Please install Node.js 18 or later."
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node --version))."
  exit 1
fi

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
PATCH_FILES=(cursorStateExport.ts wordHighlight.ts dynamicHighlight.ts opencuesRuntime.ts)
PATCH_CHANGED=false
for f in "${PATCH_FILES[@]}"; do
  if ! cmp -s "$SCRIPT_DIR/$f" "$TWEAKCC_DIR/src/patches/$f" 2>/dev/null; then
    PATCH_CHANGED=true
    break
  fi
done
if $PATCH_CHANGED; then
  for f in "${PATCH_FILES[@]}"; do
    cp "$SCRIPT_DIR/$f" "$TWEAKCC_DIR/src/patches/"
  done
  echo "Copied patch files (${#PATCH_FILES[@]})"
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
        ttsSpeed: config.settings.misc?.ttsSpeed || 2,
        ttsScript: config.settings.misc?.ttsScript || '',
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

  # Cleanup legacy install path from before the @opencues scope rename
  # (Stage 4 of the repo restructure). Safe to run repeatedly.
  if [ -d ~/.claude/node_modules/cues-core ]; then
    echo "Removing legacy ~/.claude/node_modules/cues-core (pre-rename install)..."
    rm -rf ~/.claude/node_modules/cues-core
  fi

  if $CLEAN_INSTALL; then
    echo "Clean installing @opencues/core..."
    rm -rf ~/.claude/node_modules/@opencues/core
  fi
  mkdir -p ~/.claude/node_modules/@opencues/core
  cp "$CUES_CORE"/dist/*.js "$CUES_CORE"/dist/*.d.ts ~/.claude/node_modules/@opencues/core/ 2>/dev/null || true
  # Copy standalone files not compiled by tsc (e.g. node-http-adapter.js)
  [ -f "$CUES_CORE/node-http-adapter.js" ] && cp "$CUES_CORE/node-http-adapter.js" ~/.claude/node_modules/@opencues/core/
  if [ -d "$CUES_CORE/dist/sources" ]; then
    if $CLEAN_INSTALL; then
      rm -rf ~/.claude/node_modules/@opencues/core/sources
    fi
    cp -r "$CUES_CORE/dist/sources" ~/.claude/node_modules/@opencues/core/
  fi
  # Write package.json with corrected paths (dist files are installed flat, not in dist/)
  node -e "
const pkg = JSON.parse(require('fs').readFileSync('$CUES_CORE/package.json', 'utf8'));
pkg.main = 'index.js';
pkg.types = 'index.d.ts';
require('fs').writeFileSync(require('os').homedir() + '/.claude/node_modules/@opencues/core/package.json', JSON.stringify(pkg, null, 2));
"
fi

# 6b. Build + install @opencues/runtime alongside @opencues/core. The
#     Claude Code patch loads the runtime via
#     ~/.claude/node_modules/@opencues/runtime/. Without this step, BlankFill
#     control dispatch (hackernews / stocks / weather / answer / prompt /
#     opencues) silently fails because the hoisted control classes (post the
#     controls hoist refactor) live inside the runtime's dist/src/controls
#     directory.
if [ -d "$OC_RUNTIME" ]; then
  NEWEST_SRC=$(find "$OC_RUNTIME/src" "$OC_RUNTIME/adapters" -name '*.ts' -newer "$OC_RUNTIME/dist/src/index.js" 2>/dev/null | head -1)
  if [ ! -f "$OC_RUNTIME/dist/src/index.js" ] || [ -n "$NEWEST_SRC" ]; then
    echo "Building @opencues/runtime..."
    cd "$OC_RUNTIME"
    npm run build --silent 2>/dev/null || npm run build
    cd "$TWEAKCC_DIR"
  else
    echo "@opencues/runtime up to date"
  fi

  # Cleanup legacy install path from before the @opencues scope rename.
  if [ -d ~/.claude/node_modules/opencues-runtime ]; then
    echo "Removing legacy ~/.claude/node_modules/opencues-runtime (pre-rename install)..."
    rm -rf ~/.claude/node_modules/opencues-runtime
  fi

  if $CLEAN_INSTALL; then
    echo "Clean installing @opencues/runtime..."
    rm -rf ~/.claude/node_modules/@opencues/runtime
  fi
  # The runtime's directory layout (dist/src + dist/adapters) is non-trivial;
  # cleanest install is rsync of the whole tree, then drop a slimmed
  # package.json with the same main path the source declares.
  mkdir -p ~/.claude/node_modules/@opencues/runtime/dist
  # Use rsync if present; else cp -r (mirrors recursively, removes deleted files
  # only via rsync's --delete which we set to keep stale .js out).
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$OC_RUNTIME/dist/" ~/.claude/node_modules/@opencues/runtime/dist/
  else
    rm -rf ~/.claude/node_modules/@opencues/runtime/dist
    cp -r "$OC_RUNTIME/dist" ~/.claude/node_modules/@opencues/runtime/dist
  fi
  cp "$OC_RUNTIME/package.json" ~/.claude/node_modules/@opencues/runtime/package.json
fi

# 7. Copy supporting files (cheap — always run)
cp "$SCRIPT_DIR/claude-code-tips.json" ~/.claude/ 2>/dev/null || true
mkdir -p ~/.claude/actions
cp "$SCRIPT_DIR/actions/"* ~/.claude/actions/ 2>/dev/null && chmod +x ~/.claude/actions/*.sh 2>/dev/null || true
cp "$SCRIPT_DIR/highlight-statusline.sh" ~/.claude/ 2>/dev/null && chmod +x ~/.claude/highlight-statusline.sh 2>/dev/null || true

# 7b. Compile cue-control .exe files on WSL (skip on native Linux)
# Sources: patches/actions/*.cs AND controls/*/*.cs (colocated with control configs)
if [ -f /mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe ]; then
  CSC="/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
  WIN_USER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r\n')
  WIN_TMP="/mnt/c/Users/$WIN_USER"
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  CS_FILES=()
  for f in "$SCRIPT_DIR/actions/"*.cs "$REPO_ROOT/controls/"*/*.cs; do
    [ -f "$f" ] && CS_FILES+=("$f")
  done
  for CS_FILE in "${CS_FILES[@]}"; do
    BASE=$(basename "$CS_FILE" .cs)
    EXE="$HOME/.claude/actions/${BASE}.exe"
    if [ ! -f "$EXE" ] || [ "$CS_FILE" -nt "$EXE" ]; then
      cp "$CS_FILE" "$WIN_TMP/${BASE}.cs"
      CSC_ARGS="/nologo /optimize"
      [ "$BASE" = "SpeakCtl" ] && CSC_ARGS="$CSC_ARGS /reference:C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\WPF\\System.Speech.dll"
      "$CSC" $CSC_ARGS "/out:C:\\Users\\${WIN_USER}\\${BASE}.exe" "C:\\Users\\${WIN_USER}\\${BASE}.cs" 2>/dev/null
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
  echo ""
  echo "=== Setup Complete — restart Claude Code to activate ==="
else
  echo ""
  echo "=== ERROR: Claude Code not found ==="
  echo "cli.js was not found. Apply patches manually once Claude Code is installed:"
  echo "  cd $TWEAKCC_DIR"
  echo "  CLI_JS=\$(find ~/.claude -name 'cli.js' -path '*claude-code*' | head -1)"
  echo "  TWEAKCC_CC_INSTALLATION_PATH=\"\$CLI_JS\" node dist/index.mjs --apply"
  exit 1
fi
