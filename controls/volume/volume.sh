#!/bin/bash
# Volume control (word-based cue-control)
# Usage: volume.sh <up|down> <percent>

DIRECTION="$1"
AMOUNT="${2:-5}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/state.txt"

# Read cached value (instant); default 50 if no prior state
[ -f "$STATE_FILE" ] && CURRENT=$(tr -dc '0-9' < "$STATE_FILE")
CURRENT=${CURRENT:-50}

# Calculate
case "$DIRECTION" in
  up)   NEW=$((CURRENT + AMOUNT)); [ "$NEW" -gt 100 ] && NEW=100 ;;
  down) NEW=$((CURRENT - AMOUNT)); [ "$NEW" -lt 0 ] && NEW=0 ;;
  *)    exit 1 ;;
esac

# Write cache immediately
echo "$NEW" > "$STATE_FILE"

# Apply via key presses (fast, shows Windows OSD)
if [ -f "${HOME}/.claude/actions/VolCtl.exe" ]; then
  "${HOME}/.claude/actions/VolCtl.exe" "$DIRECTION" "$AMOUNT" &
elif [[ -f /mnt/c/Windows/nircmd.exe ]]; then
  case "$DIRECTION" in
    up)   /mnt/c/Windows/nircmd.exe changesysvolume $((AMOUNT * 655)) & ;;
    down) /mnt/c/Windows/nircmd.exe changesysvolume -$((AMOUNT * 655)) & ;;
  esac
fi
