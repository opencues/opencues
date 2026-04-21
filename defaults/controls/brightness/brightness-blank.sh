#!/bin/bash
# Brightness control for control-bound blanks
# Usage: brightness-blank.sh <get|set> [value]

DIRECTION="$1"
VALUE="${2:-50}"

case "$DIRECTION" in
  get)
    # Query actual system brightness
    if [ -f "${HOME}/.claude/actions/BrightCtl.exe" ]; then
      ACTUAL=$("${HOME}/.claude/actions/BrightCtl.exe" get 2>/dev/null | tr -dc '0-9')
      if [ "$ACTUAL" = "0" ] || [ -z "$ACTUAL" ]; then
        sleep 0.1
        ACTUAL=$("${HOME}/.claude/actions/BrightCtl.exe" get 2>/dev/null | tr -dc '0-9')
      fi
      [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && exit 0
    fi
    if command -v brightnessctl &>/dev/null; then
      RAW=$(brightnessctl get 2>/dev/null)
      MAX=$(brightnessctl max 2>/dev/null)
      [ -n "$RAW" ] && [ -n "$MAX" ] && [ "$MAX" -gt 0 ] && echo $((RAW * 100 / MAX)) && exit 0
    fi
    echo "50"
    ;;
  set)
    # Set exact brightness
    [ "$VALUE" -gt 100 ] 2>/dev/null && VALUE=100
    [ "$VALUE" -lt 0 ] 2>/dev/null && VALUE=0
    if [ -f "${HOME}/.claude/actions/BrightCtl.exe" ]; then
      "${HOME}/.claude/actions/BrightCtl.exe" set "$VALUE"
    elif command -v brightnessctl &>/dev/null; then
      brightnessctl set "${VALUE}%"
    elif [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${HOME}/.claude/actions/brightness-set.ps1" "$VALUE"
    fi
    ;;
  *)
    exit 1
    ;;
esac
