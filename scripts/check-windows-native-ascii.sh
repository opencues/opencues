#!/usr/bin/env bash
# Guard against the em-dash bug class (July 2026): Windows PowerShell 5.1
# reads .ps1/.vbs as ANSI (Windows-1252), NOT UTF-8, unless there's a BOM.
# A non-ASCII char (—, …, →, box-drawing) in a UTF-8 file gets mojibake'd
# on 5.1 — and in a string literal it introduces a stray quote that breaks
# parsing, silently killing the tray. Add-Type compiles the .cs under the
# same host, so those must be ASCII too.
#
# This guard keeps every Windows-native launcher/compiled source pure
# ASCII. If you need a real non-ASCII glyph in OUTPUT, build it at runtime
# from a code point ([char]0x2014), never as a literal in the file.
#
# Wire into scripts/pre-pr.sh + CI. Exit non-zero on any non-ASCII byte.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NATIVE="$ROOT/integrations/windows/native"

fail=0
if [[ -d "$NATIVE" ]]; then
  while IFS= read -r -d '' f; do
    # Find non-ASCII bytes (outside 0x00-0x7F).
    if LC_ALL=C grep -nP '[^\x00-\x7F]' "$f" >/dev/null 2>&1; then
      echo "✗ non-ASCII in $(basename "$f") (breaks Windows PowerShell 5.1 / Add-Type):"
      LC_ALL=C grep -nP '[^\x00-\x7F]' "$f" | head -5 | sed 's/^/    /'
      fail=1
    fi
  done < <(find "$NATIVE" -type f \( -name '*.ps1' -o -name '*.vbs' -o -name '*.cs' \) -print0)
fi

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "Fix: replace the glyphs with ASCII (— → -, … → ..., → → ->, ─ → -)."
  echo "     Runtime output needing a real glyph: [char]0x2014, not a literal."
  exit 1
fi

echo "● Windows native launchers are pure ASCII (PowerShell 5.1 / Add-Type safe)."
