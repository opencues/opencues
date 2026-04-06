#!/bin/bash
# Brightness control
# Priority: brightnessctl (Linux) > BrightCtl.exe (WSL, ~130ms, shows OSD) > PowerShell fallback
# Usage: brightness.sh <up|down> <percent>

DIRECTION="$1"
AMOUNT="${2:-10}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/state.txt"

# Read cached value (instant)
[ -f "$STATE_FILE" ] && CURRENT=$(tr -dc '0-9' < "$STATE_FILE")

# First run: seed from system
if [ -z "$CURRENT" ]; then
  if command -v brightnessctl &>/dev/null; then
    RAW=$(brightnessctl get 2>/dev/null)
    MAX=$(brightnessctl max 2>/dev/null)
    [ -n "$RAW" ] && [ -n "$MAX" ] && [ "$MAX" -gt 0 ] && CURRENT=$((RAW * 100 / MAX))
  elif [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
    CURRENT=$(powershell.exe -NoProfile -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness" 2>/dev/null | tr -dc '0-9')
  fi
fi
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
if command -v brightnessctl &>/dev/null; then
  brightnessctl set "${NEW}%" &
elif [ -f "${HOME}/.claude/actions/BrightCtl.exe" ]; then
  # Compiled .exe using powrprof.dll — ~130ms, triggers Windows OSD
  "${HOME}/.claude/actions/BrightCtl.exe" "$NEW" &
elif [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  # PowerShell fallback — ~1.5s
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${HOME}/.claude/actions/brightness-set.ps1" "$NEW" &
fi
