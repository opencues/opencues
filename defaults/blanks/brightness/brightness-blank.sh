#!/usr/bin/env bash
# Brightness blank — backs `brightness _` blanks (e.g. "brightness ___")
# Usage: brightness-blank.sh <get|set> [value]
#
# Per-platform priority:
#   1. BrightCtl.exe (colocated, WSL only — see BrightCtl.cs)
#   2. macOS: `brightness` (brew install brightness) → built-in laptop displays.
#             External displays need `ddcutil` (rare on macOS).
#   3. Linux: brightnessctl (laptop backlight) → ddcutil (external DDC/CI).
#   4. WSL legacy: powershell.exe + brightness-set.ps1.
#
# get-with-no-backend echoes 50 so the runtime always has a value to
# splice. set-with-no-backend exits 0 — the cycle is recorded in the
# DynDef regardless.
#
# POSIX-portable: uses #!/usr/bin/env bash + plain test brackets so it
# runs under macOS bash 3.2.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION="$1"
VALUE="${2:-50}"

BRIGHT_CTL="${SCRIPT_DIR}/BrightCtl.exe"
BRIGHT_SET_PS1="${SCRIPT_DIR}/brightness-set.ps1"

clamp() {
  local v="$1"
  [ "$v" -gt 100 ] 2>/dev/null && v=100
  [ "$v" -lt 0 ] 2>/dev/null && v=0
  echo "$v"
}

case "$DIRECTION" in
  get)
    # WSL: colocated BrightCtl.exe.
    if [ -f "$BRIGHT_CTL" ]; then
      ACTUAL=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
      if [ "$ACTUAL" = "0" ] || [ -z "$ACTUAL" ]; then
        sleep 0.1
        ACTUAL=$("$BRIGHT_CTL" get 2>/dev/null | tr -dc '0-9')
      fi
      [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && exit 0
    fi

    # Linux: brightnessctl (laptop backlight via /sys/class/backlight).
    if command -v brightnessctl >/dev/null 2>&1; then
      RAW=$(brightnessctl get 2>/dev/null)
      MAX=$(brightnessctl max 2>/dev/null)
      [ -n "$RAW" ] && [ -n "$MAX" ] && [ "$MAX" -gt 0 ] && echo $((RAW * 100 / MAX)) && exit 0
    fi

    # macOS: `brightness` cli (brew install brightness). First display only.
    if command -v brightness >/dev/null 2>&1; then
      # `brightness -l` prints "display N: brightness 0.752734" lines.
      RAW=$(brightness -l 2>/dev/null | awk '/brightness/ {print $NF; exit}')
      if [ -n "$RAW" ]; then
        # 0.752734 → 75
        ACTUAL=$(awk "BEGIN{printf \"%d\", $RAW * 100}")
        [ -n "$ACTUAL" ] && echo "$ACTUAL" && exit 0
      fi
    fi

    # Linux/macOS: ddcutil for external DDC/CI displays.
    if command -v ddcutil >/dev/null 2>&1; then
      # `ddcutil getvcp 10` → "VCP code 0x10 (Brightness): current value =    65, max value =   100"
      ACTUAL=$(ddcutil getvcp 10 2>/dev/null \
        | awk -F'current value =' '{print $2}' \
        | awk -F',' '{gsub(/ /, "", $1); print $1}')
      [ -n "$ACTUAL" ] && echo "$ACTUAL" && exit 0
    fi

    # WSL: powershell WMI query.
    if [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
      ACTUAL=$(powershell.exe -NoProfile -Command "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness" 2>/dev/null | tr -dc '0-9')
      [ -n "$ACTUAL" ] && echo "$ACTUAL" && exit 0
    fi

    echo "50"
    ;;

  set)
    VALUE=$(clamp "$VALUE")

    # WSL: BrightCtl.exe.
    if [ -f "$BRIGHT_CTL" ]; then
      "$BRIGHT_CTL" set "$VALUE"
      exit 0
    fi

    # Linux: brightnessctl.
    if command -v brightnessctl >/dev/null 2>&1; then
      brightnessctl set "${VALUE}%" >/dev/null 2>&1
      exit 0
    fi

    # macOS: brightness cli expects a 0.0-1.0 float.
    if command -v brightness >/dev/null 2>&1; then
      brightness "$(awk "BEGIN{printf \"%.2f\", $VALUE / 100}")" >/dev/null 2>&1
      exit 0
    fi

    # Linux/macOS: ddcutil for external displays.
    if command -v ddcutil >/dev/null 2>&1; then
      ddcutil setvcp 10 "$VALUE" >/dev/null 2>&1
      exit 0
    fi

    # WSL: powershell + brightness-set.ps1.
    if [ -f /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ] && [ -f "$BRIGHT_SET_PS1" ]; then
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$BRIGHT_SET_PS1" "$VALUE"
      exit 0
    fi

    exit 0
    ;;

  *)
    echo "Usage: $(basename "$0") <get|set> [value]" >&2
    exit 1
    ;;
esac
