#!/usr/bin/env bash
# Suite driver: runs every scenario sequentially with the models given
# in CDI_DREAM_MODEL / CDI_CHECK_MODEL, appends full output to the
# results file, and echoes one score line per scenario (for Monitor).
# Usage: run-suite.sh <results-file> [scenario-name ...]
set -u
cd "$(dirname "$0")"
OUT="$1"; shift
: > "$OUT"
if [ $# -gt 0 ]; then LIST="$*"; else LIST=$(ls scenarios/*.json | xargs -n1 basename | sed 's/\.json$//'); fi
for s in $LIST; do
  echo "════ $s ════" >> "$OUT"
  node run-scenario.mjs "scenarios/$s.json" >> "$OUT" 2>>"$OUT.err" || true
  tail -2 "$OUT" | grep -E ": [0-9]+/[0-9]+" || echo "$s: NO-SCORE (see $OUT.err)"
done
echo "SUITE-DONE $OUT"
