#!/bin/bash
# Brightness control
# Priority: BrightCtl.exe (WSL, ~194ms, native powrprof.dll) > brightnessctl (Linux) > PowerShell fallback
# Usage: brightness.sh <get|up|down> <percent>
#
# Sync pitfalls (same rules as volume.sh):
# 1. Do NOT background BrightCtl.exe with &. The integration calls `get` 200ms after
#    spawning this script. If BrightCtl.exe runs detached, it may still be applying
#    the change when `get` fires — reads stale value.
# 2. Do NOT call get_brightness() before up/down. BrightCtl.exe get costs ~194ms (WSL
#    .NET startup). That pushes the total script time past the 200ms read timer,
#    causing the same race. get_brightness() is only needed for the `get` case.
# 3. BrightCtl.exe up/down reads+applies the delta internally via powrprof.dll,
#    so the process exits only after the change is committed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION="$1"
AMOUNT="${2:-10}"

# Resolve an OS helper by trying every known location in priority order:
#   1. Colocated with this script (future-proof / portable pack layouts)
#   2. ~/.claude/opencues/scripts/  (post-rename CC install location)
#   3. ~/.claude/opencues/actions/  (pre-rename CC install — widespread)
#   4. ~/.claude/actions/           (pre-consolidation legacy)
# Prints the resolved path or empty string.
find_helper() {
  local name="$1"
  local candidates=(
    "${SCRIPT_DIR}/${name}"
    "${HOME}/.claude/opencues/scripts/${name}"
    "${HOME}/.claude/opencues/actions/${name}"
    "${HOME}/.claude/actions/${name}"
  )
  for p in "${candidates[@]}"; do
    [ -f "$p" ] && echo "$p" && return 0
  done
  return 1
}

BRIGHT_CTL="$(find_helper BrightCtl.exe || true)"
BRIGHT_SET_PS1="$(find_helper brightness-set.ps1 || true)"

# Live read: query actual system brightness
# Retries once on 0/empty — BrightCtl.exe can return empty on first call (.NET init delay)
get_brightness() {
  if [ -n "$BRIGHT_CTL" ]; then
    ACTUAL=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
    if [ -z "$ACTUAL" ] || [ "$ACTUAL" = "0" ]; then
      sleep 0.1
      ACTUAL=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
    fi
    [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && return
  fi
  if command -v brightnessctl &>/dev/null; then
    RAW=$(brightnessctl get 2>/dev/null)
    MAX=$(brightnessctl max 2>/dev/null)
    [ -n "$RAW" ] && [ -n "$MAX" ] && [ "$MAX" -gt 0 ] && echo $((RAW * 100 / MAX)) && return
  fi
  if [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
    ACTUAL=$(powershell.exe -NoProfile -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness" 2>/dev/null | tr -dc '0-9')
    [ -n "$ACTUAL" ] && echo "$ACTUAL" && return
  fi
  echo "50"
}

case "$DIRECTION" in
  get)
    echo "brightness: $(get_brightness)%"
    exit 0
    ;;
esac

# Apply — BrightCtl.exe handles get+delta+set internally (fast, no PowerShell needed)
if [ -n "$BRIGHT_CTL" ]; then
  "$BRIGHT_CTL" "$DIRECTION" "$AMOUNT"
elif command -v brightnessctl &>/dev/null; then
  CURRENT=$(brightnessctl get 2>/dev/null)
  MAX=$(brightnessctl max 2>/dev/null)
  [ -n "$CURRENT" ] && [ -n "$MAX" ] && [ "$MAX" -gt 0 ] && CURRENT=$((CURRENT * 100 / MAX))
  CURRENT=${CURRENT:-50}
  case "$DIRECTION" in
    up)   NEW=$((CURRENT + AMOUNT)); [ "$NEW" -gt 100 ] && NEW=100 ;;
    down) NEW=$((CURRENT - AMOUNT)); [ "$NEW" -lt 0 ] && NEW=0 ;;
  esac
  brightnessctl set "${NEW}%"
elif [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  CURRENT=$(powershell.exe -NoProfile -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness" 2>/dev/null | tr -dc '0-9')
  CURRENT=${CURRENT:-50}
  case "$DIRECTION" in
    up)   NEW=$((CURRENT + AMOUNT)); [ "$NEW" -gt 100 ] && NEW=100 ;;
    down) NEW=$((CURRENT - AMOUNT)); [ "$NEW" -lt 0 ] && NEW=0 ;;
  esac
  [ -n "$BRIGHT_SET_PS1" ] && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$BRIGHT_SET_PS1" "$NEW"
fi
