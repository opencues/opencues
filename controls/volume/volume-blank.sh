#!/bin/bash
# Volume control for control-bound blanks
# Usage: volume-blank.sh <get|set> [value]

DIRECTION="$1"
VALUE="${2:-50}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/state.txt"

case "$DIRECTION" in
  get)
    # Query actual system volume
    if [ -f "${HOME}/.claude/actions/VolCtl.exe" ]; then
      ACTUAL=$("${HOME}/.claude/actions/VolCtl.exe" get 2>/dev/null | tr -dc '0-9')
      if [ "$ACTUAL" = "0" ] || [ -z "$ACTUAL" ]; then
        sleep 0.1
        ACTUAL=$("${HOME}/.claude/actions/VolCtl.exe" get 2>/dev/null | tr -dc '0-9')
      fi
      [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && exit 0
    fi
    [ -f "$STATE_FILE" ] && cat "$STATE_FILE" && exit 0
    echo "50"
    ;;
  set)
    # Set exact volume
    [ "$VALUE" -gt 100 ] 2>/dev/null && VALUE=100
    [ "$VALUE" -lt 0 ] 2>/dev/null && VALUE=0
    echo "$VALUE" > "$STATE_FILE"
    if [ -f "${HOME}/.claude/actions/VolCtl.exe" ]; then
      "${HOME}/.claude/actions/VolCtl.exe" set "$VALUE"
    elif [[ -f /mnt/c/Windows/nircmd.exe ]]; then
      /mnt/c/Windows/nircmd.exe setsysvolume $((VALUE * 655))
    fi
    ;;
  *)
    exit 1
    ;;
esac
