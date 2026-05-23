#!/usr/bin/env bash
# Terminal integration setup.
#
# Builds @opencues/{core,runtime}, installs the standalone @opencues/terminal
# package's deps via bun, and (optionally) symlinks `oc-edit` into a
# PATH location. Unlike CC/OC there is no upstream fork to clone or
# patch — the app is self-owned.
#
# Usage: ./setup.sh [--link DIR]
#   --link DIR  symlink bin/oc-edit into DIR (default: skip)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TERM_DIR="$OPENCUES_ROOT/integrations/terminal"

LINK_DIR=""
while (( "$#" )); do
  case "$1" in
    --link) LINK_DIR="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-terminal.log}"
: > "$LOG"

# ─── Bun prereq ──────────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ bun not found on PATH. Install: https://bun.sh"
  exit 1
fi

# ─── Build runtime + core ────────────────────────────────────────────
echo "  ▸ building @opencues/core + @opencues/runtime"
(
  cd "$OPENCUES_ROOT"
  pnpm --filter @opencues/core --filter @opencues/runtime build
) >>"$LOG" 2>&1

# ─── Install terminal deps ───────────────────────────────────────────
echo "  ▸ installing @opencues/terminal deps via bun"
(
  cd "$TERM_DIR"
  bun install
) >>"$LOG" 2>&1

# ─── Stage @opencues/{core,runtime} into local node_modules ──────────
# Mirrors integrations/opencode/patches/setup.sh's install_into_fork:
# cp -r the built dist + package.json into a vendored path. Avoids
# workspace-resolution drift between top-level pnpm and Bun.
echo "  ▸ staging @opencues/core + @opencues/runtime into local node_modules"
RT_DEST="$TERM_DIR/node_modules/@opencues/runtime"
CORE_DEST="$TERM_DIR/node_modules/@opencues/core"
rm -rf "$RT_DEST" "$CORE_DEST"
mkdir -p "$RT_DEST" "$CORE_DEST"
cp -r "$OPENCUES_ROOT/packages/opencues-runtime/dist" "$RT_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-runtime/package.json" "$RT_DEST/"
cp -r "$OPENCUES_ROOT/packages/opencues-core/dist" "$CORE_DEST/"
cp "$OPENCUES_ROOT/packages/opencues-core/package.json" "$CORE_DEST/"
if [[ -f "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" ]]; then
  # Lives at the package root, not dist/ — resolver's
  # `require('@opencues/core/node-http-adapter')` resolves to
  # <pkg-root>/node-http-adapter.js. See packages/opencues-runtime
  # /adapters/oc/REPAIR.md § LF-7 for the OC analogue of this trap.
  cp "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" "$CORE_DEST/"
fi

# ─── Optional symlink ────────────────────────────────────────────────
if [[ -n "$LINK_DIR" ]]; then
  mkdir -p "$LINK_DIR"
  ln -sf "$TERM_DIR/bin/oc-edit" "$LINK_DIR/oc-edit"
  echo "  ▸ symlinked oc-edit → $LINK_DIR/oc-edit"
fi

echo "✓ Terminal integration ready."
echo
echo "Try it:"
echo "  $TERM_DIR/bin/oc-edit"
echo "  echo 'the attorney filed today' | $TERM_DIR/bin/oc-edit"
echo
echo "As your editor:"
echo "  export EDITOR=$TERM_DIR/bin/oc-edit"
echo "  git commit  # opens oc-edit"
