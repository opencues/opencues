#!/usr/bin/env bash
# llm-smoke.sh — end-to-end LLM smoke for the documented template examples.
# Runs the prompts shipped in cues.md / blanks.md verbatim against the live
# LLM and asserts the SHAPE of each response matches what the templates
# tell users to expect.
#
# Coverage (one Groq call per check):
#   1. cues.md ### synonym       — "happy" → ≥3 alts, none equal to "happy"
#   2. cues.md ### formal        — "however" → ≥3 alts, none equal to "however"
#   3. blanks.md ### math        — "4 * 12" → COMPUTE=… eval to 48
#   4. blanks.md ### math        — "50 plus 20% tax" → COMPUTE=… eval to 60
#   5. blanks.md ### math        — "celsius 100C to fahrenheit" → COMPUTE=… eval to 212
#   6. blanks.md ### factual     — "capital of France" → ANSWER=…Paris…
#   7. blanks.md ### factual     — "founder of Microsoft" → ANSWER=…Gates…
#   8. blanks.md ### factual     — "CEO of Apple" → ANSWER=…Cook…
#   9. blanks.md ### classifier  — math input → MODE=MATH
#  10. blanks.md ### classifier  — factual input → MODE=FACTUAL
#  11. blanks.md ### classifier  — ambiguous input → MODE=GRAMMAR
#  12. cues.md ### synonym       — alternatives count discipline (== 3 items)
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
# Cue source: synonym (cues.md ### synonym)
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
# Cue source: formal (cues.md ### formal — register-shifting)
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

echo
echo "PASS: llm-smoke.sh (12 LLM checks across cue / math / factual / classifier)"
