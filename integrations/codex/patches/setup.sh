#!/usr/bin/env bash
# OpenCues × OpenAI Codex (Rust TUI) — install pipeline.
#
# Usage: ./setup.sh [codex-fork-dir]
#   default codex-fork-dir: $HOME/codex-cues
#
# What this does:
#   1. Clone openai/codex at pinned SHA into <fork> (idempotent — reuses if present)
#   2. Build @opencues/runtime so daemon.js exists
#   3. Copy patches/opencues-bridge/ into <fork>/codex-rs/opencues-bridge/
#   4. Add opencues-bridge to <fork>/codex-rs/Cargo.toml workspace members
#   5. Build the bridge crate with cargo (does NOT yet build full codex TUI —
#      that happens once the TUI patches land; see HANDOFF.md)
#   6. Drop a launch helper at <fork>/launch.sh
#
# Set OPENCUES_INSTALL_VERBOSE=1 to stream every command's output.
# Default is quiet — only progress lines + errors. Full log lives at
# the path printed on failure (default /tmp/opencues-install-codex.log).
#
# Pinned upstream version: see PINNED_SHA below.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FORK_DIR="${1:-$HOME/codex-cues}"

# Pinned to a known-good codex-rs SHA. Bump as upstream changes.
PINNED_SHA="d58d3cc"
PINNED_HUMAN="2026-04 (master at the time of writing)"

LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-codex.log}"
VERBOSE="${OPENCUES_INSTALL_VERBOSE:-0}"
: > "$LOG"

# ─── progress helpers ────────────────────────────────────────────────
# run_step <label> <fn-name> [args...]
#   verbose=0 (default): prints "  ▸ <label> ✓" / "✗" + error excerpt
#   verbose=1:           streams everything live, still prints ✓/✗
run_step() {
  local label="$1"; shift
  if [[ "$VERBOSE" = "1" ]]; then
    printf '  ▸ %s\n' "$label"
    if "$@"; then
      printf '  ✓ %s\n' "$label"
    else
      local rc=$?
      printf '  ✗ %s (exit %d)\n' "$label" "$rc" >&2
      exit "$rc"
    fi
  else
    printf '  ▸ %s' "$label"
    if "$@" >>"$LOG" 2>&1; then
      printf ' ✓\n'
    else
      local rc=$?
      printf ' ✗\n' >&2
      echo "" >&2
      echo "Step failed: $label (exit $rc)" >&2
      echo "Last 30 lines of $LOG:" >&2
      tail -30 "$LOG" >&2
      echo "" >&2
      echo "Full log: $LOG  —  re-run with OPENCUES_INSTALL_VERBOSE=1 to stream live." >&2
      exit "$rc"
    fi
  fi
}

echo "=== OpenCues × OpenAI Codex setup ==="
echo "Target fork: $FORK_DIR"
echo "Pinned to codex SHA $PINNED_SHA ($PINNED_HUMAN)"
echo ""

# ─── step bodies ─────────────────────────────────────────────────────

clone_fork() {
  if [[ ! -d "$FORK_DIR" ]]; then
    git -c advice.detachedHead=false clone --quiet \
      https://github.com/openai/codex.git "$FORK_DIR"
    cd "$FORK_DIR"
    git checkout --quiet "$PINNED_SHA" 2>/dev/null \
      || echo "WARN: couldn't checkout $PINNED_SHA — using HEAD"
  elif [[ ! -d "$FORK_DIR/codex-rs" ]]; then
    echo "Error: $FORK_DIR exists but doesn't look like a codex checkout." >&2
    return 1
  else
    cd "$FORK_DIR"
  fi
}

build_runtime() {
  cd "$OPENCUES_ROOT"
  pnpm --filter @opencues/runtime build
}

DAEMON_JS="$OPENCUES_ROOT/packages/opencues-runtime/dist/adapters/codex/v1/daemon.js"

verify_daemon() {
  if [[ ! -f "$DAEMON_JS" ]]; then
    echo "ERROR: daemon.js not built at $DAEMON_JS" >&2
    echo "Check tsconfig — adapters/codex/v1/ must be in the include path." >&2
    return 1
  fi
}

copy_bridge() {
  local BRIDGE_SRC="$SCRIPT_DIR/opencues-bridge"
  local BRIDGE_DEST="$FORK_DIR/codex-rs/opencues-bridge"
  mkdir -p "$BRIDGE_DEST"
  rsync -a --delete "$BRIDGE_SRC/" "$BRIDGE_DEST/" 2>/dev/null \
    || cp -r "$BRIDGE_SRC/." "$BRIDGE_DEST/"
}

patch_workspace() {
  local CARGO_TOML="$FORK_DIR/codex-rs/Cargo.toml"
  if grep -q '"opencues-bridge"' "$CARGO_TOML"; then
    return 0
  fi
  python3 - "$CARGO_TOML" <<'PY'
import sys, re
p = sys.argv[1]
src = open(p).read()
new = re.sub(r'(members\s*=\s*\[)', r'\1\n    "opencues-bridge",', src, count=1)
if new == src:
  print("ERROR: couldn't find 'members = [' in Cargo.toml — please add manually", file=__import__('sys').stderr)
  sys.exit(1)
open(p, 'w').write(new)
PY
}

build_bridge() {
  cd "$FORK_DIR/codex-rs"
  cargo build -p opencues-bridge --release
}

smoke_test() {
  cd "$FORK_DIR/codex-rs"
  cargo run -q --release --bin opencues-bridge-smoke -- "$DAEMON_JS"
}

apply_tui_patches() {
  cd "$FORK_DIR/codex-rs"
  local patch="$SCRIPT_DIR/tui-bridge-wiring.diff"
  if [[ ! -f "$patch" ]]; then
    echo "tui-bridge-wiring.diff not found at $patch" >&2
    return 1
  fi
  # Idempotency: the patch inserts OPENCUES_BRIDGE_BEGIN markers in
  # chat_composer.rs. If they're already present, re-apply would
  # produce 'patch fragments already applied' errors — skip cleanly.
  if grep -q OPENCUES_BRIDGE_BEGIN tui/src/bottom_pane/chat_composer.rs 2>/dev/null; then
    echo "TUI patches already applied — skipping"
    return 0
  fi
  # Pre-flight check via git apply --check. Surfaces upstream drift
  # cleanly: if codex-rs has moved past the pinned SHA, the patch
  # may not land. See HANDOFF.md for the rebase workflow.
  if ! git apply --check "$patch" 2>&1; then
    echo "" >&2
    echo "TUI patch pre-flight failed — upstream codex-rs has drifted from pinned SHA $PINNED_SHA." >&2
    echo "Either bump PINNED_SHA in setup.sh + regenerate the diff, or pin to an older codex." >&2
    echo "See HANDOFF.md for the rebase workflow." >&2
    return 1
  fi
  git apply "$patch"
}

write_launch_helper() {
  local LAUNCH_HELPER="$FORK_DIR/launch.sh"
  cat > "$LAUNCH_HELPER" <<EOF
#!/usr/bin/env bash
# Launch helper for opencues-patched codex.
# Generated by integrations/codex/patches/setup.sh.
exec env OPENCUES_DAEMON_PATH="$DAEMON_JS" cargo run --release --manifest-path "$FORK_DIR/codex-rs/Cargo.toml" -p codex-tui -- "\$@"
EOF
  chmod +x "$LAUNCH_HELPER"
}

# ─── orchestrate ─────────────────────────────────────────────────────

run_step "Clone or reuse codex fork"            clone_fork
run_step "Build @opencues/runtime"              build_runtime
run_step "Verify daemon.js produced"            verify_daemon
run_step "Copy bridge crate into fork"          copy_bridge
run_step "Add bridge to Cargo.toml workspace"   patch_workspace
run_step "cargo build -p opencues-bridge"       build_bridge
run_step "Bridge ↔ daemon smoke test"           smoke_test
run_step "Apply TUI bridge-wiring patches"      apply_tui_patches
run_step "Write launch helper"                  write_launch_helper

echo ""
echo "=== Setup complete (infrastructure layer) ==="
echo ""
echo "Bridge crate built + smoke-tested. Daemon path:"
echo "  $DAEMON_JS"
echo ""
echo "Launch helper installed at:"
echo "  $FORK_DIR/launch.sh"
echo ""
echo "TUI patches applied — bridge is wired into chat_composer.rs."
echo "Diff lives at: integrations/codex/patches/tui-bridge-wiring.diff"
echo ""
echo "To run codex:"
if command -v opencues &>/dev/null; then
  echo "  opencues run codex"
else
  echo "  pnpm exec opencues run codex"
fi
echo ""
echo "First run takes ~5 min for the full codex-tui build (cargo)."
echo "Requires libcap-dev on Linux (apt: 'sudo apt install libcap-dev')."
