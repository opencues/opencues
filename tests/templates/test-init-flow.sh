#!/usr/bin/env bash
# test-init-flow.sh — verifies the `opencues init` → `opencues new` →
# `opencues validate` journey documented in the template README produces
# a valid .opencues/ with 0 errors.
#
# Exit 0 on pass, non-zero on any failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENCUES="$REPO_ROOT/node_modules/.bin/opencues"
TMP="$(mktemp -d -t oc-template-init.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"

pass() { printf "  PASS %s\n" "$1"; }
fail() { printf "  FAIL %s\n" "$1" >&2; exit 1; }

echo "=== init ==="
"$OPENCUES" init >/dev/null 2>&1 || fail "opencues init failed"
[[ -f .opencues/cues.md ]]     || fail ".opencues/cues.md missing"
[[ -f .opencues/blanks.md ]]   || fail ".opencues/blanks.md missing"
[[ -f .opencues/README.md ]]   || fail ".opencues/README.md missing"
[[ ! -f .opencues/opencues.md ]] || fail ".opencues/opencues.md should NOT be scaffolded (user-level only)"
pass "init scaffolded 3 files (no opencues.md)"

echo "=== validate fresh init ==="
"$OPENCUES" validate --project >/dev/null 2>&1 || fail "validate failed after init"
pass "fresh init validates 0 errors"

echo "=== opencues new cue ==="
"$OPENCUES" new cue my-synonyms --project >/dev/null 2>&1 || fail "new cue failed"
[[ -f .opencues/cues/my-synonyms/cue.md ]] || fail "new cue did not create cue.md"
pass "new cue scaffolds cue.md"

echo "=== opencues new blank ==="
"$OPENCUES" new blank my-answer --project >/dev/null 2>&1 || fail "new blank failed"
[[ -f .opencues/blanks/my-answer/cue.md ]] || fail "new blank did not create cue.md"
pass "new blank scaffolds cue.md"

echo "=== validate after new ==="
"$OPENCUES" validate --project >/dev/null 2>&1 || fail "validate failed after new <kind>"
pass "all new <kind> commands validate 0 errors"

echo "=== refuse to overwrite ==="
if "$OPENCUES" new cue my-synonyms --project >/dev/null 2>&1; then
  fail "new cue should have refused to overwrite existing cue.md"
fi
pass "new cue refuses to overwrite existing target"

echo
echo "PASS: test-init-flow.sh (6 checks)"
