#!/bin/bash
# Volume control
# Priority: VolCtl.exe (WSL, ~90ms, shows OSD) > nircmd > VBScript fallback
# Usage: volume.sh <up|down> <percent>

DIRECTION="$1"
AMOUNT="${2:-5}"
STATE_FILE="/tmp/cue-action-volume.txt"

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

# Apply
if [ -f "${HOME}/.claude/actions/VolCtl.exe" ]; then
  # Compiled .exe using SendInput — simulates volume keys, shows Windows OSD
  "${HOME}/.claude/actions/VolCtl.exe" "$DIRECTION" "$AMOUNT" &
elif [[ -f /mnt/c/Windows/nircmd.exe ]]; then
  case "$DIRECTION" in
    up)   /mnt/c/Windows/nircmd.exe changesysvolume $((AMOUNT * 655)) & ;;
    down) /mnt/c/Windows/nircmd.exe changesysvolume -$((AMOUNT * 655)) & ;;
  esac
else
  PRESSES=$((AMOUNT / 2))
  [[ $PRESSES -lt 1 ]] && PRESSES=1
  case "$DIRECTION" in
    up)   for ((i=0; i<PRESSES; i++)); do wscript.exe //nologo "C:\\Windows\\Temp\\volup.vbs" & done ;;
    down) for ((i=0; i<PRESSES; i++)); do wscript.exe //nologo "C:\\Windows\\Temp\\voldown.vbs" & done ;;
  esac
fi
