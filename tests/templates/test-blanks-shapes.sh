#!/usr/bin/env bash
# test-blanks-shapes.sh — verifies the scaffoldable blank shapes
# documented in the new/blank.md template (typed-blank-with-script /
# list-blank) can be scaffolded, uncommented, and validated end-to-end.
#
# SHAPEs 3 (selector + satellite) and 4 (runtime-class) aren't tested
# here — selector/satellite needs runtime + opencues.md state,
# runtime-class is TS code outside the scaffold flow.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENCUES="$REPO_ROOT/node_modules/.bin/opencues"
TMP="$(mktemp -d -t oc-template-blanks.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
"$OPENCUES" init >/dev/null 2>&1

pass() { printf "  PASS %s\n" "$1"; }
fail() { printf "  FAIL %s\n" "$1" >&2; exit 1; }

# Helper: scaffold a new blank + uncomment a labelled shape block.
# The new/blank.md template has 4 SHAPE blocks delimited by section
# banners. Only lines matching `# <yaml-key>: ...` at column 0 (no extra
# indent) are uncommented — descriptive lines like `#   blankScript: path…`
# stay commented because they're indented prose, not real config.
uncomment_shape() {
  local file="$1" shape_label="$2"
  python3 - "$file" "$shape_label" <<'PY'
import sys, re
path, label = sys.argv[1], sys.argv[2]
KEY = re.compile(r'^# ([a-zA-Z][a-zA-Z0-9_]*):')   # "# field:" at col 0
with open(path) as f:
    lines = f.readlines()
in_block = False
for i, L in enumerate(lines):
    if re.match(rf'^# SHAPE \d+:.*{re.escape(label)}', L, re.IGNORECASE):
        in_block = True
        continue
    elif re.match(r'^# SHAPE \d+:', L) and in_block:
        in_block = False
    if in_block and KEY.match(L):
        lines[i] = L[2:]
with open(path, 'w') as f:
    f.writelines(lines)
PY
}

assert_field() {
  local file="$1" field="$2"
  if grep -qE "^${field}:" "$file"; then
    pass "$(basename "$(dirname "$file")"): $field present"
  else
    fail "$(basename "$(dirname "$file")"): $field missing after uncomment"
  fi
}

# Helper: create the stub script the template's example references.
make_stub() {
  local file="$1"
  printf '#!/usr/bin/env bash\necho stub\n' > "$file"
  chmod +x "$file"
}

# ─── SHAPE 1: Typed blank with script (volume-style) ──────────────
echo "=== SHAPE 1: typed blank ==="
"$OPENCUES" new blank my-typed --project >/dev/null 2>&1
uncomment_shape .cues/blanks/my-typed/BLANK.md "Typed blank"
make_stub .cues/blanks/my-typed/my-typed-blank.sh
assert_field .cues/blanks/my-typed/BLANK.md "blankKeywords"
assert_field .cues/blanks/my-typed/BLANK.md "blankScript"
assert_field .cues/blanks/my-typed/BLANK.md "blankAutoPopulate"

# ─── SHAPE 2: List blank (no script — fixed cycle list) ───────────
echo "=== SHAPE 2: list blank ==="
"$OPENCUES" new blank my-list --project >/dev/null 2>&1
uncomment_shape .cues/blanks/my-list/BLANK.md "List blank"
assert_field .cues/blanks/my-list/BLANK.md "blankKeywords"
assert_field .cues/blanks/my-list/BLANK.md "stepValues"

echo "=== validate both shapes together ==="
"$OPENCUES" validate --project >/dev/null 2>&1 || { "$OPENCUES" validate --project; fail "validate failed"; }
pass "both blank shapes validate together"

echo "=== list shows both blanks ==="
LIST="$("$OPENCUES" list --project 2>&1)"
for b in my-typed my-list; do
  echo "$LIST" | grep -q "$b" || fail "list missing blank '$b'"
done
pass "list registers both blanks (my-typed, my-list)"

echo
echo "PASS: test-blanks-shapes.sh (2 shapes × 2-3 fields + validate + list = 8 checks)"
