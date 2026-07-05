#!/usr/bin/env bash
# check-cc-bundle-integrity.sh — assert the CC fork bundle layout
# stays coherent: every dist subdir of @opencues/{core,runtime} that
# setup.sh would copy into a fork is reachable from the require chain
# the CC patch's bootstrap actually does.
#
# Bug class this guards against (June 2026, the providers/ regression):
#   - PR adds a new file/subdir under packages/opencues-{core,runtime}/dist/
#     (e.g. PR #117 added providers/claude-cli-daemon.ts).
#   - integrations/claude-code/patches/setup.sh's copy step misses it
#     (the pre-PR version had a hard-coded "sources" list).
#   - Installed @opencues/core/model-aliases.js requires a missing
#     ./providers/claude-cli-daemon — at boot it throws.
#   - CC patch's outer try/catch sets __oc.failed=true and swallows
#     the error.
#   - User: no cues, no blanks, no log line, no install error.
#     validateFork reported success because it only checked for
#     opencues markers, not for whether the runtime actually loads.
#
# The fix that landed in the same PR:
#   1. setup.sh recursively copies every dist/*/ subdir.
#   2. install.cjs validateFork() runs a boot-smoke probe per fork
#      that catches the failure class at install time.
#   3. This script runs the equivalent probe in CI on every PR so the
#      same bug class is blocked before merge, without needing a real
#      install + a tweakcc round-trip.
#
# What this gate checks:
#   1. Build @opencues/{core,runtime} (assumes pnpm install already ran).
#   2. Create a tmp "synthetic CC fork" at $TMPDIR/oc-cc-bundle-test/
#      with the exact copy logic setup.sh uses.
#   3. From inside that synthetic fork's root, `node -e "require(<spec>)"`
#      every path the CC patch's bootstrap pulls (mirrors
#      integrations/claude-code/bin/install.cjs validateFork's smokeProbes).
#   4. Each require must exit 0. Any failure → name the spec + show
#      stderr + exit 1.
#
# Runtime: ~10s warm (no tweakcc, no native npm install, no nuke).
# Bypass: OPENCUES_SKIP_CC_BUNDLE_PROBE=1.

set -euo pipefail

if [ -n "${OPENCUES_SKIP_CC_BUNDLE_PROBE:-}" ]; then
  echo "  skipped (OPENCUES_SKIP_CC_BUNDLE_PROBE=1)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CUES_CORE="$REPO_ROOT/packages/opencues-core"
CUES_RUNTIME="$REPO_ROOT/packages/opencues-runtime"

# Ensure the dist trees exist. pre-pr.sh's build gate runs before us
# in the canonical order, but allow standalone invocation by running
# the build ourselves when dist/ is missing.
if [ ! -d "$CUES_CORE/dist" ]; then
  echo "  ▸ building @opencues/core (dist/ missing)"
  (cd "$CUES_CORE" && pnpm build --silent 2>/dev/null || pnpm build) >/dev/null
fi
if [ ! -d "$CUES_RUNTIME/dist" ]; then
  echo "  ▸ building @opencues/runtime (dist/ missing)"
  (cd "$CUES_RUNTIME" && pnpm build --silent 2>/dev/null || pnpm build) >/dev/null
fi

TMP="${TMPDIR:-/tmp}/oc-cc-bundle-test-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# Mirror integrations/claude-code/patches/setup.sh § 5 exactly. If
# setup.sh ever changes its copy logic, mirror the change here too —
# the whole point is that this gate runs the SAME bundle-assembly
# that ships to users. A divergence would invalidate the test.
OC_NM_DIR="$TMP/node_modules/@opencues"
mkdir -p "$OC_NM_DIR/core" "$OC_NM_DIR/runtime/dist"

# core: flat .js/.d.ts files + node-http-adapter.js + every dist subdir
# (sources/, providers/, …). The for-loop is the recursive fix from the
# June 2026 PR; if it regresses to a hard-coded list, the providers/
# bug class returns and this gate catches it.
cp "$CUES_CORE"/dist/*.js "$CUES_CORE"/dist/*.d.ts "$OC_NM_DIR/core/" 2>/dev/null || true
[ -f "$CUES_CORE/node-http-adapter.js" ] && cp "$CUES_CORE/node-http-adapter.js" "$OC_NM_DIR/core/"
# `${sub%/}` strips the trailing slash the `*/` glob leaves — without it
# BSD cp (macOS) copies the directory *contents* into core/ (flattening
# sources/ → core/*.js), diverging from GNU cp. Mirrors the same fix in
# setup.sh § 5.
for sub in "$CUES_CORE"/dist/*/; do
  [ -d "$sub" ] || continue
  cp -r "${sub%/}" "$OC_NM_DIR/core/"
done

# runtime: full recursive dist mirror, then point package.json's main
# at the bundled main.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$CUES_RUNTIME/dist/" "$OC_NM_DIR/runtime/dist/"
else
  cp -r "$CUES_RUNTIME/dist/." "$OC_NM_DIR/runtime/dist/"
fi

# Per-package.json: write the same as setup.sh does (main: index.js,
# types: index.d.ts for core; runtime keeps dist/src/index.js).
node -e "
const fs = require('fs');
const corePkg = JSON.parse(fs.readFileSync('$CUES_CORE/package.json', 'utf8'));
corePkg.main = 'index.js';
corePkg.types = 'index.d.ts';
fs.writeFileSync('$OC_NM_DIR/core/package.json', JSON.stringify(corePkg, null, 2));
const rtPkg = JSON.parse(fs.readFileSync('$CUES_RUNTIME/package.json', 'utf8'));
fs.writeFileSync('$OC_NM_DIR/runtime/package.json', JSON.stringify(rtPkg, null, 2));
"

# Smoke probe — every spec the CC patch's bootstrap requires.
# Mirrors integrations/claude-code/bin/install.cjs validateFork's
# smokeProbes list; keep in sync.
#
# REQUIRED specs: the patch's main boot path requires these
# unconditionally. A failure here means CC boots into __oc.failed=true
# silently, no cues + no blanks. Block the PR.
#
# OPTIONAL specs: the patch wraps these in their own try/catch so a
# failure degrades a feature but doesn't break boot. Print a ⚠ but
# don't fail. Today user-blanks/registry.js is optional because the
# patch's `try { … buildUserBlankRegistry … } catch (__ocUbE) {}`
# swallows acorn-missing — built-in blanks keep working. Tracked as a
# follow-up to either bundle acorn into runtime's dist or extend
# setup.sh to npm-install runtime's deps.
REQUIRED_SPECS=(
  "@opencues/runtime"
  "@opencues/runtime/dist/adapters/cc/v2.1/boot.js"
  "@opencues/runtime/dist/src/blanks/index.js"
  "@opencues/runtime/dist/src/security/spawn-sandbox.js"
  "@opencues/runtime/dist/src/security/sandbox-runner.js"
  # Fork layout flattens core's dist/ into the package root (setup.sh
  # § 5), so core specs are `@opencues/core/<file>.js`, not dist paths.
  "@opencues/core/env-keys.js"
)
OPTIONAL_SPECS=(
  "@opencues/runtime/dist/src/user-blanks/registry.js"
)

# Run each require from the synthetic fork's root. NODE_PATH is
# explicitly cleared so we match a real CC launch's resolution scope
# — without this, pnpm's hoisted node_modules would mask missing
# deps (the very mode that masked the providers/ bug locally during
# the original install's smoke probe).
FAIL=0
for spec in "${REQUIRED_SPECS[@]}"; do
  if err="$(cd "$TMP" && env -u NODE_PATH "$(command -v node)" -e "require('$spec')" 2>&1)"; then
    echo "  ✓ $spec  (required)"
  else
    echo "  ✗ $spec  (REQUIRED) — load failed:"
    echo "$err" | head -4 | sed 's/^/      /'
    FAIL=1
  fi
done
for spec in "${OPTIONAL_SPECS[@]}"; do
  if err="$(cd "$TMP" && env -u NODE_PATH "$(command -v node)" -e "require('$spec')" 2>&1)"; then
    echo "  ✓ $spec  (optional)"
  else
    echo "  ⚠ $spec  (optional) — load failed; feature silently disabled in user fork:"
    echo "$err" | head -2 | sed 's/^/      /'
  fi
done

if [ "$FAIL" -ne 0 ]; then
  cat <<EOF

  Bundle-integrity probe failed. One or more specs the CC patch
  requires at boot can't be loaded from a freshly-assembled fork.
  Likely causes:

  1. A new file/subdir was added under packages/opencues-{core,runtime}/dist/
     but integrations/claude-code/patches/setup.sh § 5 doesn't copy
     it. Recursive copy (the for-loop in setup.sh) should cover any
     dist/*/ subdir — if a NON-subdir top-level file was added, extend
     the copy step too.
  2. @opencues/runtime declared a new npm dependency that the fork
     doesn't carry in its own node_modules. The fork only ships
     @opencues/{core,runtime}; transitive npm deps (acorn, etc.) come
     from the workspace's hoisted node_modules at dev time but are
     missing on a user's machine. Either bundle the dep into runtime's
     dist (esbuild / tsup) or document it for the fork install.

  This is the same bug class that produced the providers/claude-cli-daemon
  regression in June 2026 (PR #117) — silent boot failure with no log
  line, no install error.
EOF
  exit 1
fi
