#!/bin/bash
#
# setup.sh - One-command setup for cues-patches + tweakcc
#
# Usage: ./setup.sh [tweakcc-dir]
#
# If no directory specified, clones tweakcc to ~/tweakcc
# Re-runs are fast: skips clone, npm install, and unchanged builds.
#
# Set OPENCUES_INSTALL_VERBOSE=1 to stream every command's output.
# Default is quiet — only top-level progress lines + errors. Full log
# lives at the path printed on failure.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CUES_CORE="$SCRIPT_DIR/../../../packages/opencues-core"
OC_RUNTIME="$SCRIPT_DIR/../../../packages/opencues-runtime"
NEEDS_TWEAKCC_BUILD=false
CLEAN_INSTALL=false
TWEAKCC_DIR=""

# ─── progress helpers ────────────────────────────────────────────────
LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-cc.log}"
VERBOSE="${OPENCUES_INSTALL_VERBOSE:-0}"
: > "$LOG"

# In quiet mode we save the real stdout/stderr on fd 3/4 and redirect
# the default fds to the log. Internal echoes from the rest of the
# script automatically land in the log rather than the terminal.
# begin_step/end_step use fd 3 to print the one progress line per step.
if [ "$VERBOSE" = "1" ]; then
  exec 3>&1 4>&2
else
  exec 3>&1 4>&2
  exec >>"$LOG" 2>&1
fi

CURRENT_STEP=""
begin_step() {
  CURRENT_STEP="$1"
  if [ "$VERBOSE" = "1" ]; then
    printf '  ▸ %s\n' "$CURRENT_STEP" >&3
  else
    printf '  ▸ %s' "$CURRENT_STEP" >&3
  fi
}
end_step() {
  if [ "$VERBOSE" = "1" ]; then
    printf '  ✓ %s\n' "$CURRENT_STEP" >&3
  else
    printf ' ✓\n' >&3
  fi
  CURRENT_STEP=""
}
on_error() {
  local rc=$?
  if [ -n "$CURRENT_STEP" ] && [ "$VERBOSE" != "1" ]; then
    printf ' ✗\n' >&4
  fi
  if [ -n "$CURRENT_STEP" ]; then
    echo "" >&4
    echo "Step failed: $CURRENT_STEP (exit $rc)" >&4
  fi
  if [ "$VERBOSE" != "1" ] && [ -s "$LOG" ]; then
    echo "Last 30 lines of $LOG:" >&4
    tail -30 "$LOG" >&4
    echo "" >&4
    echo "Full log: $LOG  —  re-run with OPENCUES_INSTALL_VERBOSE=1 to stream live." >&4
  fi
  exit $rc
}
trap on_error ERR

# Single-dir install root. Everything @opencues/claude-code owns lives here so
# uninstall is `rm -rf $OC_INSTALL_ROOT` + tweakcc revert. tweakcc's own
# config + cli.js.backup are redirected here too via TWEAKCC_CONFIG_DIR
# (tweakcc respects this env var; see tweakcc/src/tests/tweakccConfigDir.test.ts).
OC_INSTALL_ROOT="$HOME/.claude/opencues"
export TWEAKCC_CONFIG_DIR="$OC_INSTALL_ROOT/tweakcc-state"
mkdir -p "$OC_INSTALL_ROOT" "$TWEAKCC_CONFIG_DIR"

for arg in "$@"; do
  if [ "$arg" = "--clean" ]; then
    CLEAN_INSTALL=true
  elif [[ "$arg" != --* ]] && [ -z "$TWEAKCC_DIR" ]; then
    TWEAKCC_DIR="$arg"
  fi
done
TWEAKCC_DIR="${TWEAKCC_DIR:-$HOME/tweakcc}"

# Check Node.js >= 18 (runs before first begin_step so its errors are
# shown directly, not wrapped in a step label).
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Please install Node.js 18 or later." >&4
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node --version))." >&4
  exit 1
fi

# 1. Clone or reuse tweakcc
begin_step "Setting up tweakcc"
if [ ! -d "$TWEAKCC_DIR" ]; then
  echo "Cloning tweakcc..."
  git clone https://github.com/Piebald-AI/tweakcc "$TWEAKCC_DIR"
  cd "$TWEAKCC_DIR"
  npm install --legacy-peer-deps
  NEEDS_TWEAKCC_BUILD=true
elif [ ! -d "$TWEAKCC_DIR/src/patches" ]; then
  echo "Error: $TWEAKCC_DIR exists but doesn't look like tweakcc" >&4
  exit 1
else
  cd "$TWEAKCC_DIR"
fi
end_step

begin_step "Patching tweakcc source"
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
end_step

begin_step "Building @opencues/{core,runtime}"
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

  # Cleanup legacy install paths from before consolidation:
  # - cues-core (pre-Stage-4a rename)
  # - @opencues/core under node_modules (pre-Stage-6'-consolidation)
  for legacy in ~/.claude/node_modules/cues-core ~/.claude/node_modules/@opencues/core; do
    if [ -d "$legacy" ]; then
      echo "Removing legacy $legacy ..."
      rm -rf "$legacy"
    fi
  done
  # Tidy the empty @opencues parent dir (best effort).
  rmdir ~/.claude/node_modules/@opencues 2>/dev/null || true

  if $CLEAN_INSTALL; then
    echo "Clean installing @opencues/core..."
    rm -rf "$OC_INSTALL_ROOT/core"
  fi
  mkdir -p "$OC_INSTALL_ROOT/core"
  cp "$CUES_CORE"/dist/*.js "$CUES_CORE"/dist/*.d.ts "$OC_INSTALL_ROOT/core/" 2>/dev/null || true
  # Copy standalone files not compiled by tsc (e.g. node-http-adapter.js)
  [ -f "$CUES_CORE/node-http-adapter.js" ] && cp "$CUES_CORE/node-http-adapter.js" "$OC_INSTALL_ROOT/core/"
  if [ -d "$CUES_CORE/dist/sources" ]; then
    if $CLEAN_INSTALL; then
      rm -rf "$OC_INSTALL_ROOT/core/sources"
    fi
    cp -r "$CUES_CORE/dist/sources" "$OC_INSTALL_ROOT/core/"
  fi
  # Write package.json with corrected paths (dist files are installed flat, not in dist/)
  node -e "
const pkg = JSON.parse(require('fs').readFileSync('$CUES_CORE/package.json', 'utf8'));
pkg.main = 'index.js';
pkg.types = 'index.d.ts';
require('fs').writeFileSync('$OC_INSTALL_ROOT/core/package.json', JSON.stringify(pkg, null, 2));
"
fi

# 6b. Build + install @opencues/runtime under $OC_INSTALL_ROOT/runtime/.
#     The patched cli.js loads from there (see opencuesRuntime.ts).
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

  # Cleanup legacy install paths from before consolidation.
  for legacy in ~/.claude/node_modules/opencues-runtime ~/.claude/node_modules/@opencues/runtime; do
    if [ -d "$legacy" ]; then
      echo "Removing legacy $legacy ..."
      rm -rf "$legacy"
    fi
  done
  rmdir ~/.claude/node_modules/@opencues 2>/dev/null || true

  if $CLEAN_INSTALL; then
    echo "Clean installing @opencues/runtime..."
    rm -rf "$OC_INSTALL_ROOT/runtime"
  fi
  mkdir -p "$OC_INSTALL_ROOT/runtime/dist"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$OC_RUNTIME/dist/" "$OC_INSTALL_ROOT/runtime/dist/"
  else
    rm -rf "$OC_INSTALL_ROOT/runtime/dist"
    cp -r "$OC_RUNTIME/dist" "$OC_INSTALL_ROOT/runtime/dist"
  fi
  cp "$OC_RUNTIME/package.json" "$OC_INSTALL_ROOT/runtime/package.json"
fi
end_step

begin_step "Installing support files (tips, actions, statusline)"
# 7. Copy supporting files into $OC_INSTALL_ROOT (cheap — always run).
#    Cleanup of legacy ~/.claude/{claude-code-tips.json, highlight-statusline.sh,
#    actions/<our files>} is best-effort — only files we know we shipped.
[ -f ~/.claude/claude-code-tips.json ] && rm ~/.claude/claude-code-tips.json
[ -f ~/.claude/highlight-statusline.sh ] && rm ~/.claude/highlight-statusline.sh
for f in speak.sh brightness.sh brightness-set.ps1 BrightCtl.cs BrightCtl.exe SpeakCtl.cs SpeakCtl.exe; do
  [ -f ~/.claude/actions/"$f" ] && rm ~/.claude/actions/"$f"
done

cp "$SCRIPT_DIR/claude-code-tips.json" "$OC_INSTALL_ROOT/tips.json" 2>/dev/null || true
mkdir -p "$OC_INSTALL_ROOT/actions"
cp "$SCRIPT_DIR/actions/"* "$OC_INSTALL_ROOT/actions/" 2>/dev/null && chmod +x "$OC_INSTALL_ROOT/actions/"*.sh 2>/dev/null || true
cp "$SCRIPT_DIR/highlight-statusline.sh" "$OC_INSTALL_ROOT/statusline.sh" 2>/dev/null && chmod +x "$OC_INSTALL_ROOT/statusline.sh" 2>/dev/null || true

# 7b. Compile cue-control .exe files on WSL (skip on native Linux)
# Sources: patches/actions/*.cs AND controls/*/*.cs (colocated with control configs)
if [ -f /mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe ]; then
  CSC="/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
  WIN_USER=$(cmd.exe /c "echo %USERNAME%" 2>/dev/null | tr -d '\r\n')
  WIN_TMP="/mnt/c/Users/$WIN_USER"
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  CS_FILES=()
  for f in "$SCRIPT_DIR/actions/"*.cs "$REPO_ROOT/.opencues/controls/"*/*.cs; do
    [ -f "$f" ] && CS_FILES+=("$f")
  done
  for CS_FILE in "${CS_FILES[@]}"; do
    BASE=$(basename "$CS_FILE" .cs)
    EXE="$OC_INSTALL_ROOT/actions/${BASE}.exe"
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
end_step

begin_step "Building tweakcc"
# 8. Build tweakcc (skip if no changes)
cd "$TWEAKCC_DIR"
if $NEEDS_TWEAKCC_BUILD || [ ! -f "$TWEAKCC_DIR/dist/index.mjs" ]; then
  echo "Building tweakcc..."
  npm run build
else
  echo "tweakcc up to date"
fi
end_step

begin_step "Applying patches to cli.js"
# 9. Apply to Claude Code.
# The caller (install.cjs) may have already resolved the target and
# passed it via OPENCUES_CC_TARGET. Otherwise find it ourselves under
# the two common install paths.
CLI_JS="${OPENCUES_CC_TARGET:-}"
if [ -z "$CLI_JS" ]; then
  CLI_JS=$(find ~/.claude ~/local-claude-code -name "cli.js" -path "*claude-code*" 2>/dev/null | head -1)
fi
if [ -n "$CLI_JS" ]; then
  TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
  if ! node --check "$CLI_JS" 2>/dev/null; then
    echo "Warning: Syntax check failed on $CLI_JS"
  fi
  end_step
  echo "" >&3
  echo "Done. Restart Claude Code to activate." >&3
else
  # Soft failure: finish the step as a skip, let the caller decide
  # whether to try --target fallback or report the error.
  end_step
  echo "" >&4
  echo "NOTE: cli.js not found under ~/.claude/ or ~/local-claude-code/." >&4
  echo "Pass --target /path/to/cli.js to opencues install claude-code, or install" >&4
  echo "Claude Code first and re-run." >&4
  exit 2
fi
