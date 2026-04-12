#!/usr/bin/env bash
# answer-blank.sh — Factual answer / translation / definition lookup
#
# Usage: answer-blank.sh get <matched-keyword> [context words...]
#
# Examples:
#   answer-blank.sh get "word for" love in Japanese    → "Aishiteru"
#   answer-blank.sh get "define" ephemeral              → "lasting a very short time"
#   answer-blank.sh get "translate" hello to French     → "Bonjour"
#   answer-blank.sh get "what is" the capital of Japan  → "Tokyo"
#
# Returns multiple lines (one answer per line) for cycling.
#
# Config via environment:
#   CUES_MODEL       — LLM model (default: openai/gpt-oss-120b)
#   CUES_API_URL     — API endpoint (default: Groq)
#   CUES_API_KEY_ENV — env var for API key (default: GROQ_API_KEY)

set -euo pipefail

cmd="${1:-get}"
keyword="${2:-}"
shift 2 2>/dev/null || true

context="$*"

if [[ "$cmd" != "get" ]] || [[ -z "$context" ]]; then
  exit 1
fi

# --- Config ---
MODEL="${CUES_MODEL:-openai/gpt-oss-120b}"
API_URL="${CUES_API_URL:-https://api.groq.com/openai/v1/chat/completions}"
API_KEY_ENV="${CUES_API_KEY_ENV:-GROQ_API_KEY}"
API_KEY="${!API_KEY_ENV:-}"

USE_CLAUDE_CLI=false
if [[ "$MODEL" == claude-* ]]; then
  USE_CLAUDE_CLI=true
fi

if [[ "$USE_CLAUDE_CLI" == false ]] && [[ -z "$API_KEY" ]]; then
  exit 1
fi

# --- LLM call ---
llm_call() {
  local system_msg="$1"
  local user_msg="$2"

  if [[ "$USE_CLAUDE_CLI" == true ]]; then
    timeout 10 claude --model "$MODEL" --system-prompt "$system_msg" -p "$user_msg" --no-session-persistence < /dev/null 2>/dev/null
  else
    system_msg=$(printf '%s' "$system_msg" | jq -Rs .)
    user_msg=$(printf '%s' "$user_msg" | jq -Rs .)
    curl -sf --max-time 8 "$API_URL" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{
        \"model\": \"$MODEL\",
        \"messages\": [
          {\"role\": \"system\", \"content\": $system_msg},
          {\"role\": \"user\", \"content\": $user_msg}
        ],
        \"temperature\": 0.3,
        \"max_tokens\": 512
      }" | jq -r '(.choices[0].message.content // "") as $c | if $c != "" then $c else (.choices[0].message.reasoning // empty) end'
  fi
}

# --- Build query from keyword + context ---
query="$keyword $context"

system="You answer factual questions, translate words, and define terms.
Return ONLY the answer — no explanation, no quotes, no punctuation.
For translations, return the word/phrase in the target language.
For definitions, return a concise definition (under 8 words).
For factual questions, return the direct answer.
Return 3 alternatives, one per line. Best answer first.

Examples:
  Q: word for love in Japanese → Ai
Aishiteru
Koi
  Q: define ephemeral → lasting a very short time
short-lived
transient
  Q: what is the capital of Japan → Tokyo
Tōkyō
東京
  Q: translate hello to French → Bonjour
Salut
Coucou
  Q: how to say thank you in Korean → Gamsahamnida
Gomawo
감사합니다"

result=$(llm_call "$system" "Q: $query")

if [[ -z "$result" ]]; then
  exit 1
fi

# Output each line as an alternative (for cycling)
echo "$result"
