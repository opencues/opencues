#!/bin/bash
# Hacker News posts for control-bound blanks
# Usage: hn-blank.sh get [keyword] [context words...]
#        hn-blank.sh set (no-op)
#
# Returns multiple lines (one per post title) — ControlBlankSource
# treats multi-line responses as a dynamic list control.

COMMAND="$1"
CACHE_DIR="/tmp/opencues-hn"
CACHE_FILE="${CACHE_DIR}/frontpage.txt"
CACHE_MAX_AGE=300  # 5 minutes

case "$COMMAND" in
  get)
    mkdir -p "$CACHE_DIR"

    # Check cache
    if [ -f "$CACHE_FILE" ]; then
      CACHE_AGE=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
      if [ "$CACHE_AGE" -lt "$CACHE_MAX_AGE" ]; then
        cat "$CACHE_FILE"
        exit 0
      fi
    fi

    # Fetch from hnrss.org RSS feed
    RSS=$(curl -s --max-time 5 "https://hnrss.org/frontpage?count=20" 2>/dev/null)

    if [ -z "$RSS" ]; then
      # Fall back to cache
      [ -f "$CACHE_FILE" ] && cat "$CACHE_FILE"
      exit 0
    fi

    # Extract titles from RSS XML (one per line)
    TITLES=$(echo "$RSS" | python3 -c "
import sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.stdin).getroot()
    for item in root.findall('.//item/title'):
        if item.text:
            print(item.text.strip())
except:
    pass
" 2>/dev/null)

    if [ -n "$TITLES" ]; then
      echo "$TITLES" > "$CACHE_FILE"
      echo "$TITLES"
    else
      [ -f "$CACHE_FILE" ] && cat "$CACHE_FILE"
    fi
    ;;
  set)
    exit 0
    ;;
esac
