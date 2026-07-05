#!/usr/bin/env bash
# Volume blank — backs `volume _` (e.g. "volume ___")
# Usage: volume-blank.sh <get|set> [value]
#
# Per-platform priority:
#   1. VolCtl.exe (colocated, WSL only — ~10ms, see VolCtl.cs)
#   2. nircmd.exe at /mnt/c/Windows/ (legacy WSL fallback)
#   3. macOS: osascript (built-in, always available)
#   4. Linux: wpctl (PipeWire) → pactl (PulseAudio) → amixer (ALSA)
#
# Exits 0 + prints "50" on get-with-no-backend so the runtime still has
# a value to splice. set-with-no-backend exits 0 silently (the cycle
# step is recorded in OPENCUES.md anyway).
#
# POSIX-portable: uses #!/usr/bin/env bash + plain test brackets so it
# runs under macOS bash 3.2.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIRECTION="$1"
VALUE="${2:-50}"

VOL_CTL="${SCRIPT_DIR}/VolCtl.exe"

# Clamp helper used by every set-branch.
clamp() {
  local v="$1"
  [ "$v" -gt 100 ] 2>/dev/null && v=100
  [ "$v" -lt 0 ] 2>/dev/null && v=0
  echo "$v"
}

case "$DIRECTION" in
  get)
    # WSL: prefer colocated VolCtl.exe (zero-dep, fastest).
    if [ -f "$VOL_CTL" ]; then
      ACTUAL=$("$VOL_CTL" get 2>/dev/null | tr -dc '0-9')
      if [ "$ACTUAL" = "0" ] || [ -z "$ACTUAL" ]; then
        sleep 0.1
        ACTUAL=$("$VOL_CTL" get 2>/dev/null | tr -dc '0-9')
      fi
      [ -n "$ACTUAL" ] && [ "$ACTUAL" != "0" ] && echo "$ACTUAL" && exit 0
    fi

    # macOS native.
    if command -v osascript >/dev/null 2>&1; then
      ACTUAL=$(osascript -e 'output volume of (get volume settings)' 2>/dev/null)
      if [ -n "$ACTUAL" ] && [ "$ACTUAL" != "missing value" ]; then
        echo "$ACTUAL"
        exit 0
      fi
    fi

    # Linux PipeWire (default on modern distros).
    if command -v wpctl >/dev/null 2>&1; then
      # `wpctl get-volume @DEFAULT_AUDIO_SINK@` → "Volume: 0.65 [MUTED]"
      RAW=$(wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>/dev/null | awk '{print $2}')
      if [ -n "$RAW" ]; then
        # 0.65 → 65 (multiply by 100, strip decimal).
        ACTUAL=$(awk "BEGIN{printf \"%d\", $RAW * 100}")
        [ -n "$ACTUAL" ] && echo "$ACTUAL" && exit 0
      fi
    fi

    # Linux PulseAudio.
    if command -v pactl >/dev/null 2>&1; then
      # `pactl get-sink-volume @DEFAULT_SINK@` → "Volume: front-left: 42598 / 65%  / ..."
      ACTUAL=$(pactl get-sink-volume @DEFAULT_SINK@ 2>/dev/null \
        | grep -oE '[0-9]+%' | head -1 | tr -d '%')
      [ -n "$ACTUAL" ] && echo "$ACTUAL" && exit 0
    fi

    # Linux ALSA.
    if command -v amixer >/dev/null 2>&1; then
      ACTUAL=$(amixer get Master 2>/dev/null \
        | grep -oE '[0-9]+%' | head -1 | tr -d '%')
      [ -n "$ACTUAL" ] && echo "$ACTUAL" && exit 0
    fi

    # WSL last-resort fallback.
    if [ -f /mnt/c/Windows/nircmd.exe ]; then
      # nircmd has no get — just echo the cycle's running value.
      echo "50"
      exit 0
    fi

    # No backend — keep the runtime happy with a plausible default.
    echo "50"
    ;;

  set)
    # Independent guard (INFOSEC NF2): don't trust the caller to have
    # validated VALUE — clamp() only rewrites non-conforming input when
    # bash's numeric test happens to succeed, and VALUE is interpolated
    # into an `awk "BEGIN{...}"` string below. Reject anything that
    # isn't a plain non-negative integer before it reaches that string.
    case "$VALUE" in
      ''|*[!0-9]*) exit 0 ;;
    esac
    VALUE=$(clamp "$VALUE")

    # WSL: VolCtl.exe.
    if [ -f "$VOL_CTL" ]; then
      "$VOL_CTL" set "$VALUE"
      exit 0
    fi

    # macOS.
    if command -v osascript >/dev/null 2>&1; then
      osascript -e "set volume output volume $VALUE" >/dev/null 2>&1
      exit 0
    fi

    # Linux PipeWire.
    if command -v wpctl >/dev/null 2>&1; then
      # wpctl expects a float (0.0–1.0+).
      wpctl set-volume @DEFAULT_AUDIO_SINK@ "$(awk "BEGIN{printf \"%.2f\", $VALUE / 100}")" >/dev/null 2>&1
      exit 0
    fi

    # Linux PulseAudio.
    if command -v pactl >/dev/null 2>&1; then
      pactl set-sink-volume @DEFAULT_SINK@ "${VALUE}%" >/dev/null 2>&1
      exit 0
    fi

    # Linux ALSA.
    if command -v amixer >/dev/null 2>&1; then
      amixer set Master "${VALUE}%" >/dev/null 2>&1
      exit 0
    fi

    # WSL legacy.
    if [ -f /mnt/c/Windows/nircmd.exe ]; then
      /mnt/c/Windows/nircmd.exe setsysvolume $((VALUE * 655))
      exit 0
    fi

    # No backend. Exit 0 — the runtime has already recorded the cycle
    # step in OPENCUES.md; failing here would surface as a user-visible
    # error every cycle press on an unsupported platform.
    exit 0
    ;;

  *)
    echo "Usage: $(basename "$0") <get|set> [value]" >&2
    exit 1
    ;;
esac
