#!/usr/bin/env bash
# check-test-hermeticity.sh — run `pnpm -r test` (and the CLI's own
# test target) under a sandboxed $HOME, then assert nothing in the
# REAL ~/.opencues/ was touched. Catches the PR #41 failure mode where
# vendor-pins.test.cjs was wiping the user's vendored tmux directory
# on every test run.
#
# Strategy:
#   1. Snapshot the real ~/.opencues/ mtime tree before tests run.
#   2. Point HOME at a fresh tempdir; run `pnpm -r test`.
#   3. After tests finish, walk the real ~/.opencues/ again and
#      compare mtimes. Any change → fail loudly with the path that
#      moved.
#
# Skips the snapshot when ~/.opencues/ doesn't exist (CI runners
# don't have one) — the HOME override is still applied, so a test
# that tries to create ~/.opencues/ would create it under the
# sandbox tempdir, not the real home.

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

REAL_OPENCUES="$HOME/.opencues"
HAVE_BASELINE=0
BASELINE_FILE=""

# Snapshot real ~/.opencues if present. We compare the SORTED list
# of `<path>:<mtime>` entries pre/post — quick diff via diff -u.
if [ -d "$REAL_OPENCUES" ]; then
  BASELINE_FILE="$(mktemp -t opencues-test-baseline.XXXXXX)"
  find "$REAL_OPENCUES" -printf '%P:%T@\n' 2>/dev/null \
    | sort > "$BASELINE_FILE" 2>/dev/null \
    || find "$REAL_OPENCUES" -exec stat -f '%N:%m' {} \; 2>/dev/null \
       | sort > "$BASELINE_FILE"
  HAVE_BASELINE=1
fi

# Sandboxed HOME for the test run. Tests that respect $HOME (via
# os.homedir() / os.userInfo() etc.) silently follow the override.
SANDBOX_HOME="$(mktemp -d -t opencues-test-home.XXXXXX)"

echo "▸ Running tests with HOME=$SANDBOX_HOME (real HOME=$HOME)"
echo ""

# Run the test sweep. If pnpm test fails we still want to compare
# hermeticity afterwards — capture the exit code, run the diff, then
# propagate.
TEST_EXIT=0
HOME="$SANDBOX_HOME" pnpm -r test 2>&1 | tail -5 || TEST_EXIT=$?

# CLI test target is invoked separately (mirrors ci.yml).
HOME="$SANDBOX_HOME" bash -c '
  cd packages/opencues-cli
  GROQ_API_KEY="" CEREBRAS_API_KEY="" OPENAI_API_KEY="" \
  ANTHROPIC_API_KEY="" GEMINI_API_KEY="" \
  npm test 2>&1 | tail -3
' || TEST_EXIT=$?

echo ""
echo "▸ Comparing real $REAL_OPENCUES before/after test run"

HERMETICITY_FAIL=0
if [ "$HAVE_BASELINE" = "1" ]; then
  POST_FILE="$(mktemp -t opencues-test-post.XXXXXX)"
  find "$REAL_OPENCUES" -printf '%P:%T@\n' 2>/dev/null \
    | sort > "$POST_FILE" 2>/dev/null \
    || find "$REAL_OPENCUES" -exec stat -f '%N:%m' {} \; 2>/dev/null \
       | sort > "$POST_FILE"
  if ! diff -u "$BASELINE_FILE" "$POST_FILE" > /tmp/opencues-hermeticity.diff; then
    echo "✗ HERMETICITY VIOLATION — real $REAL_OPENCUES was modified during tests:"
    head -20 /tmp/opencues-hermeticity.diff | sed 's/^/    /'
    echo ""
    echo "    Symptom of a test that wrote to os.homedir() / process.env.HOME"
    echo "    without sandboxing. See PR #41 (June 2026) for the fix pattern:"
    echo "    use a before/after hook that mkdtempSync + sets process.env.HOME."
    HERMETICITY_FAIL=1
  fi
  rm -f "$POST_FILE"
else
  echo "  (no baseline — real ~/.opencues didn't exist before tests)"
fi

# Clean up the sandbox.
rm -rf "$SANDBOX_HOME"
[ -n "$BASELINE_FILE" ] && rm -f "$BASELINE_FILE"

if [ "$TEST_EXIT" -ne 0 ]; then
  echo ""
  echo "✗ Tests themselves failed (exit $TEST_EXIT)."
  exit "$TEST_EXIT"
fi
if [ "$HERMETICITY_FAIL" -ne 0 ]; then
  exit 1
fi
echo "✓ Tests pass + real ~/.opencues unchanged."
