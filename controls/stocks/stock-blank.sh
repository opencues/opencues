#!/bin/bash
# Stock price for control-bound blanks
# Usage: stock-blank.sh get <keyword>
#        stock-blank.sh set (no-op)

COMMAND="$1"
KEYWORD="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TICKERS_FILE="${SCRIPT_DIR}/tickers.json"
CACHE_MAX_AGE=60

case "$COMMAND" in
  get)
    # Resolve keyword to ticker symbol via tickers.json
    if [ -z "$KEYWORD" ]; then
      exit 0
    fi
    KW_LOWER=$(echo "$KEYWORD" | tr '[:upper:]' '[:lower:]')
    SYMBOL=$(jq -r --arg kw "$KW_LOWER" '.[$kw] // empty' "$TICKERS_FILE" 2>/dev/null)
    if [ -z "$SYMBOL" ]; then
      # Try keyword as ticker directly (uppercase)
      SYMBOL=$(echo "$KEYWORD" | tr '[:lower:]' '[:upper:]')
    fi

    CACHE_FILE="/tmp/ccline/stock_${SYMBOL}.json"

    # Check cache first (shared with ClaudeLog statusline)
    if [ -f "$CACHE_FILE" ]; then
      CACHE_AGE=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
      if [ "$CACHE_AGE" -lt "$CACHE_MAX_AGE" ]; then
        PRICE=$(jq -r '.c // empty' "$CACHE_FILE" 2>/dev/null)
        if [ -n "$PRICE" ] && [ "$PRICE" != "null" ] && [ "$PRICE" != "0" ]; then
          echo "$PRICE"
          exit 0
        fi
      fi
    fi

    # Fetch from Finnhub API
    API_KEY="${FINNHUB_API_KEY:-}"
    if [ -z "$API_KEY" ]; then
      exit 0
    fi

    RESPONSE=$(curl -s --max-time 5 \
      -H "X-Finnhub-Token: $API_KEY" \
      "https://finnhub.io/api/v1/quote?symbol=$SYMBOL" 2>/dev/null)

    PRICE=$(echo "$RESPONSE" | jq -r '.c // empty' 2>/dev/null)
    if [ -n "$PRICE" ] && [ "$PRICE" != "null" ] && [ "$PRICE" != "0" ]; then
      mkdir -p /tmp/ccline
      echo "$RESPONSE" > "$CACHE_FILE"
      echo "$PRICE"
    fi
    ;;
  set)
    # Read-only control — stock prices cannot be set
    exit 0
    ;;
esac
