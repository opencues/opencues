#!/usr/bin/env bash
# pre-pr.sh — run every CI gate locally before pushing. Shipping a
# PR that breaks one of these wastes a CI round-trip + invites the
# class of follow-up-PR-to-fix-the-PR pattern we hit June 2026
# (PRs #42 → #48, #47 → #49).
#
# Each check is a separate step so the script prints a clear ●/✗
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
    echo "  [32m●[0m $name"
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

# ─── 1a. Windows native ASCII guard ────────────────────────────────
# Windows PowerShell 5.1 reads .ps1/.vbs as ANSI, not UTF-8 — a non-ASCII
# literal (—, …, →) mojibakes and can break parsing, silently killing the
# tray. Keep the native launchers + Add-Type'd .cs pure ASCII.
step "windows native ASCII guard" bash scripts/check-windows-native-ascii.sh

# ─── 1b. Legacy-names lint ─────────────────────────────────────────
# Catches the rename-drift class — old feature names lingering in    # LEGACY-NAME-ALLOW: aggregator comment
# shipping code after a rename. Banned identifiers live in           # LEGACY-NAME-ALLOW: aggregator comment
# scripts/lint-legacy-names.sh:BANNED_PATTERNS. Each legacy          # LEGACY-NAME-ALLOW: aggregator comment
# reference outside the migration allowlist must either go away      # LEGACY-NAME-ALLOW: aggregator comment
# or carry a LEGACY-NAME-ALLOW marker on the same line.
step "legacy-names lint" bash scripts/lint-legacy-names.sh

# Catches runtime/core code that's silently dead in chrome's content script
# (unguarded `process`, unmarked NodeHttpAdapter) — the class the esbuild
# build can't see. See docs/architecture/chrome-runtime-compat.md.
step "runtime browser-safe lint (chrome content-script compat)" bash scripts/lint-runtime-browser-safe.sh

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

# ─── 4b. CC patch boot smoke ────────────────────────────────────────
# The CC patch emits a JS string injected into cli.js. Source typechecks
# don't catch identifier scope errors in that emitted string. June 2026
# the patch shipped `blanks: __ocReg` where __ocReg was IIFE-local —
# every keystroke ReferenceError'd, the patch's try/catch swallowed it,
# globalThis.__oc.failed=true, OpenCues silently dead on every CC user.
# This evaluates the emitted bootstrap in a Node vm sandbox so any
# scope/reference error throws at smoke time, not on the user's machine.
step "CC patch boot smoke (catches scope errors in emitted JS)" node scripts/check-cc-patch-boot.cjs

# ─── 4b. Runtime loads on Bun (catches Node-only native imports) ────
# Bug class: a Node-V8 native binding gets added as a top-level
# import in @opencues/runtime; opencode + shell (Bun-based) then
# crash at boot with "undefined symbol" before any try/catch can
# fire. Tests run on Node so unit coverage stays green while every
# Bun host is broken in production. b460076 isolated-vm migration
# (June 2026) is the canonical incident — opencode + shell crashed
# at boot for hours before the agentic harness caught it.
step "runtime loads on bun (catches Node-only native imports)" bash scripts/check-runtime-loads-on-bun.sh

# ─── 4c. CC fork bundle integrity (catches dist-subdir copy gaps) ───
# Bug class (June 2026, providers/claude-cli-daemon): a PR adds a new
# subdir under packages/opencues-{core,runtime}/dist/; setup.sh's
# copy step misses it (the pre-fix version hard-coded "sources" only);
# installed model-aliases.js requires the missing module; CC patch's
# outer try/catch sets __oc.failed=true; user has no cues + no blanks
# + no log line + no install error. validateFork passed because it
# only checked for opencues markers, not for whether the runtime
# actually loads. This evaluates the EXACT bundle setup.sh would
# assemble + runs the same require chain the patch's bootstrap does,
# from a clean NODE_PATH so the workspace's hoisted deps can't mask
# the missing-module case. ~10s.
step "CC fork bundle integrity (catches dist-subdir copy gaps)" bash scripts/check-cc-bundle-integrity.sh

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
  echo "[32m●[0m pre-PR gates pass. Safe to push."
  exit 0
else
  echo ""
  echo "✗ $FAIL gate(s) failed — fix before pushing."
  exit 1
fi
