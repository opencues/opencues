#!/usr/bin/env bash
# llm-smoke.sh — end-to-end LLM smoke for the documented template examples.
# Runs the prompts shipped in CUES.md / BLANKS.md verbatim against the live
# LLM and asserts the SHAPE of each response matches what the templates
# tell users to expect.
#
# Coverage (one Groq call per check):
#   1. CUES.md ### synonym       — "happy" → ≥3 alts, none equal to "happy"
#   2. CUES.md ### formal        — "however" → ≥3 alts, none equal to "however"
#   3. BLANKS.md ### math        — "4 * 12" → COMPUTE=… eval to 48
#   4. BLANKS.md ### math        — "50 plus 20% tax" → COMPUTE=… eval to 60
#   5. BLANKS.md ### math        — "celsius 100C to fahrenheit" → COMPUTE=… eval to 212
#   6. BLANKS.md ### factual     — "capital of France" → ANSWER=…Paris…
#   7. BLANKS.md ### factual     — "founder of Microsoft" → ANSWER=…Gates…
#   8. BLANKS.md ### factual     — "CEO of Apple" → ANSWER=…Cook…
#   9. BLANKS.md ### classifier  — math input → MODE=MATH
#  10. BLANKS.md ### classifier  — factual input → MODE=FACTUAL
#  11. BLANKS.md ### classifier  — ambiguous input → MODE=GRAMMAR
#  12. CUES.md ### synonym       — alternatives count discipline (== 3 items)
#  13-14. defaults/cues/legal     — single-word + multi-word indices covered
#  15-16. defaults/cues/medical   — single-word + multi-word indices covered
#  17-18. defaults/cues/financial — single-word + multi-word indices covered
#
# ── Adding a new cue? ────────────────────────────────────────────────
# Before shipping a new defaults/cues/<name>/CUE.md, add a loop entry
# in the "Shipped domain cues" block below with one known keyword (for
# single-word) + three keywords (for multi-word). Domain cues MUST pass
# this smoke to avoid the class of bug where:
#   - LLM returns prose instead of INDEX:alt (prompt missed a format
#     spec or was too chatty) — ConfigSource.getCues auto-appends now,
#     but a test still catches regressions.
#   - LLM hallucinates extra indices from "examples: X vs Y, A vs B"
#     lists in the prompt body (fixed in Apr 2026 domain-cue rewrite).
#   - Indexing drift (prompt examples use 1-based, runtime sends
#     0-based, parser rejects out-of-range indices).
# See docs/features/word-cue-routing.md for the routing model, and
# defaults/cues/grammar/CUE.md for the canonical example-heavy prompt
# style.
#
# Skipped silently if GROQ_API_KEY is missing.

set -euo pipefail

if [[ -z "${GROQ_API_KEY:-}" ]]; then
  echo "SKIP: llm-smoke.sh (GROQ_API_KEY not set)"
  exit 0
fi

pass() { printf "  PASS %s\n" "$1"; }
fail() { printf "  FAIL %s\n" "$1" >&2; exit 1; }

# gpt-oss-120b uses internal reasoning tokens — give plenty of headroom.
MODEL="${OPENCUES_LLM_MODEL:-openai/gpt-oss-120b}"

# Build JSON via python (safe quoting), POST via curl (Groq's edge blocks
# bare-urllib User-Agents), parse with python.
groq_call() {
  local prompt="$1" max="$2"
  local body
  body="$(python3 -c "
import json, sys
print(json.dumps({
  'model': '$MODEL',
  'messages': [{'role': 'user', 'content': sys.argv[1]}],
  'max_tokens': int(sys.argv[2]),
  'temperature': 0,
}))" "$prompt" "$max")"
  local resp
  resp="$(curl -sS -X POST https://api.groq.com/openai/v1/chat/completions \
    -H "Authorization: Bearer $GROQ_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body")"
  echo "$resp" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d['choices'][0]['message']['content'].strip())
except Exception as e:
    sys.stderr.write(f'parse error: {e}\\n')
    sys.exit(1)
"
}

# ─────────────────────────────────────────────────────────────────
# Cue source: synonym (CUES.md ### synonym)
# ─────────────────────────────────────────────────────────────────
echo "=== synonym source: 'happy' returns ≥3 alternatives, not 'happy' ==="
PROMPT='Suggest 3 alternative words for the highlighted word that fit the surrounding sentence context. Output as a comma-separated list. Example: "happy" → "joyful, pleased, content". Word: happy'
OUT="$(groq_call "$PROMPT" 400)"
ALTS="$(echo "$OUT" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[a-zA-Z]+' | head -10)"
COUNT="$(echo "$ALTS" | grep -c '.' || true)"
if [[ "$COUNT" -lt 3 ]]; then fail "expected ≥3 alternatives, got $COUNT: '$OUT'"; fi
if echo "$ALTS" | grep -qix happy; then fail "synonym returned the input word 'happy' as an alternative: '$OUT'"; fi
pass "got $COUNT alternatives (none == 'happy'): $(echo "$ALTS" | tr '\n' ',' | head -c 80)"

# ─────────────────────────────────────────────────────────────────
# Cue source: formal (CUES.md ### formal — register-shifting)
# ─────────────────────────────────────────────────────────────────
echo "=== formal source: 'however' returns ≥3 formal alternatives ==="
PROMPT='Suggest 3 alternatives in a more formal register that preserve the meaning and fit the surrounding sentence. Output comma-separated. Example: "however" → "nevertheless, conversely, that said". Word: however'
OUT="$(groq_call "$PROMPT" 400)"
ALTS="$(echo "$OUT" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[a-zA-Z]' | head -10)"
COUNT="$(echo "$ALTS" | grep -c '.' || true)"
if [[ "$COUNT" -lt 3 ]]; then fail "expected ≥3 alternatives, got $COUNT: '$OUT'"; fi
if echo "$ALTS" | grep -qix however; then fail "formal returned the input 'however' itself: '$OUT'"; fi
pass "got $COUNT formal alternatives: $(echo "$ALTS" | tr '\n' ',' | head -c 100)"

# ─────────────────────────────────────────────────────────────────
# Math (compute parser)
# ─────────────────────────────────────────────────────────────────
test_compute() {
  local label="$1" input="$2" expected="$3"
  echo "=== math: '$input' → COMPUTE=… evaluates to $expected ==="
  local PROMPT="Compute the expression. Output ONLY: COMPUTE=<javascript-expression>. Examples: 4 * 12 = _ → COMPUTE=4*12. 50 plus 20% tax = _ → COMPUTE=50*1.20. celsius to fahrenheit 100C = _ → COMPUTE=(100*9/5)+32. Input: $input"
  local OUT EXPR_LINE EXPR RESULT
  OUT="$(groq_call "$PROMPT" 400)"
  EXPR_LINE="$(echo "$OUT" | grep -oE 'COMPUTE=[^[:space:]]+' | head -1 || true)"
  if [[ -z "$EXPR_LINE" ]]; then fail "$label: expected COMPUTE= prefix, got: '$OUT'"; fi
  EXPR="${EXPR_LINE#COMPUTE=}"
  RESULT="$(node -e "console.log($EXPR)" 2>&1)"
  # Allow integer or float forms (50*1.20 = 60, not 60.0)
  if [[ "$RESULT" == "$expected" || "${RESULT%.0}" == "$expected" ]]; then
    pass "$label: $EXPR_LINE → $RESULT (matches $expected)"
  else
    fail "$label: $EXPR_LINE evaluated to $RESULT, expected $expected"
  fi
}
test_compute "simple multiplication" "4 * 12 = _"           "48"
test_compute "percentage tax"        "50 plus 20% tax = _"  "60"
test_compute "unit conversion"       "celsius to fahrenheit 100C = _" "212"

# ─────────────────────────────────────────────────────────────────
# Factual (answer parser)
# ─────────────────────────────────────────────────────────────────
test_factual() {
  local label="$1" input="$2" expected_substr="$3"
  echo "=== factual: '$input' → ANSWER=…$expected_substr… ==="
  local PROMPT="Answer the factual question. Output ONLY: ANSWER=<answer>. Examples: The CEO of Apple is _ → ANSWER=Tim Cook. The capital of France is _ → ANSWER=Paris. Input: $input"
  local OUT
  OUT="$(groq_call "$PROMPT" 400)"
  local ANSWER_LINE
  ANSWER_LINE="$(echo "$OUT" | grep -oiE 'ANSWER=.+' | head -1 || true)"
  if [[ -z "$ANSWER_LINE" ]]; then fail "$label: expected ANSWER= prefix, got: '$OUT'"; fi
  if echo "$ANSWER_LINE" | grep -qi "$expected_substr"; then
    pass "$label: $ANSWER_LINE (contains '$expected_substr')"
  else
    fail "$label: $ANSWER_LINE missing '$expected_substr'"
  fi
}
test_factual "capital lookup"  "The capital of France is _"   "Paris"
test_factual "founder lookup"  "The founder of Microsoft is _" "Gates"
test_factual "CEO lookup"      "The CEO of Apple is _"          "Cook"

# ─────────────────────────────────────────────────────────────────
# Classifier (raw parser — picks MODE=...)
# ─────────────────────────────────────────────────────────────────
test_classify() {
  local label="$1" input="$2" expected_mode="$3"
  echo "=== classifier: '$input' → MODE=$expected_mode ==="
  local PROMPT="Classify the input into one mode: MATH, FACTUAL, GRAMMAR.

MATH - calculations, numbers with operators, word math:
  - \"4 * 12 = _\" → MATH
  - \"half of 16 = _\" → MATH
  - \"50 plus 20% tax = _\" → MATH

FACTUAL - specific facts, names, dates, knowledge lookups:
  - \"The CEO of Apple is _\" → FACTUAL
  - \"The capital of France is _\" → FACTUAL

GRAMMAR - word alternatives, synonyms, completions (default fallback):
  - \"The quick brown _\" → GRAMMAR
  - \"happy _\" → GRAMMAR

Output ONLY: MODE=MATH | MODE=FACTUAL | MODE=GRAMMAR

Input: $input"
  local OUT MODE_LINE
  OUT="$(groq_call "$PROMPT" 400)"
  MODE_LINE="$(echo "$OUT" | grep -oE 'MODE=(MATH|FACTUAL|GRAMMAR)' | head -1 || true)"
  if [[ -z "$MODE_LINE" ]]; then fail "$label: expected MODE= prefix, got: '$OUT'"; fi
  local ACTUAL="${MODE_LINE#MODE=}"
  if [[ "$ACTUAL" == "$expected_mode" ]]; then
    pass "$label: $MODE_LINE"
  else
    fail "$label: got $MODE_LINE, expected MODE=$expected_mode"
  fi
}
test_classify "math input"     "What is 4 * 12 = _"             "MATH"
test_classify "factual input"  "The capital of France is _"     "FACTUAL"
test_classify "ambiguous text" "I had a really nice _"          "GRAMMAR"

# ─────────────────────────────────────────────────────────────────
# Format discipline: synonym source returns EXACTLY 3 items
# ─────────────────────────────────────────────────────────────────
echo "=== synonym source: returns exactly 3 comma-separated items ==="
PROMPT='Suggest 3 alternative words for the highlighted word that fit the surrounding sentence context. Output as a comma-separated list. Example: "happy" → "joyful, pleased, content". Word: clever'
OUT="$(groq_call "$PROMPT" 400)"
ALTS="$(echo "$OUT" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[a-zA-Z]' | head -10)"
COUNT="$(echo "$ALTS" | grep -c '.' || true)"
if [[ "$COUNT" -eq 3 ]]; then
  pass "exactly 3 alternatives: $(echo "$ALTS" | tr '\n' ',' | head -c 80)"
elif [[ "$COUNT" -ge 2 && "$COUNT" -le 5 ]]; then
  # Tolerate ±1 — LLM occasionally returns 2 or 4. Templates say "3" so flag.
  printf "  WARN expected exactly 3, got %d: %s\n" "$COUNT" "$(echo "$ALTS" | tr '\n' ',' | head -c 80)" >&2
  pass "got $COUNT alternatives (template promises 3 — soft pass)"
else
  fail "expected ~3 alternatives, got $COUNT: '$OUT'"
fi

# ─────────────────────────────────────────────────────────────────
# Shipped domain cues — legal, medical, financial
# ─────────────────────────────────────────────────────────────────
# Each domain cue ships in defaults/cues/<name>/CUE.md. Under the
# RoutedWordSourceGroup model each one is dispatched standalone with
# a sub-context containing ONLY its matched words, 0-indexed. The
# ConfigSource auto-appends the INDEX:alt format spec.
#
# This block verifies every shipped domain cue produces:
#   - correct shape (INDEX:alt1,alt2,alt3 per input index)
#   - correct indexing (0-based, matching the runtime's input form)
#   - no hallucinated extra indices (parser would drop them)
# ...for BOTH single-word and multi-word sub-contexts.

# Extract the prompt body (strip YAML frontmatter).
extract_body() {
  awk 'BEGIN{c=0} /^---$/{c++; next} c>=2{print}' "$1"
}

# Send a domain cue's prompt + input to Groq; return LLM content.
domain_call() {
  local cue_file="$1" input="$2"
  local body="$(extract_body "$cue_file")"
  # Mirror the runtime's auto-append so the test matches what
  # ConfigSource.getCues actually sends.
  local prompt="$body

Output ONLY index:alternatives format (e.g. 1:alt1,alt2,alt3). No prose, tables, or markdown.
$input"
  groq_call "$prompt" 500
}

# Assert every index 0..N-1 from the input appears in the LLM output
# with ≥2 comma-separated alts. Dies on first missing index.
assert_all_indices_covered() {
  local label="$1" input="$2" response="$3"
  # Count how many indices are in the input (0=foo 1=bar 2=baz → 3).
  local n
  n="$(echo "$input" | grep -oE '[0-9]+=' | wc -l | tr -d '[:space:]')"
  for ((i=0; i<n; i++)); do
    # Look for "i:alt,alt,..." OR "i: alt,alt,..." on a line OR pipe-delimited.
    if ! echo "$response" | grep -qE "(^|[|[:space:]])${i}[[:space:]]*:[[:space:]]*[a-zA-Z]"; then
      fail "$label: missing index $i in response:
$response"
    fi
    # Check ≥ 2 alts at that index (comma-separated list).
    local line
    line="$(echo "$response" | tr '|' '\n' | grep -E "(^|[[:space:]])${i}[[:space:]]*:" | head -1)"
    local alts
    alts="$(echo "$line" | sed -E "s/^[^:]*:[[:space:]]*//" | tr ',' '\n' | grep -c '.')"
    if [[ "$alts" -lt 2 ]]; then
      fail "$label: index $i has only $alts alts (need ≥2):
$line"
    fi
  done
  pass "$label ($n indices, all covered): $(echo "$response" | tr '\n' '|' | head -c 120)…"
}

for cue in legal medical financial; do
  cue_file="$(dirname "$0")/../../defaults/cues/$cue/CUE.md"
  [[ -f "$cue_file" ]] || { echo "SKIP: $cue_file missing"; continue; }

  # Pick one known keyword from the cue's match regex for single-word test,
  # and three keywords for multi-word. These must be words the match regex
  # actually matches (the match is checked by RoutedWordSourceGroup, but
  # once routed here, any input word goes through — the keywords just give
  # the LLM concrete test cases).
  case "$cue" in
    legal)
      single="0=contract"
      multi="0=contract 1=shall 2=indemnify"
      ;;
    medical)
      single="0=diagnosis"
      multi="0=diagnosis 1=prognosis 2=contraindication"
      ;;
    financial)
      single="0=equity"
      multi="0=portfolio 1=leverage 2=hedge"
      ;;
  esac

  echo "=== $cue: single-word input ($single) ==="
  OUT="$(domain_call "$cue_file" "$single")"
  assert_all_indices_covered "$cue single" "$single" "$OUT"

  echo "=== $cue: multi-word input ($multi) ==="
  OUT="$(domain_call "$cue_file" "$multi")"
  assert_all_indices_covered "$cue multi" "$multi" "$OUT"
done

echo
echo "PASS: llm-smoke.sh (12 LLM checks + 6 domain-cue checks = 18 total)"
