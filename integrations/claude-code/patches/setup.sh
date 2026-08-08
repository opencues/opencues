#!/bin/bash
#
# setup.sh — install OpenCues into Claude Code (claude-cues fork).
#
# Scope: handles BOTH install shapes structurally — the npm **cli.js**
# shape (Claude Code 2.1.111 and earlier) and the **native bun-binary**
# shape (2.1.113+, including today's pinned 2.1.206). Same script,
# same patch source; `setup.sh` auto-detects which artifact is present
# under the fork's `node_modules/@anthropic-ai/claude-code/` and hands
# the right path to tweakcc — tweakcc patches cli.js directly, or for
# native binaries extracts cli.js from the `.bun` section (ELF on
# Linux, Mach-O on macOS, PE on Windows), patches the text, and
# repacks. The CC version pin lives in
# `integrations/claude-code/compat.json:current-pin` (today 2.1.206)
# and the tweakcc commit pin in `compat.json:tweakcc-pin`; see
# `integrations/claude-code/UPGRADING.md` for the version-bump runbook.
#
# NOTE (issue #276): only Linux x64 (incl. WSL) is maintainer-validated
# today. The install now verifies the patched artifact on the machine
# it runs on (fatal node --check + --version runtime smoke), so a
# platform-specific patch/repack failure aborts loudly instead of
# shipping a broken fork.
#
# Always-from-scratch by default: every install nukes prior state and
# rebuilds deterministically. The ONLY way to drift is to opt in via
# --keep-state (dev iteration only).
#
# Usage:
#   ./setup.sh [tweakcc-dir] [--keep-state]
#
# State that gets nuked + rebuilt every install (default):
#   ~/claude-code-cues/.cues/                            recreated (incl. tweakcc clone)
#   ~/claude-code-cues/node_modules/@opencues/{core,runtime}/  rebuilt + recopied
#   ~/claude-code-cues/node_modules/@anthropic-ai/       reinstalled (pin from compat.json:current-pin, today 2.1.206 native bun-binary)
#
# State that survives every install:
#   ~/.cues/  (incl. OPENCUES.md)                        user content (your CUE.md / BLANK.md edits etc.)
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

# pipefail is load-bearing here: every install step is piped through
# `tail -N` to keep the user-visible output short. Without pipefail,
# a failing `npm install ... | tail -3` returns tail's exit (0) and
# set -e doesn't fire — the script silently marches on with no
# node_modules/, then fails late at the dist-verification step with
# a misleading "tweakcc dist contains no opencues v2 code" message.
# Caught June 2026 after a transient npm error left tweakcc deps
# missing on a real user install. See `assert_dir_nonempty` below
# for the belt-and-braces post-install check.
set -eo pipefail

# BSD sed (macOS) requires an explicit extension arg after -i (even empty '');
# GNU sed (Linux/WSL) does not accept it as a separate argument.
if sed --version 2>/dev/null | grep -q GNU; then
  sedi() { sed -i "$@"; }
else
  sedi() { sed -i '' "$@"; }
fi

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
  if [ "$VERBOSE" = "1" ]; then printf '  [32m●[0m %s\n' "$CURRENT_STEP" >&3
  else printf ' [32m●[0m\n' >&3; fi
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
  echo "Error: Node.js is not installed. Please install Node.js 22 or later." >&4
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js 22+ required (found $(node --version))." >&4
  exit 1
fi

# ─── locate the CC fork (the dir whose package.json pins claude-code) ─
# Default fork location: ~/claude-code-cues. Allow override via OPENCUES_CC_TARGET
# pointing at a cli.js inside any other fork.
if [ -n "${OPENCUES_CC_TARGET:-}" ]; then
  # OPENCUES_CC_TARGET points at either:
  #   <fork>/node_modules/@anthropic-ai/claude-code/cli.js          (3 dirs deep)
  #   <fork>/node_modules/@anthropic-ai/claude-code/bin/claude.exe  (4 dirs deep)
  # Pre-2.1.113 we only ever ran against cli.js. The native-binary
  # fork (2.1.113+) needs the extra hop. Detect by basename + adjust.
  #
  # Path resolution uses Node's `path.resolve` so a FRESH fork (e.g.
  # ~/claude-code-cues-170 with just a package.json and no node_modules
  # yet) doesn't trip the `cd && pwd` form on missing intermediate dirs.
  # We can't use `realpath -m` here — that's a GNU coreutils flag and
  # BSD realpath on macOS lacks it (see CLAUDE.md § "Cross-platform
  # shell scripts"). Node is a hard install pre-req anyway, so shelling
  # out gives a portable normalizer with no extra dependency.
  _TARGET_BASENAME="$(basename "$OPENCUES_CC_TARGET")"
  case "$_TARGET_BASENAME" in
    cli.js)
      CC_FORK_DIR="$(node -e 'var p=require("path");process.stdout.write(p.resolve(p.dirname(process.argv[1]), "..", "..", ".."))' "$OPENCUES_CC_TARGET")"
      ;;
    claude.exe|claude)
      CC_FORK_DIR="$(node -e 'var p=require("path");process.stdout.write(p.resolve(p.dirname(process.argv[1]), "..", "..", "..", ".."))' "$OPENCUES_CC_TARGET")"
      ;;
    *)
      echo "Error: OPENCUES_CC_TARGET basename '$_TARGET_BASENAME' not recognised." >&4
      echo "Expected: cli.js (cli.js fork shape) or claude.exe (native-binary fork shape)." >&4
      exit 1
      ;;
  esac
  unset _TARGET_BASENAME
else
  CC_FORK_DIR="$HOME/.opencues/forks/claude-code"
fi
# Resolve the canonical CC pin from compat.json (single source of truth).
# Falls back gracefully if compat.json is unreadable so a one-off setup.sh
# invocation against a side fork doesn't hard-fail.
COMPAT_JSON="$(dirname "$0")/../compat.json"
CC_PIN=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$COMPAT_JSON','utf8'))['current-pin']||'')}catch{}" 2>/dev/null || true)
[ -z "$CC_PIN" ] && CC_PIN="2.1.206"
# tweakcc is pinned to an exact commit (compat.json:tweakcc-pin) — an
# unpinned clone means every install gets whatever tweakcc main is that
# day. Issue #276 (July 2026): an unpinned clone pulled a main whose
# system-prompt pipeline corrupted both install shapes (reproduced on
# Linux x64, reported on macOS arm64). No fallback default on purpose:
# if compat.json is unreadable we fail loudly rather than drift.
TWEAKCC_PIN=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$COMPAT_JSON','utf8'))['tweakcc-pin']||'')}catch{}" 2>/dev/null || true)
if [ -z "$TWEAKCC_PIN" ]; then
  echo "Error: compat.json:tweakcc-pin missing or unreadable ($COMPAT_JSON)." >&4
  echo "  setup.sh refuses to clone tweakcc unpinned — see issue #276." >&4
  exit 1
fi

if [ ! -f "$CC_FORK_DIR/package.json" ]; then
  echo "Error: $CC_FORK_DIR/package.json missing." >&4
  echo "Create the fork dir first with a package.json that pins claude-code:" >&4
  echo "  mkdir -p $CC_FORK_DIR" >&4
  echo "  echo '{\"dependencies\":{\"@anthropic-ai/claude-code\":\"$CC_PIN\"}}' > $CC_FORK_DIR/package.json" >&4
  exit 1
fi
# Sanity-check the pin is exact (no caret / tilde — those allow drift).
PINNED_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$CC_FORK_DIR/package.json','utf8')).dependencies['@anthropic-ai/claude-code'] || '')")
if [[ "$PINNED_VERSION" =~ ^(\^|~) ]]; then
  echo "Warning: $CC_FORK_DIR/package.json pins @anthropic-ai/claude-code with a range ($PINNED_VERSION)." >&4
  echo "  Caret/tilde ranges allow npm install to drift to incompatible versions." >&4
  echo "  Edit package.json to pin an EXACT version (e.g. \"$CC_PIN\")." >&4
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

# ─── 2. Reinstall pinned cli.js / native binary into the fork ────────
# `npm install` reads the fork's package.json, which pins an EXACT CC
# version (no caret) — so this always installs the same artifact bit-
# for-bit. Skipped under --keep-state when the patched artifact already
# exists.
#
# CC ships two distribution shapes within the 2.1.x line:
#   - 2.1.111 and earlier → package/cli.js   (minified JS bundle)
#   - 2.1.113 and later   → bin/claude.exe   (bun-compile native binary
#                                             — ELF/Mach-O/PE by platform
#                                             — with the JS embedded in
#                                             a .bun section that the
#                                             pinned tweakcc extracts +
#                                             repacks)
# CLI_JS is the path we hand to tweakcc; for native installs, point at
# the binary and tweakcc handles the extract/patch/repack transparently.
begin_step "Installing pinned @anthropic-ai/claude-code"
CC_PKG_DIR="$CC_FORK_DIR/node_modules/@anthropic-ai/claude-code"
CLI_JS_PATH="$CC_PKG_DIR/cli.js"
BIN_PATH="$CC_PKG_DIR/bin/claude.exe"
if $KEEP_STATE && { [ -f "$CLI_JS_PATH" ] || [ -f "$BIN_PATH" ]; }; then
  echo "  --keep-state: patched artifact already present at $CC_FORK_DIR — skipping npm install"
else
  (cd "$CC_FORK_DIR" && rm -f package-lock.json && npm install --no-audit --no-fund 2>&1 | tail -5)
fi
# Pick the right artifact for tweakcc. cli.js (legacy) wins when present;
# otherwise fall back to the native binary.
if [ -f "$CLI_JS_PATH" ]; then
  CLI_JS="$CLI_JS_PATH"
  CC_SHAPE="cli.js"
elif [ -f "$BIN_PATH" ]; then
  CLI_JS="$BIN_PATH"
  CC_SHAPE="native-binary"
  echo "  Native bun-binary install detected; tweakcc 4.0.13+ will extract/repack."
else
  echo "Error: neither cli.js ($CLI_JS_PATH) nor native binary ($BIN_PATH) found after npm install." >&4
  echo "  Pinned version: $PINNED_VERSION" >&4
  echo "  Both distribution shapes are unsupported — check the version pin in package.json." >&4
  exit 1
fi
end_step

# ─── 3. Clone tweakcc (pinned) + install its deps ─────────────────────
begin_step "Cloning tweakcc (pin $TWEAKCC_PIN)"
if $KEEP_STATE && [ -d "$TWEAKCC_DIR/.git" ]; then
  echo "  --keep-state: $TWEAKCC_DIR exists, resetting source files we patch"
  (cd "$TWEAKCC_DIR" && git checkout HEAD -- src/types.ts src/defaultSettings.ts src/patches/index.ts 2>/dev/null || true)
  # Even under --keep-state the clone must sit at the pin — a dev clone
  # left on an arbitrary commit is exactly the drift the pin exists to
  # prevent. Fetch only if the pin isn't present locally.
  KEPT_HEAD=$(cd "$TWEAKCC_DIR" && git rev-parse HEAD)
  if [ "$KEPT_HEAD" != "$TWEAKCC_PIN" ]; then
    echo "  --keep-state clone is at $KEPT_HEAD, not the pin — checking out $TWEAKCC_PIN"
    (cd "$TWEAKCC_DIR" \
      && { git cat-file -e "$TWEAKCC_PIN^{commit}" 2>/dev/null || git fetch origin; } \
      && git checkout --detach "$TWEAKCC_PIN")
  fi
else
  git clone https://github.com/Piebald-AI/tweakcc "$TWEAKCC_DIR"
  (cd "$TWEAKCC_DIR" && git checkout --detach "$TWEAKCC_PIN")
  # VERIFICATION: the checkout must actually land on the pin. A typo'd
  # pin or a force-pushed upstream would otherwise silently leave us on
  # main — the exact failure mode this pin exists to prevent.
  ACTUAL_HEAD=$(cd "$TWEAKCC_DIR" && git rev-parse HEAD)
  if [ "$ACTUAL_HEAD" != "$TWEAKCC_PIN" ]; then
    echo "FATAL: tweakcc checkout landed on $ACTUAL_HEAD, expected pin $TWEAKCC_PIN." >&4
    echo "  compat.json:tweakcc-pin may be invalid, or upstream history was rewritten." >&4
    exit 1
  fi
  (cd "$TWEAKCC_DIR" && npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -3)
  # Belt-and-braces — pipefail (top of file) already aborts on a
  # failing `npm install`, but a flake of "exited 0 + node_modules
  # incomplete" would still slip through. This check looks for the
  # specific binary the next build step needs (tsc); missing means
  # the build will fail with a misleading "tsc: not found" error
  # downstream. Better to fail here with the real cause.
  if [ ! -x "$TWEAKCC_DIR/node_modules/.bin/tsc" ]; then
    echo "FATAL: tweakcc deps incomplete — $TWEAKCC_DIR/node_modules/.bin/tsc missing after npm install." >&4
    echo "  Likely cause: npm install hit a transient error (network, registry, peer dep)." >&4
    echo "  Recover: rm -rf $TWEAKCC_DIR && re-run this script." >&4
    exit 1
  fi
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
sedi 's/showTweakccVersion: true/showTweakccVersion: false/g' "$TWEAKCC_DIR/src/defaultSettings.ts"
sedi 's/showPatchesApplied: true/showPatchesApplied: false/g' "$TWEAKCC_DIR/src/defaultSettings.ts"
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

# 4e. Disable tweakcc's SYSTEM-PROMPT pipeline. This is separate from
# patchImplementations (section 4d) — applySystemPrompts() runs
# unconditionally in the orchestrator BEFORE the patch map, and
# rewrites CC's prompt template literals whenever the CC version's
# prompts don't hash-match tweakcc's bundled prompt DB. Issue #276
# (July 2026): against a CC version older than the DB, that rewrite
# double-escaped backslashes (\\\` → \\\\\`) across ~5000 prompt
# segments — cli.js shape died with a SyntaxError at CC's own nested
# template literals; native shape repacked the corrupted JS and Bun
# refused to load it ("Expected CommonJS module to have a function
# wrapper"). We ship zero prompt customizations, so the pipeline has
# nothing to do for us — drop only the content assignment (the
# diff-report side stays; it never mutates cli.js).
node -e "
const fs = require('fs');
let content = fs.readFileSync('$INDEX_FILE', 'utf8');
const anchor = 'content = systemPromptsResult.newContent;';
if (!content.includes(anchor)) {
  console.error('Error: could not find the applySystemPrompts content assignment in index.ts.');
  console.error('tweakcc pin may have moved — re-verify section 4e against the pinned commit.');
  process.exit(1);
}
content = content.replace(anchor,
  '/* OpenCues: system-prompt writes disabled — we ship no prompt customizations and the rewrite corrupts version-mismatched cli.js (issue #276). */');
fs.writeFileSync('$INDEX_FILE', content);
console.log('Disabled tweakcc system-prompt pipeline');
"
end_step

# ─── 5. Build @opencues/{core,runtime} + install into fork ────────────
begin_step "Building + installing @opencues/{core,runtime}"
(cd "$CUES_CORE" && npm run build --silent 2>/dev/null || npm run build)
mkdir -p "$OC_NM_DIR/core"
# Recursive copy of every subdir under dist/ so newly-added subdirs
# (sources/, providers/, future ones) aren't silently dropped. The
# previous hard-coded list ("sources" only) was the root cause of the
# June 2026 silent-boot bug: PR #117 added providers/claude-cli-daemon
# but setup.sh kept copying only sources/, so the installed core's
# model-aliases.js require'd a non-existent ./providers/claude-cli-daemon,
# CC's patch outer try/catch swallowed the load error, every CC
# session silently came up with __oc.failed=true and no cues / no
# blanks. Recursive copy makes adding a new subdir to the bundle
# structurally safe.
cp "$CUES_CORE"/dist/*.js "$CUES_CORE"/dist/*.d.ts "$OC_NM_DIR/core/" 2>/dev/null || true
[ -f "$CUES_CORE/node-http-adapter.js" ] && cp "$CUES_CORE/node-http-adapter.js" "$OC_NM_DIR/core/"
# NOTE: strip the trailing slash the `*/` glob leaves on $sub. With the
# trailing slash, BSD cp (macOS) copies the directory *contents* into
# core/ — flattening dist/sources/*.js to core/*.js so `require("./sources/
# config-source")` 404s — whereas GNU cp (Linux) copies the dir itself.
# `${sub%/}` makes `cp -r` copy the directory on both. (BSD/GNU compat,
# same class as the sedi/stat_size wrappers — see root CLAUDE.md.)
for sub in "$CUES_CORE"/dist/*/; do
  [ -d "$sub" ] || continue
  cp -r "${sub%/}" "$OC_NM_DIR/core/"
done
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
# All shared/cross-host concerns (blank library scripts, OPENCUES.md
# self-heal, .cs compile, TTS speak.sh) live in `opencues seed-configs`
# now — install.cjs invokes that BEFORE this script runs. setup.sh is
# strictly CC-specific.
begin_step "Installing CC support files (statusline)"
mkdir -p "$OC_INSTALL_ROOT/scripts"
cp "$SCRIPT_DIR/highlight-statusline.sh" "$OC_INSTALL_ROOT/statusline.sh"
chmod +x "$OC_INSTALL_ROOT/statusline.sh"
# Bake the resolved CLI invocation into the statusline so its
# session-contradiction watchlist kick (Stage A of session-contradiction-mode)
# can find the CLI without relying on `opencues` being on PATH — the fork's
# statusline runs in the user's own shell env. Falls back to $OPENCUES_CLI /
# `command -v opencues` if this bake never ran (e.g. a hand-copied statusline).
sedi "s|^OPENCUES_CLI_BAKED=.*|OPENCUES_CLI_BAKED=\"node $REPO_ROOT/packages/opencues-cli/bin/cli.cjs\"|" "$OC_INSTALL_ROOT/statusline.sh"

# 6a. Migrate legacy statusLine paths only — never auto-write fresh.
#
# Design choice: setup.sh stages statusline.sh into our fork dir but
# does NOT proactively edit ~/.claude/settings.json. ~/.claude/ is
# Claude Code's directory; we're guests, and writing to it without
# explicit user consent feels wrong. The user enables the tip surface
# explicitly via:
#
#   opencues statusline enable             # writes ~/.claude/settings.json
#   opencues statusline enable --project   # writes <cwd>/.claude/settings.json
#
# What we DO touch automatically: stale legacy opencues paths. If
# the user previously enabled it via an old install layout, the
# path will be wrong now (the install root has moved). Rewriting a
# stale legacy path is a corrective in-place edit, not a fresh
# write, and refusing to do it would leave the user's statusline
# broken. Same sed-based logic the legacy install used.
SETTINGS_JSON="$HOME/.claude/settings.json"
# Also migrate a statusLine pointing at a LEGACY-fork statusline path
# ($HOME/claude-code-cues*/.cues/statusline.sh) — after the fork relocation to
# ~/.opencues/forks/, that path is deleted, so a migrating user's statusline
# would break. Rewriting it is the same corrective in-place edit (a stale
# opencues path that moved), not a fresh write.
if [ -f "$SETTINGS_JSON" ] && grep -qE "highlight-statusline\.sh|\.claude/opencues/statusline\.sh|claude-code-cues[^\"]*statusline\.sh" "$SETTINGS_JSON" 2>/dev/null; then
  cp "$SETTINGS_JSON" "$SETTINGS_JSON.bak.cues-statusline"
  sedi "s|$HOME/.claude/highlight-statusline.sh|$OC_INSTALL_ROOT/statusline.sh|g" "$SETTINGS_JSON"
  sedi "s|$HOME/.claude/opencues/statusline.sh|$OC_INSTALL_ROOT/statusline.sh|g" "$SETTINGS_JSON"
  sedi "s|$HOME/claude-code-cues[^\"]*statusline.sh|$OC_INSTALL_ROOT/statusline.sh|g" "$SETTINGS_JSON"
  echo "Migrated stale statusLine.command in $SETTINGS_JSON → $OC_INSTALL_ROOT/statusline.sh"
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

# ─── 8. Apply tweakcc to cli.js / native binary + verify v2 boot ─────
begin_step "Applying patches to $CC_SHAPE"
(cd "$TWEAKCC_DIR" && TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply 2>&1 | tail -10)
# VERIFICATION (fatal): the patched cli.js must still parse. Issue #276
# shipped a cli.js with double-escaped template literals because this
# used to be a WARNING — the user's install said "Done." and cli.js
# died at launch with a SyntaxError. Never warn on corruption.
#
# cli.js shape only: the native binary's embedded JS runs under Bun and
# legitimately uses syntax Node can't parse (`using` declarations in CC
# 2.1.170 fail node 22's parser even on a PRISTINE extract) — the
# native shape is verified by actually executing the binary below.
if [ "$CC_SHAPE" = "cli.js" ]; then
  if ! node --check "$CLI_JS" 2>>"$LOG"; then
    end_step
    echo "" >&4
    echo "FATAL: patched cli.js is not valid JavaScript (node --check failed)." >&4
    echo "  The patch pipeline corrupted $CLI_JS" >&4
    echo "  Restore: cp $TWEAKCC_CONFIG_DIR/cli.js.backup $CLI_JS" >&4
    echo "  Then report this at https://github.com/opencues/opencues/issues with the log: $LOG" >&4
    exit 1
  fi
fi
# VERIFICATION: tweakcc's --apply prints "Customizations applied with some
# failures" even when individual patches miss seams. Confirm the v2 boot
# actually landed — without this, an unsupported CC version would silently
# leave cli.js unpatched but the installer would report success.
#
# For native-binary installs, the patched cli.js is repacked into the .bun
# section but tweakcc also writes the post-patch extract to
# $TWEAKCC_CONFIG_DIR/native-claudejs-patched.js — grep that, not the binary
# (the section is compressed so the binary itself isn't ASCII-greppable).
if [ "$CC_SHAPE" = "cli.js" ]; then
  VERIFY_TARGET="$CLI_JS"
else
  VERIFY_TARGET="$TWEAKCC_CONFIG_DIR/native-claudejs-patched.js"
fi
if ! grep -q "@opencues/runtime" "$VERIFY_TARGET" 2>/dev/null; then
  end_step
  echo "" >&4
  echo "FATAL: $CC_SHAPE was patched but contains no opencues v2 boot." >&4
  echo "  Target: $VERIFY_TARGET" >&4
  echo "  Likely cause: writeOpenCuesRuntimeV2's S1/S3 seam regexes didn't" >&4
  echo "  match the cli.js content (unsupported CC version)." >&4
  echo "  Check packages/opencues-runtime/adapters/cc/ for a matching adapter band." >&4
  exit 1
fi
end_step

# ─── 9. Runtime smoke: the patched artifact must actually RUN ─────────
# Markers prove our bootstrap TEXT landed; they say nothing about
# whether the artifact still loads. Issue #276 (July 2026): a native
# repack shipped a binary Bun refuses to load ("Expected CommonJS
# module to have a function wrapper") while every text-level check
# passed and the installer reported success. Executing `--version` on
# the exact machine that will run the fork is the only gate that
# catches loader-level corruption — including platform-specific repack
# bugs (the issue was reported on macOS arm64) that no CI on our side
# can exercise. Timeout via Node's spawnSync (GNU `timeout` doesn't
# exist on macOS — see CLAUDE.md § Cross-platform shell scripts).
#
# OPENCUES_SKIP_CC_RUNTIME_SMOKE=1 skips this step (sandboxes that
# can't exec the host binary).
if [ "${OPENCUES_SKIP_CC_RUNTIME_SMOKE:-0}" != "1" ]; then
  begin_step "Verifying patched $CC_SHAPE runs (--version)"
  if [ "$CC_SHAPE" = "cli.js" ]; then
    SMOKE_CMD="$(command -v node)"; SMOKE_ARG="$CLI_JS"
  else
    SMOKE_CMD="$CLI_JS"; SMOKE_ARG=""
  fi
  if ! node -e '
    const { spawnSync } = require("child_process");
    const [cmd, arg] = [process.argv[1], process.argv[2]];
    const args = arg ? [arg, "--version"] : ["--version"];
    const r = spawnSync(cmd, args, { timeout: 60000, encoding: "utf8" });
    if (r.status !== 0) {
      console.error((r.stderr || "") + (r.stdout || ""));
      console.error(`--version exited ${r.status === null ? "timeout/signal" : r.status}`);
      process.exit(1);
    }
    process.stdout.write((r.stdout || "").trim() + "\n");
  ' "$SMOKE_CMD" "$SMOKE_ARG"; then
    end_step
    echo "" >&4
    echo "FATAL: patched $CC_SHAPE failed to execute (--version)." >&4
    if [ "$CC_SHAPE" = "cli.js" ]; then
      echo "  Restore: cp $TWEAKCC_CONFIG_DIR/cli.js.backup $CLI_JS" >&4
    else
      echo "  The binary repack corrupted the executable." >&4
      echo "  Restore: cp $TWEAKCC_CONFIG_DIR/native-binary.backup $CLI_JS" >&4
    fi
    echo "  Then report this at https://github.com/opencues/opencues/issues with the log: $LOG" >&4
    exit 1
  fi
  end_step
fi

echo "" >&3
echo "Done. Restart Claude Code to activate." >&3
