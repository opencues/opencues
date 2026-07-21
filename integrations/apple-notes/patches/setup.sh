#!/usr/bin/env bash
# Apple Notes integration setup.
#
# Builds @opencues/{core,runtime}, compiles the daemon (tsc), stages the
# built packages into this integration's local node_modules (same
# staging pattern as integrations/shell — full-recursive cp -r dist, no
# hard-coded subdir lists, see PR #117 bug class), and runs the
# Automation-permission probe so the macOS TCC prompt fires at INSTALL
# time, not silently at first daemon poll.
#
# Usage: ./setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
AN_DIR="$OPENCUES_ROOT/integrations/apple-notes"

LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-apple-notes.log}"
: > "$LOG"

# ─── Platform gate ───────────────────────────────────────────────────
if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ apple-notes integration is macOS-only (Notes.app + osascript)."
  exit 1
fi
if ! command -v osascript >/dev/null 2>&1; then
  echo "✗ osascript not found — cannot talk to Notes.app."
  exit 1
fi

# ─── Build runtime + core ────────────────────────────────────────────
echo "  ▸ building @opencues/core + @opencues/runtime"
(
  cd "$OPENCUES_ROOT"
  pnpm --filter @opencues/core --filter @opencues/runtime build
) >>"$LOG" 2>&1

# ─── Stage @opencues/{core,runtime} into local node_modules ─────────
# Real copies (not workspace symlinks) so the version marker's drift
# detection has a stable install target, mirroring integrations/shell.
echo "  ▸ staging @opencues/core + @opencues/runtime into local node_modules"
RT_DEST="$AN_DIR/node_modules/@opencues/runtime"
CORE_DEST="$AN_DIR/node_modules/@opencues/core"
rm -rf "$RT_DEST" "$CORE_DEST"
mkdir -p "$RT_DEST" "$CORE_DEST"
cp -r "$OPENCUES_ROOT/packages/opencues-runtime/dist" "$RT_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-runtime/package.json" "$RT_DEST/"
cp -r "$OPENCUES_ROOT/packages/opencues-core/dist" "$CORE_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-core/package.json" "$CORE_DEST/"
if [ -f "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" ]; then
  # Lives at the package root, not dist/ — see oc/REPAIR.md § LF-7.
  cp "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" "$CORE_DEST/"
fi

# ─── Build the daemon ────────────────────────────────────────────────
# Runs AFTER staging: the daemon's tsc resolves @opencues/{core,runtime}
# types from the local node_modules copies, so building first would
# typecheck against the PREVIOUS install's runtime and fail whenever the
# daemon uses a type added in the same release (e.g. notesMdIO).
echo "  ▸ building @opencues/apple-notes daemon (tsc)"
(
  cd "$OPENCUES_ROOT"
  pnpm --filter @opencues/apple-notes build
) >>"$LOG" 2>&1

# ─── Automation permission probe ─────────────────────────────────────
# Fire the TCC prompt now. A cached deny fails INSTANTLY with -1743 and
# no dialog (NOTES-PLATFORM.md § TCC) — print the recovery path.
echo "  ▸ probing Notes automation permission (a macOS prompt may appear — click Allow)"
set +e
PROBE_ERR="$(osascript -l JavaScript "$AN_DIR/jxa/probe-permission.js" 2>&1 >/dev/null)"
PROBE_STATUS=$?
set -e
if [ "$PROBE_STATUS" -ne 0 ]; then
  if echo "$PROBE_ERR" | grep -q -- '-1743'; then
    echo ""
    echo "  ⚠ Notes automation permission is DENIED (TCC -1743)."
    echo "    If no prompt appeared, a deny is cached. To fix:"
    echo "      1. System Settings → Privacy & Security → Automation → your terminal → enable Notes"
    echo "      2. or: tccutil reset AppleEvents <your-terminal-bundle-id>  (re-arms the prompt)"
    echo "    Then re-run: opencues doctor"
  else
    echo "  ⚠ Notes probe failed: $PROBE_ERR"
  fi
  # Non-fatal — the build is complete; permission can be granted later.
fi

echo "✓ Apple Notes build done."
