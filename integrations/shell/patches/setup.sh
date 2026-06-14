#!/usr/bin/env bash
# Terminal integration setup.
#
# Builds @opencues/{core,runtime}, installs the standalone @opencues/shell
# package's deps via bun, and (optionally) symlinks the user-facing
# commands (`oc-shell`, `oc-install-tmux`, `oc-install-shell-integration`)
# into a PATH location. Internal helpers (oc-edit, oc-popup,
# oc-shell-init, oc-open-input, oc-editd) are never symlinked —
# `oc-shell` adds bin/ to PATH for its own children only.
#
# Usage: ./setup.sh [--link DIR]
#   --link DIR  symlink user-facing commands into DIR (default: skip)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TERM_DIR="$OPENCUES_ROOT/integrations/shell"

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
echo "  ▸ installing @opencues/shell deps via bun"
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

# ─── User-blank subprocess runner (Bun-host fallback) ───────────────
# Shell is Bun-based. `isolated-vm` (the in-process user-blank sandbox)
# is a V8 native binding that doesn't load against JavaScriptCore, so
# the runtime spawns a Node helper at first user-pack JS invocation.
# The vendor dir is shared across hosts (one copy serves OC + shell).
echo "  ▸ installing user-blank subprocess runner into ~/.opencues/vendor/"
VENDOR_DIR="$HOME/.opencues/vendor"
mkdir -p "$VENDOR_DIR/node_modules"
RUNNER_SRC="$OPENCUES_ROOT/packages/opencues-runtime/dist/src/user-blanks/subprocess-runner.cjs"
[[ ! -f "$RUNNER_SRC" ]] && RUNNER_SRC="$OPENCUES_ROOT/packages/opencues-runtime/src/user-blanks/subprocess-runner.cjs"
if [[ -f "$RUNNER_SRC" ]]; then
  cp "$RUNNER_SRC" "$VENDOR_DIR/user-blank-runner.cjs"
fi
IVM_SRC="$OPENCUES_ROOT/node_modules/isolated-vm"
IVM_DST="$VENDOR_DIR/node_modules/isolated-vm"
if [[ -d "$IVM_SRC" ]]; then
  if [[ ! -e "$IVM_DST" ]] || ! diff -rq "$IVM_SRC" "$IVM_DST" &>/dev/null; then
    rm -rf "$IVM_DST"
    cp -RL "$IVM_SRC" "$IVM_DST"
  fi
fi

# ─── Bundle skipped (oc-edit runs src/app.tsx directly) ────────────
# A `bun run bundle` (scripts/bundle.ts) is wired up and works, but
# we hit a leftover .jsc-segfault issue with the bytecode experiment
# that bit production usage. Until the daemon model (see
# DAEMON-PLAN.md) is built, oc-edit runs src/app.tsx directly via
# the bun shim — ~1s cold start per input-box open, but reliable.
# To opt in manually, run `bun run bundle` from integrations/shell/.

# ─── Optional symlink ────────────────────────────────────────────────
if [[ -n "$LINK_DIR" ]]; then
  mkdir -p "$LINK_DIR"
  # Only the user-facing commands are symlinked. Internal helpers
  # (oc-edit, oc-popup, oc-shell-init, oc-open-input, oc-editd) are
  # invoked by `oc-shell` via its own PATH adjustment.
  for bin in oc-shell oc-install-tmux oc-install-shell-integration; do
    ln -sf "$TERM_DIR/bin/$bin" "$LINK_DIR/$bin"
    echo "  ▸ symlinked $bin → $LINK_DIR/$bin"
  done
fi

echo "✓ Shell build done."
# Launch / how-to summary is printed by integrations/shell/bin/install.cjs
# AFTER the tmux vendoring step so the user reads "ready to launch"
# as the last line, not before a 30-second source-build kicks off.
# Devs invoking setup.sh directly get just the build confirmation —
# next-steps live in CLAUDE.md / README.md.
