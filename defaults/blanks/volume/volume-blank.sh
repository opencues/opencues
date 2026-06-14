#!/usr/bin/env bash
# Volume blank — backs `volume _`, `volume 70 _`, `set volume to 70 _`.
# Usage: volume-blank.sh <get|set> [value]
#
# Selector-satellite emission (June 2026):
#   get → echoes `volume\t<value>%` (TAB-separated).  The runtime's
#         blankSatellite path splices this as a one-span pair the user
#         can wipe in a single Backspace.
#   set → applies the new value (clamped to 0..100), then echoes
#         `volume\t<clamped>%` so the buffer reflects the FINAL
#         post-clamp state (200 → clamps to 100 → buffer shows 100%,
#         not 200%).
#
# Per-platform priority:
#   1. VolCtl.exe (colocated, WSL only — ~10ms, see VolCtl.cs)
#   2. nircmd.exe at /mnt/c/Windows/ (legacy WSL fallback)
#   3. macOS: osascript (built-in, always available)
#   4. Linux: wpctl (PipeWire) → pactl (PulseAudio) → amixer (ALSA)
#
# Exits 0 + echoes a sentinel "50" on get-with-no-backend so the
# runtime still has a value to splice. set-with-no-backend echoes the
# clamped value too — the runtime substitutes it even if the OS-side
# apply was a no-op; the cycle step is recorded in OPENCUES.md anyway.
#
# POSIX-portable: uses #!/usr/bin/env bash + plain test brackets so it
# runs under macOS bash 3.2.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION="$1"
# The runtime calls `set` two ways:
#   shape-driven SET: `set <value>`               ($2 = numeric value)
#   satellite cycle:  `set <setting> <value>`     ($2 = "volume", $3 = numeric)
# Pick the value field regardless: take $2 if numeric, otherwise $3.
# POSIX `case` is the portable shape-test (bash 3.2 lacks `[[ =~ ]]`).
case "$2" in
  ''|*[!0-9]*) VALUE="${3:-50}" ;;
  *) VALUE="$2" ;;
esac

VOL_CTL="${SCRIPT_DIR}/VolCtl.exe"

# Clamp helper used by every set-branch.
clamp() {
  local v="$1"
  [ "$v" -gt 100 ] 2>/dev/null && v=100
  [ "$v" -lt 0 ] 2>/dev/null && v=0
  echo "$v"
}

# Emit the selector\tsatellite pair the runtime expects.
emit() {
  printf 'volume\t%s%%\n' "$1"
}

# Reusable GET — used by both `get` (echo current) and the SET branches'
# fallback (echo the requested value if the backend's read-back fails).
read_current() {
  if [ -f "$VOL_CTL" ]; then
    local v
    v=$("$VOL_CTL" get 2>/dev/null | tr -dc '0-9')
    if [ "$v" = "0" ] || [ -z "$v" ]; then
      sleep 0.1
      v=$("$VOL_CTL" get 2>/dev/null | tr -dc '0-9')
    fi
    [ -n "$v" ] && [ "$v" != "0" ] && echo "$v" && return 0
  fi
  if command -v osascript >/dev/null 2>&1; then
    local v
    v=$(osascript -e 'output volume of (get volume settings)' 2>/dev/null)
    if [ -n "$v" ] && [ "$v" != "missing value" ]; then
      echo "$v" && return 0
    fi
  fi
  if command -v wpctl >/dev/null 2>&1; then
    local raw v
    raw=$(wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>/dev/null | awk '{print $2}')
    if [ -n "$raw" ]; then
      v=$(awk "BEGIN{printf \"%d\", $raw * 100}")
      [ -n "$v" ] && echo "$v" && return 0
    fi
  fi
  if command -v pactl >/dev/null 2>&1; then
    local v
    v=$(pactl get-sink-volume @DEFAULT_SINK@ 2>/dev/null \
      | grep -oE '[0-9]+%' | head -1 | tr -d '%')
    [ -n "$v" ] && echo "$v" && return 0
  fi
  if command -v amixer >/dev/null 2>&1; then
    local v
    v=$(amixer get Master 2>/dev/null \
      | grep -oE '[0-9]+%' | head -1 | tr -d '%')
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
    if [ -f "$VOL_CTL" ]; then
      "$VOL_CTL" set "$V" >/dev/null 2>&1
    elif command -v osascript >/dev/null 2>&1; then
      osascript -e "set volume output volume $V" >/dev/null 2>&1
    elif command -v wpctl >/dev/null 2>&1; then
      wpctl set-volume @DEFAULT_AUDIO_SINK@ "$(awk "BEGIN{printf \"%.2f\", $V / 100}")" >/dev/null 2>&1
    elif command -v pactl >/dev/null 2>&1; then
      pactl set-sink-volume @DEFAULT_SINK@ "${V}%" >/dev/null 2>&1
    elif command -v amixer >/dev/null 2>&1; then
      amixer set Master "${V}%" >/dev/null 2>&1
    elif [ -f /mnt/c/Windows/nircmd.exe ]; then
      /mnt/c/Windows/nircmd.exe setsysvolume $((V * 655))
    fi
    # Echo the post-clamp value regardless of backend success — the
    # runtime needs SOMETHING to substitute; "I asked for V" is more
    # useful than nothing when the OS-side apply silently no-op'd.
    emit "$V"
    ;;

  *)
    echo "Usage: $(basename "$0") <get|set> [value]" >&2
    exit 1
    ;;
esac
