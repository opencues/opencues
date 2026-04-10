#!/usr/bin/env bash
# prompt-blank.sh — Two-step LLM prompt transformer
#
# Usage: prompt-blank.sh get <matched-keyword> [context words...]
#
# All config received via environment variables (set by the integration from cue.md):
#   CUES_MODEL          — LLM model identifier
#   CUES_API_URL        — API endpoint URL
#   CUES_API_KEY_ENV    — env var name holding the API key
#   CUES_ALT_COUNT      — number of alternatives to return
#   CUES_INCLUDE_ORIGINAL — include original prompt as last alt (true/false)
#   CUES_PROMPT_EXTRACT   — system prompt for extraction step
#   CUES_PROMPT_TRANSFORM — system prompt for transformation step

set -euo pipefail

cmd="${1:-get}"
keyword="${2:-}"
shift 2 2>/dev/null || true

context="$*"

if [[ "$cmd" != "get" ]] || [[ -z "$context" ]]; then
  exit 1
fi

# --- Config from env vars (defaults match Groq + openai/gpt-oss-120b) ---
MODEL="${CUES_MODEL:-openai/gpt-oss-120b}"
API_URL="${CUES_API_URL:-https://api.groq.com/openai/v1/chat/completions}"
API_KEY_ENV="${CUES_API_KEY_ENV:-GROQ_API_KEY}"
API_KEY="${!API_KEY_ENV:-}"
ALT_COUNT="${CUES_ALT_COUNT:-3}"
INCLUDE_ORIGINAL="${CUES_INCLUDE_ORIGINAL:-true}"

extract_system="${CUES_PROMPT_EXTRACT:-}"
transform_system="${CUES_PROMPT_TRANSFORM:-}"

# Detect provider from model name: claude-* uses the Claude Code CLI, everything else uses HTTP API
USE_CLAUDE_CLI=false
if [[ "$MODEL" == claude-* ]]; then
  USE_CLAUDE_CLI=true
fi

if [[ "$USE_CLAUDE_CLI" == false ]] && [[ -z "$API_KEY" ]]; then
  echo "Set $API_KEY_ENV"
  exit 1
fi

if [[ -z "$extract_system" ]] || [[ -z "$transform_system" ]]; then
  echo "Missing CUES_PROMPT_EXTRACT or CUES_PROMPT_TRANSFORM"
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
    curl -sf --max-time 4 "$API_URL" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{
        \"model\": \"$MODEL\",
        \"messages\": [
          {\"role\": \"system\", \"content\": $system_msg},
          {\"role\": \"user\", \"content\": $user_msg}
        ],
        \"temperature\": 0.7,
        \"max_tokens\": 512
      }" | jq -r '.choices[0].message.content // empty'
  fi
}

# --- Step 1: Extract prompt and conditions ---
extract_result=$(llm_call "$extract_system" "$context")

# Strip markdown code fences (Claude wraps JSON in ```json ... ```)
extract_json=$(printf '%s' "$extract_result" | sed 's/^```[a-z]*//;s/^```//' | sed '/^```/d')

prompt=$(printf '%s' "$extract_json" | jq -r '.prompt // empty' 2>/dev/null || true)
conditions=$(printf '%s' "$extract_json" | jq -r '.conditions // empty' 2>/dev/null || true)

# Fallback: if extraction failed, use entire context minus keyword
if [[ -z "$prompt" ]]; then
  prompt=$(printf '%s' "$context" | sed -E "s/$keyword//gi" | xargs)
  conditions=""
fi

# --- Step 2: Transform the prompt ---
transform_input="Prompt: $prompt"
if [[ -n "$conditions" ]]; then
  transform_input="$transform_input
Conditions: $conditions"
fi

result=$(llm_call "$transform_system" "$transform_input")

if [[ -z "$result" ]]; then
  echo "$prompt"
  exit 0
fi

# Post-process: strip numbering/bullets, remove blank lines, take altCount
cleaned=$(printf '%s\n' "$result" | sed 's/^[0-9]*[.)]\s*//' | sed 's/^[-*]\s*//' | sed '/^\s*$/d' | head -"$ALT_COUNT")
line_count=$(printf '%s\n' "$cleaned" | wc -l)

if [[ "$line_count" -lt 2 ]]; then
  echo "$prompt"
  exit 0
fi

# Output: transformed versions, then optionally the original prompt
printf '%s\n' "$cleaned"
if [[ "$INCLUDE_ORIGINAL" == "true" ]]; then
  echo "$prompt"
fi
