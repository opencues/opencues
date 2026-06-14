#!/usr/bin/env bash
# Brightness blank — backs `brightness _`, `brightness 70 _`,
# `set brightness to 70 _`.
# Usage: brightness-blank.sh <get|set> [value]
#
# Selector-satellite emission (June 2026):
#   get → echoes `brightness\t<value>%` (TAB-separated). The runtime's
#         blankSatellite path splices this as a one-span pair the
#         user can wipe in a single Backspace.
#   set → applies the new value (clamped to 0..100), then echoes
#         `brightness\t<clamped>%` so the buffer reflects the FINAL
#         post-clamp state.
#
# Per-platform priority:
#   1. BrightCtl.exe (colocated, WSL only — see BrightCtl.cs)
#   2. macOS: `brightness` (brew install brightness) → built-in laptop displays.
#             External displays need `ddcutil` (rare on macOS).
#   3. Linux: brightnessctl (laptop backlight) → ddcutil (external DDC/CI).
#   4. WSL legacy: powershell.exe + brightness-set.ps1.
#
# get-with-no-backend echoes 50 so the runtime always has a value to
# splice. set-with-no-backend echoes the clamped value so the buffer
# still updates even when the platform-side apply silently no-ops.
#
# POSIX-portable: uses #!/usr/bin/env bash + plain test brackets so it
# runs under macOS bash 3.2.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION="$1"
# The runtime calls `set` two ways:
#   shape-driven SET: `set <value>`               ($2 = numeric value)
#   satellite cycle:  `set <setting> <value>`     ($2 = "brightness", $3 = numeric)
# Pick the value field regardless: take $2 if numeric, otherwise $3.
case "$2" in
  ''|*[!0-9]*) VALUE="${3:-50}" ;;
  *) VALUE="$2" ;;
esac

BRIGHT_CTL="${SCRIPT_DIR}/BrightCtl.exe"
BRIGHT_SET_PS1="${SCRIPT_DIR}/brightness-set.ps1"

clamp() {
  local v="$1"
  [ "$v" -gt 100 ] 2>/dev/null && v=100
  [ "$v" -lt 0 ] 2>/dev/null && v=0
  echo "$v"
}

# Emit the selector\tsatellite pair the runtime expects.
emit() {
  printf 'brightness\t%s%%\n' "$1"
}

# Reusable GET — used by both `get` (echo current) and the SET
# branches' fallback when the backend's read-back fails.
read_current() {
  if [ -f "$BRIGHT_CTL" ]; then
    local v
    v=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
    if [ "$v" = "0" ] || [ -z "$v" ]; then
      sleep 0.1
      v=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
    fi
    [ -n "$v" ] && [ "$v" != "0" ] && echo "$v" && return 0
  fi
  if command -v brightnessctl >/dev/null 2>&1; then
    local raw max
    raw=$(brightnessctl get 2>/dev/null)
    max=$(brightnessctl max 2>/dev/null)
    [ -n "$raw" ] && [ -n "$max" ] && [ "$max" -gt 0 ] && echo $((raw * 100 / max)) && return 0
  fi
  if command -v brightness >/dev/null 2>&1; then
    local raw v
    raw=$(brightness -l 2>/dev/null | awk '/brightness/ {print $NF; exit}')
    if [ -n "$raw" ]; then
      v=$(awk "BEGIN{printf \"%d\", $raw * 100}")
      [ -n "$v" ] && echo "$v" && return 0
    fi
  fi
  if command -v ddcutil >/dev/null 2>&1; then
    local v
    v=$(ddcutil getvcp 10 2>/dev/null \
      | awk -F'current value =' '{print $2}' \
      | awk -F',' '{gsub(/ /, "", $1); print $1}')
    [ -n "$v" ] && echo "$v" && return 0
  fi
  if [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
    local v
    v=$(powershell.exe -NoProfile -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness" 2>/dev/null | tr -dc '0-9')
    [ -n "$v" ] && echo "$v" && return 0
  fi
  echo "50"
}

case "$DIRECTION" in
  get)
    emit "$(read_current)"
    ;;

  set)
    V=$(clamp "$VALUE")
    if [ -f "$BRIGHT_CTL" ]; then
      "$BRIGHT_CTL" set "$V" >/dev/null 2>&1
    elif command -v brightnessctl >/dev/null 2>&1; then
      brightnessctl set "${V}%" >/dev/null 2>&1
    elif command -v brightness >/dev/null 2>&1; then
      brightness "$(awk "BEGIN{printf \"%.2f\", $V / 100}")" >/dev/null 2>&1
    elif command -v ddcutil >/dev/null 2>&1; then
      ddcutil setvcp 10 "$V" >/dev/null 2>&1
    elif [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ] && [ -f "$BRIGHT_SET_PS1" ]; then
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$BRIGHT_SET_PS1" "$V" >/dev/null 2>&1
    fi
    # Echo the post-clamp value regardless of backend success — see
    # volume-blank.sh for the rationale.
    emit "$V"
    ;;

  *)
    echo "Usage: $(basename "$0") <get|set> [value]" >&2
    exit 1
    ;;
esac
