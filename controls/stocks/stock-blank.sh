#!/bin/bash
# Stock price for control-bound blanks
# Usage: stock-blank.sh get <keyword>
#        stock-blank.sh set (no-op — read-only control)

COMMAND="$1"
KEYWORD="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TICKERS_FILE="${SCRIPT_DIR}/tickers.json"

case "$COMMAND" in
  get)
    if [ -z "$KEYWORD" ]; then
      exit 0
    fi

    # Resolve keyword to ticker symbol via tickers.json
    KW_LOWER=$(echo "$KEYWORD" | tr '[:upper:]' '[:lower:]')
    SYMBOL=$(jq -r --arg kw "$KW_LOWER" '.[$kw] // empty' "$TICKERS_FILE" 2>/dev/null)
    if [ -z "$SYMBOL" ]; then
      # Try keyword as ticker directly (uppercase)
      SYMBOL=$(echo "$KEYWORD" | tr '[:lower:]' '[:upper:]')
    fi

    # Fetch live from Finnhub API
    API_KEY="${FINNHUB_API_KEY:-}"
    if [ -z "$API_KEY" ]; then
      exit 0
    fi

    RESPONSE=$(curl -s --max-time 5 \
      -H "X-Finnhub-Token: $API_KEY" \
      "https://finnhub.io/api/v1/quote?symbol=$SYMBOL" 2>/dev/null)

    PRICE=$(echo "$RESPONSE" | jq -r '.c // empty' 2>/dev/null)
    if [ -n "$PRICE" ] && [ "$PRICE" != "null" ] && [ "$PRICE" != "0" ]; then
      echo "\$$PRICE"
    fi
    ;;
  set)
    # Read-only control — stock prices cannot be set
    exit 0
    ;;
esac
