#!/bin/bash
# Volume control - optimized for speed using VBScript
# Usage: volume.sh <up|down> <percent>

DIRECTION="$1"
AMOUNT="${2:-5}"
PRESSES=$((AMOUNT / 2))
[[ $PRESSES -lt 1 ]] && PRESSES=1

case "$DIRECTION" in
  up)
    if [[ -f /mnt/c/Windows/nircmd.exe ]]; then
      /mnt/c/Windows/nircmd.exe changesysvolume $((AMOUNT * 655)) &
    else
      for ((i=0; i<PRESSES; i++)); do
        wscript.exe //nologo "C:\\Windows\\Temp\\volup.vbs" &
      done
    fi
    ;;
  down)
    if [[ -f /mnt/c/Windows/nircmd.exe ]]; then
      /mnt/c/Windows/nircmd.exe changesysvolume -$((AMOUNT * 655)) &
    else
      for ((i=0; i<PRESSES; i++)); do
        wscript.exe //nologo "C:\\Windows\\Temp\\voldown.vbs" &
      done
    fi
    ;;
esac
