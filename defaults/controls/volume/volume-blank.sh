#!/bin/bash
# Volume control for control-bound blanks (e.g. "volume ___")
# Usage: volume-blank.sh <get|set> [value]
#
# VolCtl.exe is colocated in this same directory (see volume.sh header).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION="$1"
VALUE="${2:-50}"

VOL_CTL="${SCRIPT_DIR}/VolCtl.exe"

case "$DIRECTION" in
  get)
    if [ -f "$VOL_CTL" ]; then
      ACTUAL=$("$VOL_CTL" get 2>/dev/null | tr -dc '0-9')
      if [ "$ACTUAL" = "0" ] || [ -z "$ACTUAL" ]; then
        sleep 0.1
        ACTUAL=$("$VOL_CTL" get 2>/dev/null | tr -dc '0-9')
      fi
      [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && exit 0
    fi
    echo "50"
    ;;
  set)
    [ "$VALUE" -gt 100 ] 2>/dev/null && VALUE=100
    [ "$VALUE" -lt 0 ] 2>/dev/null && VALUE=0
    if [ -f "$VOL_CTL" ]; then
      "$VOL_CTL" set "$VALUE"
    elif [ -f /mnt/c/Windows/nircmd.exe ]; then
      /mnt/c/Windows/nircmd.exe setsysvolume $((VALUE * 655))
    fi
    ;;
  *)
    exit 1
    ;;
esac
