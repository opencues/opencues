#!/bin/bash
# Volume control (word-based cue-control)
# Usage: volume.sh <get|up|down> [percent]
#
# Sync pitfalls (hard-won):
# 1. Do NOT background VolCtl.exe with &. The integration calls `get` 200ms after
#    spawning this script. If VolCtl.exe runs detached, it may still be applying
#    the change when `get` fires — reads stale value.
# 2. Do NOT call get_volume() before up/down. VolCtl.exe get costs ~200ms (WSL
#    .NET startup). That pushes the total script time past the 200ms read timer,
#    causing the same race. get_volume() is only needed for the `get` case.
# 3. VolCtl.exe up/down uses SendInput (key press queue), which is async. A
#    Thread.Sleep(150) inside VolCtl.exe waits for Windows to process the events
#    before the process exits — keeping everything within the 200ms window.

DIRECTION="$1"
AMOUNT="${2:-5}"

# Live read: query actual system volume
# Retries once on 0/empty — VolCtl.exe can return 0 on first call (COM init delay)
get_volume() {
  if [ -f "${HOME}/.claude/actions/VolCtl.exe" ]; then
    ACTUAL=$("${HOME}/.claude/actions/VolCtl.exe" get 2>/dev/null | tr -dc '0-9')
    if [ -z "$ACTUAL" ] || [ "$ACTUAL" = "0" ]; then
      sleep 0.1
      ACTUAL=$("${HOME}/.claude/actions/VolCtl.exe" get 2>/dev/null | tr -dc '0-9')
    fi
    [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && return
  fi
  echo "50"
}

case "$DIRECTION" in
  get)
    echo "volume: $(get_volume)%"
    exit 0
    ;;
esac

# Apply via key presses (fast, shows Windows OSD)
if [ -f "${HOME}/.claude/actions/VolCtl.exe" ]; then
  "${HOME}/.claude/actions/VolCtl.exe" "$DIRECTION" "$AMOUNT"
elif [[ -f /mnt/c/Windows/nircmd.exe ]]; then
  case "$DIRECTION" in
    up)   /mnt/c/Windows/nircmd.exe changesysvolume $((AMOUNT * 655)) ;;
    down) /mnt/c/Windows/nircmd.exe changesysvolume -$((AMOUNT * 655)) ;;
  esac
fi
