#!/usr/bin/env bash
# Windows integration setup (WSL side).
#
# Builds @opencues/{core,runtime} and stages the built dist into this
# integration's node_modules so `oc-windows` (hostd.cjs) resolves
# @opencues/runtime without workspace-resolution drift — same pattern as
# integrations/shell/patches/setup.sh.
#
# The Windows-native shim (native/OpenCuesWindows.cs) needs NO build
# step here: it's compiled on-demand on Windows by OpenCuesWindows.ps1
# via Add-Type (no .NET SDK required). This installer only prepares the
# WSL brain.
#
# Usage: ./setup.sh [--link DIR]
#   --link DIR  symlink `oc-windows` into DIR (default: skip)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INT_DIR="$OPENCUES_ROOT/integrations/windows"

LINK_DIR=""
while (( "$#" )); do
  case "$1" in
    --link) LINK_DIR="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-windows.log}"
: > "$LOG"

# ─── Build runtime + core ────────────────────────────────────────────
echo "  ▸ building @opencues/core + @opencues/runtime"
(
  cd "$OPENCUES_ROOT"
  pnpm --filter @opencues/core --filter @opencues/runtime build
) >>"$LOG" 2>&1

# ─── Stage @opencues/{core,runtime} into local node_modules ──────────
# Full-recursive cp -r (covers any new dist subdir automatically —
# never hard-code a subdir list; see the shell/OC setup.sh note re the
# June 2026 PR #117 providers/ regression).
echo "  ▸ staging @opencues/core + @opencues/runtime into local node_modules"
RT_DEST="$INT_DIR/node_modules/@opencues/runtime"
CORE_DEST="$INT_DIR/node_modules/@opencues/core"
rm -rf "$RT_DEST" "$CORE_DEST"
mkdir -p "$RT_DEST" "$CORE_DEST"
cp -r "$OPENCUES_ROOT/packages/opencues-runtime/dist" "$RT_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-runtime/package.json" "$RT_DEST/"
cp -r "$OPENCUES_ROOT/packages/opencues-core/dist" "$CORE_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-core/package.json" "$CORE_DEST/"
if [[ -f "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" ]]; then
  # Lives at the package root, not dist/ — resolver's
  # require('@opencues/core/node-http-adapter') resolves here.
  cp "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" "$CORE_DEST/"
fi

# ─── Stage the shared popup UI (keys/settings surface) ───────────────
# The daemon serves the SAME popup the chrome extension uses (refactored
# behind a host port). Build it from the chrome integration + copy the
# three assets into ui/. Non-fatal: without them the daemon still runs,
# only the Settings window is unavailable.
echo "  ▸ staging shared settings UI (popup)"
CHROME_DIR="$OPENCUES_ROOT/integrations/chrome"
UI_DEST="$INT_DIR/ui"
POPUP_SRC="$CHROME_DIR/dist/popup"
if [[ ! -f "$POPUP_SRC/popup.html" ]] && command -v npm >/dev/null 2>&1; then
  ( cd "$CHROME_DIR" && npm run build ) >>"$LOG" 2>&1 || true
fi
if [[ -f "$POPUP_SRC/popup.html" ]]; then
  rm -rf "$UI_DEST"; mkdir -p "$UI_DEST"
  cp "$POPUP_SRC/popup.html" "$POPUP_SRC/popup.css" "$POPUP_SRC/popup.js" "$UI_DEST/"
  echo "    ✓ popup staged → $UI_DEST"
else
  echo "    (skipped — build the chrome popup first: cd integrations/chrome && npm run build)"
fi

# ─── Optional symlink ────────────────────────────────────────────────
if [[ -n "$LINK_DIR" ]]; then
  mkdir -p "$LINK_DIR"
  ln -sf "$INT_DIR/bin/oc-windows" "$LINK_DIR/oc-windows"
  echo "  ▸ symlinked oc-windows → $LINK_DIR/oc-windows"
fi

echo "[32m●[0m Windows (WSL) build done."
echo "  Next: run 'oc-windows' in WSL, then the printed PowerShell command on Windows."
