#!/usr/bin/env bash
# pre-pr.sh — run every CI gate locally before pushing. Shipping a
# PR that breaks one of these wastes a CI round-trip + invites the
# class of follow-up-PR-to-fix-the-PR pattern we hit June 2026
# (PRs #42 → #48, #47 → #49).
#
# Each check is a separate step so the script prints a clear ✓/✗
# per gate. Failure of any step exits non-zero with that gate's
# name; subsequent gates still run so the user sees the full report.
#
# Typical run takes ~3 minutes warm (test sweep dominates). Skip
# individual gates by setting:
#   SKIP_TESTS=1 SKIP_BUILD=1 SKIP_INSTALL_SMOKE=1 bash scripts/pre-pr.sh
#
# Wired into CLAUDE.md § "Before you merge" as the one-command
# pre-flight. Mirrors ci.yml's gates so green here ≈ green in CI.

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
RAN=0
SKIPPED=0

step() {
  local name="$1"
  shift
  RAN=$((RAN + 1))
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  echo "▸ $name"
  echo "──────────────────────────────────────────────────────────────"
  if "$@"; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name FAILED"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  SKIPPED=$((SKIPPED + 1))
  echo ""
  echo "▸ Skipped: $1 (\$SKIP_${2} set)"
}

# ─── 1. Shell portability + strict-mode lint ────────────────────────
step "shell-portability lint" bash scripts/lint-shell-portability.sh

# ─── 2. Version-bump gate ──────────────────────────────────────────
step "version-bump gate (vs origin/master)" bash scripts/lint-version-bump.sh

# ─── 3. Build everything (turbo cached) ─────────────────────────────
if [ -z "${SKIP_BUILD:-}" ]; then
  step "pnpm build (turbo)" pnpm build
else
  skip "pnpm build" BUILD
fi

# ─── 4. Chrome bundle assertion ─────────────────────────────────────
step "chrome bundle assertion" bash scripts/check-chrome-bundle.sh

# ─── 5. Test hermeticity + full sweep ──────────────────────────────
if [ -z "${SKIP_TESTS:-}" ]; then
  step "test-hermeticity (pnpm -r test + CLI tests, sandboxed \$HOME)" bash scripts/check-test-hermeticity.sh
else
  skip "test sweep" TESTS
fi

# ─── 6. Install self-heal smoke ─────────────────────────────────────
if [ -z "${SKIP_INSTALL_SMOKE:-}" ]; then
  step "install self-heal smoke (shell)" bash scripts/check-install-self-heal.sh
else
  skip "install self-heal smoke" INSTALL_SMOKE
fi

# ─── 7. doctor (warn-level only) ────────────────────────────────────
# Final defence: flag any real install-state ⚠ that would surface on
# the user's machine. The June 2026 doctor fix made the /mnt/c chrome
# check content-based (not mtime-based), so `pnpm build` no longer
# produces a false-positive stale-bundle warning. CI should use
# `opencues doctor --strict` directly — clean runners have no
# extra-fork or sync-state findings, so info-level findings ARE
# meaningful there.
step "opencues doctor" node packages/opencues-cli/bin/cli.cjs doctor

# ─── Summary ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "SUMMARY"
echo "══════════════════════════════════════════════════════════════"
echo "  ran:     $RAN"
echo "  failed:  $FAIL"
echo "  skipped: $SKIPPED"
if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "✓ pre-PR gates pass. Safe to push."
  exit 0
else
  echo ""
  echo "✗ $FAIL gate(s) failed — fix before pushing."
  exit 1
fi
