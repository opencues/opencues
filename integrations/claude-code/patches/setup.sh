#!/bin/bash
#
# setup.sh — install OpenCues into Claude Code (claude-cues fork).
#
# Always-from-scratch by default: every install nukes prior state and
# rebuilds deterministically. The ONLY way to drift is to opt in via
# --keep-state (dev iteration only).
#
# Usage:
#   ./setup.sh [tweakcc-dir] [--keep-state]
#
# State that gets nuked + rebuilt every install (default):
#   ~/claude-code-cues/.opencues/                        recreated (incl. tweakcc clone)
#   ~/claude-code-cues/node_modules/@opencues/{core,runtime}/  rebuilt + recopied
#   ~/claude-code-cues/node_modules/@anthropic-ai/       reinstalled (pinned 2.1.110)
#
# State that survives every install:
#   ~/.cues/  (incl. OPENCUES.md)                        user content (your cue.md edits etc.)
#   ~/claude-code-cues/package.json                      version pin
#   <repo>/integrations/claude-code/patches/             repo source (not touched)
#
# Compact-footprint contract: every byte the CC integration owns lives
# under ~/claude-code-cues/. Uninstall = tweakcc revert + `rm -rf ~/claude-code-cues`.
#
# Env knobs:
#   OPENCUES_INSTALL_VERBOSE=1   stream every command's output (default: quiet)
#   OPENCUES_INSTALL_LOG=<path>  log file location (default: /tmp/opencues-install-cc.log)
#   OPENCUES_CC_TARGET=<path>    cli.js to patch (default: auto-detect under fork)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CUES_CORE="$REPO_ROOT/packages/opencues-core"
OC_RUNTIME="$REPO_ROOT/packages/opencues-runtime"
TWEAKCC_DIR_OVERRIDE=""
KEEP_STATE=false

# ─── arg parsing ──────────────────────────────────────────────────────
for arg in "$@"; do
  if [ "$arg" = "--keep-state" ]; then
    KEEP_STATE=true
  elif [ "$arg" = "--clean" ]; then
    : # legacy alias — clean is now the default; flag is a no-op
  elif [[ "$arg" != --* ]] && [ -z "$TWEAKCC_DIR_OVERRIDE" ]; then
    TWEAKCC_DIR_OVERRIDE="$arg"
  fi
done
# TWEAKCC_DIR default is set below, AFTER we know the fork dir, so it can
# default to <fork>/.cues/tweakcc (compact-footprint — single blast
# radius). Override (positional arg) is for hacking on a side checkout.

# ─── progress + logging helpers ───────────────────────────────────────
LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-cc.log}"
VERBOSE="${OPENCUES_INSTALL_VERBOSE:-0}"
: > "$LOG"
if [ "$VERBOSE" = "1" ]; then
  exec 3>&1 4>&2
else
  exec 3>&1 4>&2
  exec >>"$LOG" 2>&1
fi
CURRENT_STEP=""
begin_step() {
  CURRENT_STEP="$1"
  if [ "$VERBOSE" = "1" ]; then printf '  ▸ %s\n' "$CURRENT_STEP" >&3
  else printf '  ▸ %s' "$CURRENT_STEP" >&3; fi
}
end_step() {
  if [ "$VERBOSE" = "1" ]; then printf '  ✓ %s\n' "$CURRENT_STEP" >&3
  else printf ' ✓\n' >&3; fi
  CURRENT_STEP=""
}
on_error() {
  local rc=$?
  [ -n "$CURRENT_STEP" ] && [ "$VERBOSE" != "1" ] && printf ' ✗\n' >&4
  [ -n "$CURRENT_STEP" ] && { echo "" >&4; echo "Step failed: $CURRENT_STEP (exit $rc)" >&4; }
  if [ "$VERBOSE" != "1" ] && [ -s "$LOG" ]; then
    echo "Last 30 lines of $LOG:" >&4
    tail -30 "$LOG" >&4
    echo "" >&4
    echo "Full log: $LOG  —  re-run with OPENCUES_INSTALL_VERBOSE=1 to stream live." >&4
  fi
  exit $rc
}
trap on_error ERR

# ─── prerequisites ────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Please install Node.js 18 or later." >&4
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18+ required (found $(node --version))." >&4
  exit 1
fi

# ─── locate the CC fork (the dir whose package.json pins claude-code) ─
# Default fork location: ~/claude-code-cues. Allow override via OPENCUES_CC_TARGET
# pointing at a cli.js inside any other fork.
if [ -n "${OPENCUES_CC_TARGET:-}" ]; then
  # OPENCUES_CC_TARGET points at <fork>/node_modules/@anthropic-ai/claude-code/cli.js
  CC_FORK_DIR="$(cd "$(dirname "$OPENCUES_CC_TARGET")/../../.." && pwd)"
else
  CC_FORK_DIR="$HOME/claude-code-cues"
fi
if [ ! -f "$CC_FORK_DIR/package.json" ]; then
  echo "Error: $CC_FORK_DIR/package.json missing." >&4
  echo "Create the fork dir first with a package.json that pins claude-code:" >&4
  echo "  mkdir -p $CC_FORK_DIR" >&4
  echo "  echo '{\"dependencies\":{\"@anthropic-ai/claude-code\":\"2.1.110\"}}' > $CC_FORK_DIR/package.json" >&4
  exit 1
fi
# Sanity-check the pin is exact (no caret / tilde — those allow drift).
PINNED_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$CC_FORK_DIR/package.json','utf8')).dependencies['@anthropic-ai/claude-code'] || '')")
if [[ "$PINNED_VERSION" =~ ^(\^|~) ]]; then
  echo "Warning: $CC_FORK_DIR/package.json pins @anthropic-ai/claude-code with a range ($PINNED_VERSION)." >&4
  echo "  Caret/tilde ranges allow npm install to drift to incompatible versions." >&4
  echo "  Edit package.json to pin an EXACT version (e.g. \"2.1.110\")." >&4
fi

OC_INSTALL_ROOT="$CC_FORK_DIR/.cues"
OC_NM_DIR="$CC_FORK_DIR/node_modules/@opencues"
TWEAKCC_DIR="${TWEAKCC_DIR_OVERRIDE:-$OC_INSTALL_ROOT/tweakcc}"
export TWEAKCC_CONFIG_DIR="$OC_INSTALL_ROOT/patch-state"

# ─── 1. Nuke prior state (default) or skip (--keep-state for dev) ────
begin_step "Nuking prior install state"
if $KEEP_STATE; then
  echo "  --keep-state: keeping .cues (incl. tweakcc) + fork node_modules"
  mkdir -p "$OC_INSTALL_ROOT" "$TWEAKCC_CONFIG_DIR" "$OC_NM_DIR"
else
  # Note: $TWEAKCC_DIR defaults to $OC_INSTALL_ROOT/tweakcc, so the
  # $OC_INSTALL_ROOT nuke covers it. If --target was used to point at a
  # side checkout, we leave it alone (developer's hacking copy).
  rm -rf "$OC_INSTALL_ROOT"
  rm -rf "$OC_NM_DIR"
  rm -rf "$CC_FORK_DIR/node_modules/@anthropic-ai"
  if [ -n "$TWEAKCC_DIR_OVERRIDE" ] && [ -d "$TWEAKCC_DIR_OVERRIDE" ]; then
    echo "  --target $TWEAKCC_DIR_OVERRIDE provided: NOT nuking that dir (hacking copy)"
  fi
  mkdir -p "$OC_INSTALL_ROOT" "$TWEAKCC_CONFIG_DIR" "$OC_NM_DIR"
  echo "  removed: $OC_INSTALL_ROOT (incl. tweakcc), fork's @opencues + @anthropic-ai"
fi
end_step

# ─── 2. Reinstall pinned cli.js into the fork ─────────────────────────
# `npm install` reads the fork's package.json, which pins an EXACT CC
# version (no caret) — so this always installs the same artifact bit-
# for-bit. Skipped under --keep-state to preserve any in-progress edits.
begin_step "Installing pinned @anthropic-ai/claude-code"
if $KEEP_STATE && [ -f "$CC_FORK_DIR/node_modules/@anthropic-ai/claude-code/cli.js" ]; then
  echo "  --keep-state: cli.js already present at $CC_FORK_DIR — skipping npm install"
else
  (cd "$CC_FORK_DIR" && rm -f package-lock.json && npm install --no-audit --no-fund 2>&1 | tail -5)
fi
CLI_JS="$CC_FORK_DIR/node_modules/@anthropic-ai/claude-code/cli.js"
if [ ! -f "$CLI_JS" ]; then
  echo "Error: cli.js still missing at $CLI_JS after npm install." >&4
  echo "  Pinned version: $PINNED_VERSION" >&4
  echo "  Some CC versions ship as native binaries (no cli.js) — pin to a JS-cli version." >&4
  exit 1
fi
end_step

# ─── 3. Clone tweakcc + install its deps ──────────────────────────────
begin_step "Cloning tweakcc"
if $KEEP_STATE && [ -d "$TWEAKCC_DIR/.git" ]; then
  echo "  --keep-state: $TWEAKCC_DIR exists, resetting source files we patch"
  (cd "$TWEAKCC_DIR" && git checkout HEAD -- src/types.ts src/defaultSettings.ts src/patches/index.ts 2>/dev/null || true)
else
  git clone https://github.com/Piebald-AI/tweakcc "$TWEAKCC_DIR"
  (cd "$TWEAKCC_DIR" && npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -3)
fi
end_step

# ─── 4. Copy patch source + wire orchestrator ────────────────────────
# Single source file: opencuesRuntime.ts. Older versions of this script
# also copied per-feature v1 patches (cursorStateExport / wordHighlight /
# dynamicHighlight); v2 replaced them with the in-process @opencues/runtime,
# and they were removed from the repo.
begin_step "Patching tweakcc source"
cp "$SCRIPT_DIR/opencuesRuntime.ts" "$TWEAKCC_DIR/src/patches/"

# 4a. Hide tweakcc's launch banner + patches-applied indicator. We
# don't add new MiscConfig fields — the v2 patch is unconditional and
# doesn't need its own settings.
sed -i 's/showTweakccVersion: true/showTweakccVersion: false/g' "$TWEAKCC_DIR/src/defaultSettings.ts"
sed -i 's/showPatchesApplied: true/showPatchesApplied: false/g' "$TWEAKCC_DIR/src/defaultSettings.ts"
echo "Flipped showTweakccVersion + showPatchesApplied to false"

# 4b. Patch patches/index.ts — import the v2 writer + wire it
# unconditionally into the orchestrator. Section 4d below disables
# every other tweakcc patch, so opencues v2 is the only thing that
# touches cli.js.
INDEX_FILE="$TWEAKCC_DIR/src/patches/index.ts"
node -e "
const fs = require('fs');
let content = fs.readFileSync('$INDEX_FILE', 'utf8');
const importAddition = \`
import { writeOpenCuesRuntimeV2 } from './opencuesRuntime';
\`;
const lastImport = content.lastIndexOf('import ');
const lastImportEnd = content.indexOf(';', lastImport) + 1;
content = content.slice(0, lastImportEnd) + '\\n' + importAddition + content.slice(lastImportEnd);

const patchCode = \`

  // --- Cues Patch (v2) ---
  // Single bootstrap injected at S1/S3/S6 seams; full feature surface
  // (navigation, cycling, blanks, agent rewrite, …) lives in
  // \\\`@opencues/runtime\\\` which the boot loads at runtime.
  {
    const result = writeOpenCuesRuntimeV2(content);
    if (result) content = result;
    else console.error('patch: opencues v2 bootstrap failed — see above. cli.js stays unpatched.');
  }

\`;
const m = content.match(/\\/\\/ =+\\s*\\n\\s*\\/\\/ Write the modified content back/);
if (!m) { console.error('Error: could not find Write-modified-content-back section in index.ts'); process.exit(1); }
content = content.slice(0, m.index) + patchCode + '\\n' + content.slice(m.index);
fs.writeFileSync('$INDEX_FILE', content);
console.log('Patched index.ts');
"

# 4d. Disable every stock tweakcc patch.
#
# OpenCues uses tweakcc as our patcher TOOL — not as a feature suite. Users
# running 'opencues install claude-code' want OpenCues, not "OpenCues +
# tweakcc's verbose-property + opusplan1m + thinker-symbol-* + worktree-mode
# + 8 other unrelated CC tweaks they didn't ask for". This injection sits
# right after tweakcc's patchImplementations map is built and forces every
# entry's condition to false. Our own opencues v2 wiring lives in the
# // --- Cues Patches --- block (outside patchImplementations) so it's
# unaffected.
#
# Anyone who specifically wants tweakcc's extras can run stock tweakcc
# separately against their cli.js — this just unbundles them from OpenCues.
node -e "
const fs = require('fs');
let content = fs.readFileSync('$INDEX_FILE', 'utf8');
// tweakcc uses CRLF line endings — match either, anchor on the unique
// 'Apply all patches' header that follows patchImplementations close.
const m = content.match(/(\\r?\\n  \\};\\r?\\n)(\\r?\\n  \\/\\/ ={5,}\\r?\\n  \\/\\/ Apply all patches)/);
if (!m) { console.error('Error: could not find patchImplementations close + Apply-all-patches header'); process.exit(1); }
const insertion = \`
  // === OpenCues: disable all stock tweakcc patches ============================
  // We ship only the opencues v2 wiring (in the Cues Patches block above).
  // Users who want tweakcc's other features should run stock tweakcc separately.
  for (const __ocPatchId of Object.keys(patchImplementations)) {
    patchImplementations[__ocPatchId as PatchId].condition = false;
  }
  // === END OpenCues override ==================================================
\`;
// Insert AFTER the closing '};' line of patchImplementations and before
// the Apply-all-patches comment.
const insertPos = m.index + m[1].length;
content = content.slice(0, insertPos) + insertion + content.slice(insertPos);
fs.writeFileSync('$INDEX_FILE', content);
console.log('Disabled stock tweakcc patches');
"
end_step

# ─── 5. Build @opencues/{core,runtime} + install into fork ────────────
begin_step "Building + installing @opencues/{core,runtime}"
(cd "$CUES_CORE" && npm run build --silent 2>/dev/null || npm run build)
mkdir -p "$OC_NM_DIR/core"
cp "$CUES_CORE"/dist/*.js "$CUES_CORE"/dist/*.d.ts "$OC_NM_DIR/core/" 2>/dev/null || true
[ -f "$CUES_CORE/node-http-adapter.js" ] && cp "$CUES_CORE/node-http-adapter.js" "$OC_NM_DIR/core/"
[ -d "$CUES_CORE/dist/sources" ] && cp -r "$CUES_CORE/dist/sources" "$OC_NM_DIR/core/"
node -e "
const pkg = JSON.parse(require('fs').readFileSync('$CUES_CORE/package.json', 'utf8'));
pkg.main = 'index.js';
pkg.types = 'index.d.ts';
require('fs').writeFileSync('$OC_NM_DIR/core/package.json', JSON.stringify(pkg, null, 2));
"

(cd "$OC_RUNTIME" && npm run build --silent 2>/dev/null || npm run build)
mkdir -p "$OC_NM_DIR/runtime/dist"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$OC_RUNTIME/dist/" "$OC_NM_DIR/runtime/dist/"
else
  rm -rf "$OC_NM_DIR/runtime/dist"
  cp -r "$OC_RUNTIME/dist" "$OC_NM_DIR/runtime/dist"
fi
cp "$OC_RUNTIME/package.json" "$OC_NM_DIR/runtime/package.json"
end_step

# ─── 6. Install CC-specific support files (statusline + settings.json) ─
# All shared/cross-host concerns (blank library scripts, opencues.md
# self-heal, .cs compile, TTS speak.sh) live in `opencues seed-configs`
# now — install.cjs invokes that BEFORE this script runs. setup.sh is
# strictly CC-specific.
begin_step "Installing CC support files (statusline)"
mkdir -p "$OC_INSTALL_ROOT/scripts"
cp "$SCRIPT_DIR/highlight-statusline.sh" "$OC_INSTALL_ROOT/statusline.sh"
chmod +x "$OC_INSTALL_ROOT/statusline.sh"

# 6a. Auto-fix CC settings.json so statusLine.command points at the
# newly-installed script. Two prior layouts shipped statuslines at
# different paths — both are gone now, so settings.json pointing at
# either would invoke a missing file. settings.json holds an absolute
# path, so the statusline works from any cwd you launch claude-cues from.
SETTINGS_JSON="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_JSON" ] && grep -qE "highlight-statusline\.sh|\.claude/opencues/statusline\.sh" "$SETTINGS_JSON" 2>/dev/null; then
  cp "$SETTINGS_JSON" "$SETTINGS_JSON.bak.cues-statusline"
  sed -i "s|$HOME/.claude/highlight-statusline.sh|$OC_INSTALL_ROOT/statusline.sh|g" "$SETTINGS_JSON"
  sed -i "s|$HOME/.claude/opencues/statusline.sh|$OC_INSTALL_ROOT/statusline.sh|g" "$SETTINGS_JSON"
  echo "Updated statusLine.command in $SETTINGS_JSON"
fi
end_step

# ─── 7. Build tweakcc + verify dist contains v2 wiring ────────────────
begin_step "Building tweakcc"
(cd "$TWEAKCC_DIR" && npm run build 2>&1 | tail -3)
# VERIFICATION: the build must contain our v2 wiring. Without this check,
# a silent build failure (e.g. orchestrator-wiring drop) produces a
# vanilla-tweakcc dist that gets applied to cli.js with NO opencues code,
# leaving cues + highlights silently missing.
if ! grep -lq "writeOpenCuesRuntimeV2\|@opencues/runtime" "$TWEAKCC_DIR/dist/"*.mjs 2>/dev/null; then
  end_step
  echo "" >&4
  echo "FATAL: tweakcc dist contains no opencues v2 code." >&4
  echo "  Searched: $TWEAKCC_DIR/dist/*.mjs" >&4
  echo "  Expected: writeOpenCuesRuntimeV2, @opencues/runtime" >&4
  echo "  Likely cause: section 4b (orchestrator wiring) didn't run cleanly." >&4
  exit 1
fi
end_step

# ─── 8. Apply tweakcc to cli.js + verify v2 boot is present ───────────
begin_step "Applying patches to cli.js"
(cd "$TWEAKCC_DIR" && TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply 2>&1 | tail -10)
node --check "$CLI_JS" 2>/dev/null || echo "Warning: syntax check failed on $CLI_JS" >&4
# VERIFICATION: tweakcc's --apply prints "Customizations applied with some
# failures" even when individual patches miss seams. Confirm the v2 boot
# actually landed — without this, an unsupported CC version would silently
# leave cli.js unpatched but the installer would report success.
if ! grep -q "@opencues/runtime" "$CLI_JS"; then
  end_step
  echo "" >&4
  echo "FATAL: cli.js was patched but contains no opencues v2 boot." >&4
  echo "  cli.js: $CLI_JS" >&4
  echo "  Likely cause: writeOpenCuesRuntimeV2's S1/S3 seam regexes didn't" >&4
  echo "  match the cli.js content (unsupported CC version)." >&4
  echo "  Check packages/opencues-runtime/adapters/cc/ for a matching adapter band." >&4
  exit 1
fi
end_step

echo "" >&3
echo "Done. Restart Claude Code to activate." >&3
