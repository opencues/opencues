#!/usr/bin/env bash
# check-install-self-heal.sh — pins the structural contract that
# `opencues run <host>` doesn't loop on stale-bundle detection.
#
# The bug it catches: PR #42 added srcHash drift detection in
# `opencues run <host>`. PR #48 had to follow up because CC's install
# short-circuited "already healthy" without updating the marker —
# every `opencues run cc` saw drift, "rebuilt", and the marker stayed
# stale forever. Loop closed only after the install gate became
# srcHash-aware.
#
# This check runs the structural scenario end-to-end:
#   1. `opencues install <host>` — establish fresh baseline.
#   2. `opencues run <host>` once — must NOT print "Rebuilding".
#   3. `opencues run <host>` AGAIN — must STILL NOT print
#      "Rebuilding". If either run rebuilds, the loop is open.
#
# Targets the shell host because it's lightest (~30s install, no
# tmux preflight on a system that already has it). Adjust SH_HOST
# to test others.
#
# Pre-conditions: built CLI + the host already vendored once.
# Cost: ~1 minute for the warm shell install + 2 runs.

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SH_HOST="${SH_HOST:-shell}"
CLI="node packages/opencues-cli/bin/cli.cjs"

echo "▸ Installing $SH_HOST (baseline)…"
$CLI install "$SH_HOST" --no-prompts --yes > /tmp/install-baseline.log 2>&1

echo "▸ Run 1 (must not rebuild):"
RUN1_OUT=$(timeout 15 $CLI run "$SH_HOST" --skip-banner < /dev/null 2>&1 || true)
if echo "$RUN1_OUT" | grep -q "Rebuilding before launch"; then
  echo "✗ Run 1 triggered a rebuild — drift falsely detected after install:"
  echo "$RUN1_OUT" | head -8 | sed 's/^/    /'
  exit 1
fi
echo "  ✓ no rebuild fired"

echo "▸ Run 2 (must not rebuild):"
RUN2_OUT=$(timeout 15 $CLI run "$SH_HOST" --skip-banner < /dev/null 2>&1 || true)
if echo "$RUN2_OUT" | grep -q "Rebuilding before launch"; then
  echo "✗ Run 2 triggered a rebuild — install path's marker write is broken."
  echo "    This is the PR #48 failure mode: install short-circuits on"
  echo "    'already healthy' without updating the marker, so srcHash drift"
  echo "    fires on every launch."
  echo "$RUN2_OUT" | head -8 | sed 's/^/    /'
  exit 1
fi
echo "  ✓ no rebuild fired"

echo ""
echo "✓ Install self-heal contract holds: zero false rebuilds across 2 launches."
