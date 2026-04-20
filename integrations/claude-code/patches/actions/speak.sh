#!/bin/bash
# Text-to-speech for cue tips
# Priority: SpeakCtl.exe (~50ms) > PowerShell (~500ms) > espeak-ng (Linux)
# Usage: speak.sh <text> [rate]
#   text = string to speak
#   rate = SAPI rate (-10 to 10, default 2)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXT="$1"
RATE="${2:-2}"
PID_FILE="/tmp/cue-tts.pid"

[ -z "$TEXT" ] && exit 0

# Sanitize rate: must be integer -10 to 10
[[ "$RATE" =~ ^-?[0-9]+$ ]] || RATE=2
(( RATE > 10 )) && RATE=10
(( RATE < -10 )) && RATE=-10

# Resolve SpeakCtl.exe across install layouts. Without this, a stale
# path-hardcode silently falls through to the ~500ms PowerShell branch
# — user-perceptible lag every time TTS fires.
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
SPEAK_CTL="$(find_helper SpeakCtl.exe || true)"

# Kill previous TTS process
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null
    pkill -P "$OLD_PID" 2>/dev/null
  fi
fi

if [ -n "$SPEAK_CTL" ]; then
  # Compiled .exe — fast (~50ms startup)
  "$SPEAK_CTL" "$TEXT" "$RATE" &
  echo $! > "$PID_FILE"
elif [ -d /mnt/c/Windows ]; then
  # WSL fallback: PowerShell (~500ms startup)
  SAFE_TEXT="${TEXT//\'/\'\'}"
  powershell.exe -NoProfile -Command "
    Add-Type -AssemblyName System.Speech
    \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    \$s.Rate = $RATE
    \$s.Speak('$SAFE_TEXT')
  " &
  echo $! > "$PID_FILE"
elif command -v espeak-ng &>/dev/null; then
  espeak-ng -s $((150 + RATE * 20)) "$TEXT" &
  echo $! > "$PID_FILE"
elif command -v spd-say &>/dev/null; then
  spd-say -r $((RATE * 10)) "$TEXT" &
  echo $! > "$PID_FILE"
fi
