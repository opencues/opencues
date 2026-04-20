#!/usr/bin/env bash
# llm-smoke.sh — optional end-to-end LLM smoke for the documented examples.
# Requires GROQ_API_KEY. Asserts SHAPE of LLM responses (non-empty,
# parseable), not specific content — those are covered by tests/benchmarks/.
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

# Single-call helper. Builds JSON via python (safe quoting), sends via
# curl (Groq's edge blocks bare-urllib User-Agents), parses with python.
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
    sys.stderr.write(f'parse error: {e}\\nraw: {sys.stdin.read()[:200]}\\n')
    sys.exit(1)
"
}

# ─── Test 1: synonym source returns alternatives ──────────────────
echo "=== synonym source: 'happy' returns >=2 alternatives ==="
PROMPT='Suggest 3 alternative words for the highlighted word that fit the surrounding sentence context. Output as a comma-separated list. Example: "happy" → "joyful, pleased, content". Word: glad'
OUT="$(groq_call "$PROMPT" 400)"
COUNT="$(echo "$OUT" | tr ',\n' '\n\n' | grep -c '[a-zA-Z]' || true)"
if [[ "$COUNT" -ge 2 ]]; then
  pass "got $COUNT alternatives: $(echo "$OUT" | tr '\n' ' ' | head -c 120)"
else
  fail "expected >=2 alternatives, got: '$OUT'"
fi

# ─── Test 2: math classifier returns COMPUTE= form ────────────────
echo "=== math: '4 * 12' returns COMPUTE=… that evaluates to 48 ==="
PROMPT='Compute the expression. Output ONLY: COMPUTE=<javascript-expression>. Examples: 4 * 12 = _ → COMPUTE=4*12. Input: 4 * 12 = _'
OUT="$(groq_call "$PROMPT" 400)"
EXPR_LINE="$(echo "$OUT" | grep -oE 'COMPUTE=[^[:space:]]+' | head -1 || true)"
if [[ -z "$EXPR_LINE" ]]; then
  fail "expected COMPUTE= prefix, got: '$OUT'"
fi
EXPR="${EXPR_LINE#COMPUTE=}"
RESULT="$(node -e "console.log($EXPR)")"
if [[ "$RESULT" == "48" ]]; then
  pass "$EXPR_LINE → $RESULT (matches documented 48)"
else
  fail "$EXPR_LINE evaluated to $RESULT, expected 48"
fi

# ─── Test 3: factual classifier returns ANSWER= form ──────────────
echo "=== factual: 'capital of France' returns ANSWER=…Paris… ==="
PROMPT='Answer the factual question. Output ONLY: ANSWER=<answer>. Examples: The capital of France is _ → ANSWER=Paris. Input: The capital of France is _'
OUT="$(groq_call "$PROMPT" 400)"
ANSWER_LINE="$(echo "$OUT" | grep -oiE 'ANSWER=[^[:space:]]+' | head -1 || true)"
if [[ -z "$ANSWER_LINE" ]]; then
  fail "expected ANSWER= prefix, got: '$OUT'"
fi
if echo "$ANSWER_LINE" | grep -qi 'paris'; then
  pass "$ANSWER_LINE (contains documented 'Paris')"
else
  fail "$ANSWER_LINE does not contain 'Paris'"
fi

echo
echo "PASS: llm-smoke.sh (3 LLM checks)"
