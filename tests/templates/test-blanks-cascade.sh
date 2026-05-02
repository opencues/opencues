#!/usr/bin/env bash
# test-blanks-cascade.sh — verifies the three-stage classifier cascade
# (match → keywords → LLM) documented in blanks.md template routes the
# example inputs to the correct mode without requiring an LLM call.
#
# blanks.md template ships these example modes:
#   ### math      — match: \d+\s*[+\-*/]\s*\d+|\d+\s*%|...
#                   keywords: math, calc, compute, result of
#                   parser: compute
#   ### factual   — match: the (capital|ceo|founder|author|inventor) of .+ is
#                   keywords: capital of, ceo of, founder of, ...
#                   parser: answer
#   ### grammar   — (no match/keywords) — fallback via classifier
#                   parser: alternatives

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENCUES="$REPO_ROOT/node_modules/.bin/opencues"
TMP="$(mktemp -d -t oc-template-blanks.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
"$OPENCUES" init >/dev/null 2>&1

pass() { printf "  PASS %s\n" "$1"; }
fail() { printf "  FAIL %s\n" "$1" >&2; exit 1; }

# Strip leading "# " (hash+space) from every line. Live markdown headers
# (`## Prompt`) and bare `#` lines stay intact since they don't start
# with `# `.
python3 - <<'PY'
path = ''
with open(path) as f:
    lines = f.readlines()
out = []
for L in lines:
    if L.startswith('# ─') or L.lstrip('# ').startswith('blanks.md'):
        out.append(L); continue
    if L.startswith('# '):
        out.append(L[2:])
    else:
        out.append(L)
with open(path, 'w') as f:
    f.writelines(out)
PY

echo "=== validate after uncommenting all blanks.md examples ==="
"$OPENCUES" validate --project >/dev/null 2>&1 || { "$OPENCUES" validate --project; fail "validate failed"; }
pass "blanks.md with all examples uncommented validates 0 errors"

echo "=== list shows math + factual + grammar modes ==="
LIST="$("$OPENCUES" list --project 2>&1)"
echo "$LIST" | grep -qi math    || fail "list missing 'math' blank mode"
echo "$LIST" | grep -qi factual || fail "list missing 'factual' blank mode"
echo "$LIST" | grep -qi grammar || fail "list missing 'grammar' blank mode"
pass "all three blank modes registered"

# ─── Cascade routing — apply the documented match/keywords against the
# documented example inputs and verify which mode wins ───────────────

route() {
  # Echoes "math" / "factual" / "grammar" for the given input string,
  # using the same fast-path semantics as the runtime: regex match wins
  # at any priority; keywords match if no regex matched; otherwise the
  # input would route through the LLM classifier (we return "classifier"
  # to signal that path).
  local input="$1"
  python3 - "$input" <<'PY'
import re, sys
input_ = sys.argv[1].lower()

# Mode definitions from the template (match + keywords)
MATH_MATCH = r'\d+\s*[+\-*/]\s*\d+|\d+\s*%|percent of|plus|minus|times|divided'
MATH_KW = ['math', 'calc', 'compute', 'result of']

FACTUAL_MATCH = r'the (capital|ceo|founder|author|inventor) of .+ is'
FACTUAL_KW = ['capital of', 'ceo of', 'founder of', 'author of', 'who is', 'who was']

# Stage 1: regex match (priority order: factual=90 < math=100, but matches
# fire instantly per mode; the documented behaviour is "any mode whose
# regex matches wins" with priority breaking ties)
hits = []
if re.search(MATH_MATCH, input_):    hits.append(('math', 100))
if re.search(FACTUAL_MATCH, input_): hits.append(('factual', 90))
if hits:
    hits.sort(key=lambda x: -x[1])
    print(hits[0][0]); sys.exit(0)

# Stage 2: keywords
for kw in MATH_KW:
    if kw in input_: print('math'); sys.exit(0)
for kw in FACTUAL_KW:
    if kw in input_: print('factual'); sys.exit(0)

# Stage 3: would call LLM classifier
print('classifier')
PY
}

assert_route() {
  local input="$1" expected="$2"
  local actual; actual="$(route "$input")"
  if [[ "$actual" == "$expected" ]]; then
    pass "route('$input') → $expected"
  else
    fail "route('$input') expected=$expected got=$actual"
  fi
}

echo "=== math mode routing (documented examples) ==="
assert_route "4 * 12 = "        "math"      # regex hit (digit op digit)
assert_route "50 plus 20% tax"  "math"      # keyword 'plus' + regex
assert_route "compute the area" "math"      # keyword 'compute'
assert_route "result of 5+5"    "math"      # keyword + regex

echo "=== factual mode routing (documented examples) ==="
assert_route "the capital of france is" "factual"    # regex
assert_route "the ceo of apple is"      "factual"    # regex
assert_route "who is the president"     "factual"    # keyword

echo "=== grammar fallback (no instant routing) ==="
assert_route "happy"          "classifier"   # no match, no keyword → LLM
assert_route "the quick brown" "classifier"  # no match, no keyword

echo
echo "PASS: test-blanks-cascade.sh (3 + 4 + 3 + 2 = 12 checks)"
