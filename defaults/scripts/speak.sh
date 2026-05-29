#!/usr/bin/env bash
# Text-to-speech for cue tips
# Priority: SpeakCtl.exe (~50ms) > PowerShell (~500ms) > espeak-ng (Linux) > say (macOS)
# Usage: speak.sh <text> [rate]
#   text = string to speak
#   rate = SAPI rate (-10 to 10, default 2)
#
# POSIX-portable: avoids `[[ =~ ]]` regex and `(( ))` arithmetic so it
# runs under macOS's bash 3.2 (and any POSIX sh).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEXT="$1"
RATE="${2:-2}"
PID_FILE="/tmp/cue-tts.pid"

[ -z "$TEXT" ] && exit 0

# Sanitize rate: must be integer -10 to 10
echo "$RATE" | grep -qE '^-?[0-9]+$' || RATE=2
[ "$RATE" -gt 10 ] && RATE=10
[ "$RATE" -lt -10 ] && RATE=-10

# SpeakCtl.exe is colocated in this same directory (setup.sh ships both
# speak.sh and SpeakCtl.exe to <CC_FORK>/.cues/scripts/ together).
# Falls through to the PowerShell / espeak branches below if it's missing.
SPEAK_CTL="${SCRIPT_DIR}/SpeakCtl.exe"

# Kill previous TTS process
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null
    pkill -P "$OLD_PID" 2>/dev/null
  fi
fi

if [ -f "$SPEAK_CTL" ]; then
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
elif command -v say >/dev/null 2>&1; then
  # macOS native TTS. `say -r` is words/min (default 200); map SAPI's
  # -10..10 to ~100..300 wpm so cue tips feel comparable to the
  # SpeakCtl / PowerShell branches.
  say -r $((200 + RATE * 10)) "$TEXT" &
  echo $! > "$PID_FILE"
fi
