#!/usr/bin/env bash
# VS Code integration setup.
#
# Self-owned host (no upstream fork): builds @opencues/{core,runtime},
# stages them into this package's node_modules (shell's staging model —
# avoids workspace-resolution drift), bundles the extension via esbuild,
# and (optionally) symlinks the built extension folder into a VS Code
# extensions dir so a window reload picks up rebuilds without a
# reinstall.
#
# Usage: ./setup.sh [--link-extensions DIR]
#   --link-extensions DIR  symlink this folder into DIR (e.g.
#                          ~/.vscode/extensions or, on WSL remotes,
#                          ~/.vscode-server/extensions). Default: skip;
#                          install.cjs auto-detects common dirs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VSCODE_DIR="$OPENCUES_ROOT/integrations/vscode"

LINK_EXT_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --link-extensions) LINK_EXT_DIR="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-vscode.log}"
: > "$LOG"

# ─── Build runtime + core ────────────────────────────────────────────
echo "  ▸ building @opencues/core + @opencues/runtime"
(
  cd "$OPENCUES_ROOT"
  pnpm --filter @opencues/core --filter @opencues/runtime build
) >>"$LOG" 2>&1

# ─── Stage @opencues/{core,runtime} into local node_modules ──────────
# Full-recursive cp -r of dist — NEVER a hard-coded subdir list (the
# PR #117 providers/ silent-boot regression class).
echo "  ▸ staging @opencues/core + @opencues/runtime into local node_modules"
RT_DEST="$VSCODE_DIR/node_modules/@opencues/runtime"
CORE_DEST="$VSCODE_DIR/node_modules/@opencues/core"
rm -rf "$RT_DEST" "$CORE_DEST"
mkdir -p "$RT_DEST" "$CORE_DEST"
cp -r "$OPENCUES_ROOT/packages/opencues-runtime/dist" "$RT_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-runtime/package.json" "$RT_DEST/"
cp -r "$OPENCUES_ROOT/packages/opencues-core/dist" "$CORE_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-core/package.json" "$CORE_DEST/"
if [ -f "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" ]; then
  # Lives at the package root, not dist/ — see adapters/oc/REPAIR.md § LF-7.
  cp "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" "$CORE_DEST/"
fi

# ─── Bundle the extension ────────────────────────────────────────────
echo "  ▸ bundling src/extension.ts → dist/extension.js"
(
  cd "$VSCODE_DIR"
  node esbuild.config.mjs
) >>"$LOG" 2>&1

# ─── Optional extensions-dir symlink ─────────────────────────────────
if [ -n "$LINK_EXT_DIR" ]; then
  mkdir -p "$LINK_EXT_DIR"
  LINK_NAME="$LINK_EXT_DIR/opencues.opencues-vscode"
  rm -f "$LINK_NAME"
  ln -s "$VSCODE_DIR" "$LINK_NAME"
  echo "  ▸ symlinked extension → $LINK_NAME (reload VS Code windows to activate)"
fi

echo "✓ VS Code extension build done."
