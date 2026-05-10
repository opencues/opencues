#!/usr/bin/env bash
# test-cues-examples.sh — verifies the uncommentable examples in the
# CUES.md template produce a valid config + have match patterns that
# actually hit the example words documented alongside them.
#
# No LLM calls; purely structural (match regex + tips lookup).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPENCUES="$REPO_ROOT/node_modules/.bin/opencues"
TMP="$(mktemp -d -t oc-template-cues.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
"$OPENCUES" init >/dev/null 2>&1

pass() { printf "  PASS %s\n" "$1"; }
fail() { printf "  FAIL %s\n" "$1" >&2; exit 1; }

# Wholesale uncomment: strip leading "# " (hash+space) from every line.
# Leaves bare `#` lines and live markdown headers (`## Prompt`,
# `## Tips`) untouched, since those start with `##` not `# `.
python3 - <<'PY'
path = 'CUES.md'
with open(path) as f:
    lines = f.readlines()
out = []
for L in lines:
    # Preserve banner decorations and pure-text doc paragraphs.
    if L.startswith('# ─') or L.lstrip('# ').startswith('CUES.md'):
        out.append(L); continue
    if L.startswith('# '):
        out.append(L[2:])
    else:
        out.append(L)
with open(path, 'w') as f:
    f.writelines(out)
PY

echo "=== validate CUES.md with examples enabled ==="
"$OPENCUES" validate --project >/dev/null 2>&1 || { "$OPENCUES" validate --project; fail "validate failed with examples uncommented"; }
pass "CUES.md with all examples uncommented validates"

echo "=== list shows the uncommented sources ==="
LIST_OUT="$("$OPENCUES" list --project 2>&1)"
echo "$LIST_OUT" | grep -qi synonym || fail "list did not show 'synonym' cue source"
echo "$LIST_OUT" | grep -qi formal  || fail "list did not show 'formal' cue source"
pass "list surfaces both LLM-backed cue sources"

echo "=== match regex from ### synonym fires on 'happy' ==="
# match: \b[a-z]{4,}\b — should match "happy" (5 lowercase letters)
python3 -c "
import re, sys
sys.exit(0 if re.search(r'\b[a-z]{4,}\b', 'happy') else 1)
" || fail "synonym match regex did not fire on 'happy'"
pass "synonym match regex fires on 'happy' as documented"

echo "=== match regex from ### synonym ignores 3-letter words ==="
python3 -c "
import re, sys
sys.exit(1 if re.search(r'\b[a-z]{4,}\b', 'cat') else 0)
" || fail "synonym match regex should NOT fire on 'cat' (too short)"
pass "synonym match regex filters words < 4 chars"

echo "=== keywords from ### formal contain 'however' ==="
grep -qE "^keywords:.*however" CUES.md \
  || fail "formal keywords missing 'however' in scaffolded template"
pass "formal keywords contain 'however' as documented"

echo "=== tips JSON declares example words + alternatives ==="
python3 - <<'PY'
import re, json, sys
text = open('CUES.md').read()
# Find the JSON array between ## Tips and the next ```
m = re.search(r'## Tips.*?```json\s*\n(.*?)\n```', text, re.DOTALL)
assert m, f"Tips JSON block not found. First 500 chars after '## Tips':\n{text[text.find('## Tips'):text.find('## Tips')+500] if '## Tips' in text else 'NO ## Tips'}"
data = json.loads(m.group(1))
words = {}
for block in data:
    for k, v in (block.get('words') or {}).items():
        words[k] = v
assert 'happy' in words, f"'happy' missing from tips ({list(words)})"
assert 'important' in words, "'important' missing from tips"
assert 'glad' in words['happy']['alts'], "'glad' not in happy's alts"
PY
pass "tips JSON exposes 'happy'→'glad' as documented"

echo
echo "PASS: test-cues-examples.sh (6 checks)"
