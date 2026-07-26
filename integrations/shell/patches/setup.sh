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

# The staged copies above are dist-only, so @opencues/runtime's own deps
# (acorn / acorn-walk — lazy-required by the JS user-blank loader) are
# unresolvable from the staged bundle and EVERY JS user blank fails to
# register with only a warn. ONE implementation, shared with mac +
# apple-notes: packages/opencues-cli/src/lib/stage-runtime-deps.cjs.
node -e "require('$OPENCUES_ROOT/packages/opencues-cli/src/lib/stage-runtime-deps.cjs').stageRuntimeDeps({REPO_ROOT:process.argv[1],destNodeModules:process.argv[2],log:m=>console.log(m)})" \
  "$OPENCUES_ROOT" "$TERM_DIR/node_modules"

# ─── User-blank subprocess runner (Bun-host fallback) ───────────────
# Shell is Bun-based. `isolated-vm` (the in-process user-blank sandbox)
# is a V8 native binding that doesn't load against JavaScriptCore, so
# the runtime spawns a Node helper at first user-pack JS invocation.
# The vendor dir is shared across hosts (one copy serves OC + shell).
echo "  ▸ installing user-blank subprocess runner into ~/.opencues/vendor/"
VENDOR_DIR="$HOME/.opencues/vendor"
# ONE implementation, shared with mac + opencode:
# packages/opencues-cli/src/lib/stage-runtime-deps.cjs. The previous copy
# sourced isolated-vm from "$OPENCUES_ROOT/node_modules/isolated-vm", which a
# pnpm workspace never has — so the vendor dir stayed empty and the subprocess
# user-blank path was dead. The helper resolves the real location.
node -e "require('$OPENCUES_ROOT/packages/opencues-cli/src/lib/stage-runtime-deps.cjs').vendorUserBlankRunner({REPO_ROOT:process.argv[1],log:m=>console.log(m)})" \
  "$OPENCUES_ROOT"

# ─── Pre-bundle src/app.tsx → dist/app.js ───────────────────────────
# oc-edit prefers dist/app.js when present (falls back to src/app.tsx
# transpile-on-load otherwise). The bundle is a pure perf win: cuts
# per-launch transpile cost from ~2-3s to ~0.5s. Single cold launch
# measured: 3.3s without dist/, 1.2s with. Tooling that spawns
# multiple oc-edit processes concurrently amplifies the saving
# because Bun's on-the-fly transpile contends across instances.
#
# The earlier bytecode-segfault concern is in scripts/bundle.ts as
# `bytecode: false` — bundle output is plain ESM and safe.
echo "  ▸ bundling src/app.tsx → dist/app.js"
(
  cd "$TERM_DIR"
  bun run bundle 2>&1 | tee -a "$LOG" | grep -E "bundle:|error" || true
) || echo "    (bundle step failed — oc-edit will fall back to src/app.tsx transpile-on-load)"

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

echo "[32m●[0m Shell build done."
# Launch / how-to summary is printed by integrations/shell/bin/install.cjs
# AFTER the tmux vendoring step so the user reads "ready to launch"
# as the last line, not before a 30-second source-build kicks off.
# Devs invoking setup.sh directly get just the build confirmation —
# next-steps live in CLAUDE.md / README.md.
