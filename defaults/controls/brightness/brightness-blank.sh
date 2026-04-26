#!/bin/bash
# Brightness control for control-bound blanks (e.g. "brightness ___")
# Usage: brightness-blank.sh <get|set> [value]
#
# Helpers (BrightCtl.exe, brightness-set.ps1) are colocated in this same
# directory. See brightness.sh for layout rationale.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION="$1"
VALUE="${2:-50}"

BRIGHT_CTL="${SCRIPT_DIR}/BrightCtl.exe"
BRIGHT_SET_PS1="${SCRIPT_DIR}/brightness-set.ps1"

case "$DIRECTION" in
  get)
    if [ -f "$BRIGHT_CTL" ]; then
      ACTUAL=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
      if [ "$ACTUAL" = "0" ] || [ -z "$ACTUAL" ]; then
        sleep 0.1
        ACTUAL=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
      fi
      [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && exit 0
    fi
    if command -v brightnessctl &>/dev/null; then
      RAW=$(brightnessctl get 2>/dev/null)
      MAX=$(brightnessctl max 2>/dev/null)
      [ -n "$RAW" ] && [ -n "$MAX" ] && [ "$MAX" -gt 0 ] && echo $((RAW * 100 / MAX)) && exit 0
    fi
    if [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
      ACTUAL=$(powershell.exe -NoProfile -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness" 2>/dev/null | tr -dc '0-9')
      [ -n "$ACTUAL" ] && echo "$ACTUAL" && exit 0
    fi
    echo "50"
    ;;
  set)
    [ "$VALUE" -gt 100 ] 2>/dev/null && VALUE=100
    [ "$VALUE" -lt 0 ] 2>/dev/null && VALUE=0
    if [ -f "$BRIGHT_CTL" ]; then
      "$BRIGHT_CTL" set "$VALUE"
    elif command -v brightnessctl &>/dev/null; then
      brightnessctl set "${VALUE}%"
    elif [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ] && [ -f "$BRIGHT_SET_PS1" ]; then
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$BRIGHT_SET_PS1" "$VALUE"
    fi
    ;;
  *)
    exit 1
    ;;
esac
