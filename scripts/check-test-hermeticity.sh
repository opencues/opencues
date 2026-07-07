#!/usr/bin/env bash
# check-test-hermeticity.sh — run `pnpm -r test` (and the CLI's own
# test target) under a sandboxed $HOME, then assert nothing in the
# REAL ~/.opencues/ OR ~/.cues/ was touched.
#
# Coverage:
#   - ~/.opencues/  — vendored deps (tmux), update lock, internal state.
#                     PR #41 (June 2026) caught vendor-pins.test.cjs
#                     wiping the user's tmux dir here on every test run.
#   - ~/.cues/      — user's live config: OPENCUES.md, CUES.md, IDENTITY.md,
#                     cues/<topic>/CUE.md, blanks/<name>/BLANK.md. A test
#                     that bypasses the HOME sandbox via a hardcoded path
#                     or reads $USER instead of $HOME could write here.
#                     Added after the user reported their OPENCUES.md
#                     scalars drifting unexpectedly between test runs.
#
# Strategy:
#   1. Snapshot the real ~/.opencues/ AND ~/.cues/ mtime trees before tests.
#   2. Point HOME at a fresh tempdir; run `pnpm -r test`.
#   3. After tests finish, walk both real dirs again and compare mtimes.
#      Any change → fail loudly with the path that moved.
#
# Skips the snapshot for any dir that doesn't exist (CI runners don't have
# either) — the HOME override is still applied, so a test that tries to
# create one would create it under the sandbox tempdir, not the real home.

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Watched dirs: name → real path. Used to fail with both the missing-
# guard name and the actual file that was touched.
declare -a WATCH_DIRS=("$HOME/.opencues" "$HOME/.cues")

# Parallel arrays to track baseline state per dir.
declare -a HAVE_BASELINE=()
declare -a BASELINE_FILES=()

snapshot_dir() {
  local dir="$1" out="$2"
  find "$dir" -printf '%P:%T@\n' 2>/dev/null \
    | sort > "$out" 2>/dev/null \
    || find "$dir" -exec stat -f '%N:%m' {} \; 2>/dev/null \
       | sort > "$out"
}

# Snapshot every watched dir that exists. We compare the SORTED list
# of `<path>:<mtime>` entries pre/post — quick diff via diff -u.
for dir in "${WATCH_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    file="$(mktemp -t opencues-test-baseline.XXXXXX)"
    snapshot_dir "$dir" "$file"
    HAVE_BASELINE+=("1")
    BASELINE_FILES+=("$file")
  else
    HAVE_BASELINE+=("0")
    BASELINE_FILES+=("")
  fi
done

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
HERMETICITY_FAIL=0

for i in "${!WATCH_DIRS[@]}"; do
  dir="${WATCH_DIRS[$i]}"
  echo "▸ Comparing real $dir before/after test run"
  if [ "${HAVE_BASELINE[$i]}" = "1" ]; then
    POST_FILE="$(mktemp -t opencues-test-post.XXXXXX)"
    snapshot_dir "$dir" "$POST_FILE"
    DIFF_FILE="/tmp/opencues-hermeticity-$(basename "$dir").diff"
    if ! diff -u "${BASELINE_FILES[$i]}" "$POST_FILE" > "$DIFF_FILE"; then
      echo "✗ HERMETICITY VIOLATION — real $dir was modified during tests:"
      head -20 "$DIFF_FILE" | sed 's/^/    /'
      echo ""
      echo "    Symptom of a test that wrote to os.homedir() / process.env.HOME"
      echo "    without sandboxing. See PR #41 (June 2026) for the fix pattern:"
      echo "    use a before/after hook that mkdtempSync + sets process.env.HOME."
      HERMETICITY_FAIL=1
    fi
    rm -f "$POST_FILE"
  else
    echo "  (no baseline — real $dir didn't exist before tests)"
  fi
done

# Clean up the sandbox.
rm -rf "$SANDBOX_HOME"
for f in "${BASELINE_FILES[@]}"; do
  [ -n "$f" ] && rm -f "$f"
done

if [ "$TEST_EXIT" -ne 0 ]; then
  echo ""
  echo "✗ Tests themselves failed (exit $TEST_EXIT)."
  exit "$TEST_EXIT"
fi
if [ "$HERMETICITY_FAIL" -ne 0 ]; then
  exit 1
fi
echo "[32m●[0m Tests pass + real ~/.opencues and ~/.cues unchanged."
