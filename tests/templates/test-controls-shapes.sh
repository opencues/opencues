#!/usr/bin/env bash
# test-controls-shapes.sh — verifies each of the four control shapes
# documented in the new/control.md template (word / blank / step / list)
# can be scaffolded, uncommented, and validated end-to-end.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENCUES="$REPO_ROOT/node_modules/.bin/opencues"
TMP="$(mktemp -d -t oc-template-controls.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
"$OPENCUES" init >/dev/null 2>&1

pass() { printf "  PASS %s\n" "$1"; }
fail() { printf "  FAIL %s\n" "$1" >&2; exit 1; }

# Helper: scaffold a new control + uncomment a labelled shape block.
# The new/control.md template has 4 SHAPE blocks delimited by section
# banners. Only lines matching `# <yaml-key>: ...` at column 0 (no extra
# indent) are uncommented — descriptive lines like `#   script:  path…`
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
# Mirrors the documented user step "colocate <name>.sh next to cue.md".
make_stub() {
  local file="$1"
  printf '#!/usr/bin/env bash\necho stub\n' > "$file"
  chmod +x "$file"
}

# ─── SHAPE 1: Word-control (volume-style) ─────────────────────────
echo "=== SHAPE 1: word-control ==="
"$OPENCUES" new control my-word --project >/dev/null 2>&1
uncomment_shape .opencues/controls/my-word/cue.md "Word-control"
make_stub .opencues/controls/my-word/my-word.sh
assert_field .opencues/controls/my-word/cue.md "script"
assert_field .opencues/controls/my-word/cue.md "upArgs"
assert_field .opencues/controls/my-word/cue.md "downArgs"

# ─── SHAPE 2: Blank-control ───────────────────────────────────────
echo "=== SHAPE 2: blank-control ==="
"$OPENCUES" new control my-blank --project >/dev/null 2>&1
uncomment_shape .opencues/controls/my-blank/cue.md "Blank-control"
make_stub .opencues/controls/my-blank/my-blank-blank.sh
assert_field .opencues/controls/my-blank/cue.md "blankKeywords"
assert_field .opencues/controls/my-blank/cue.md "blankAutoPopulate"
assert_field .opencues/controls/my-blank/cue.md "blankFormat"

# ─── SHAPE 3: Step control ────────────────────────────────────────
echo "=== SHAPE 3: step-control ==="
"$OPENCUES" new control my-step --project >/dev/null 2>&1
uncomment_shape .opencues/controls/my-step/cue.md "Step control"
assert_field .opencues/controls/my-step/cue.md "stepSuffixes"
assert_field .opencues/controls/my-step/cue.md "step"
assert_field .opencues/controls/my-step/cue.md "stepFormat"

# ─── SHAPE 4: List control ────────────────────────────────────────
echo "=== SHAPE 4: list-control ==="
"$OPENCUES" new control my-list --project >/dev/null 2>&1
uncomment_shape .opencues/controls/my-list/cue.md "List control"
assert_field .opencues/controls/my-list/cue.md "blankKeywords"
assert_field .opencues/controls/my-list/cue.md "stepValues"

echo "=== validate all four shapes together ==="
"$OPENCUES" validate --project >/dev/null 2>&1 || { "$OPENCUES" validate --project; fail "validate failed"; }
pass "all four control shapes validate together"

echo "=== list shows all four controls ==="
LIST="$("$OPENCUES" list --project 2>&1)"
for c in my-word my-blank my-step my-list; do
  echo "$LIST" | grep -q "$c" || fail "list missing control '$c'"
done
pass "list registers all four controls (my-word, my-blank, my-step, my-list)"

echo
echo "PASS: test-controls-shapes.sh (4 shapes × 2-3 fields + validate + list = 14 checks)"
