#!/usr/bin/env bash
# Summarize the opencode-zen free-pool fluid-blank sweep.
#
# Re-create the raw logs by running:
#   /tmp/run-zen-sweep.sh
# or, per model:
#   OPENCUES_BENCH_PROVIDER=opencode-zen \
#     OPENCUES_OPENCODE_ZEN_MODEL=<model> \
#     OPENCUES_OPENCODE_ZEN_DELAY_MS=1500 \
#     npx tsx tests/benchmarks/fluid-blank/run.ts --mode fused --parallel 1 --limit 30 \
#     > tests/results/opencode-zen-free/<model>.log 2>&1
#
# *.log is gitignored — re-run to populate.
set -euo pipefail
DIR="$(dirname "$0")"

printf '%-30s %-12s %-12s %-12s %-10s\n' "Model" "Total-pass" "Per-case" "Wall-clock" "Status"
printf '%-30s %-12s %-12s %-12s %-10s\n' "-----" "----------" "--------" "----------" "------"

for f in "$DIR"/*.log; do
  base=$(basename "$f" .log)
  [[ "$base" == "_progress" ]] && continue
  clean=$(sed 's/\x1b\[[0-9;]*m//g' "$f")
  total=$(echo "$clean" | grep -E "^Total:" | head -1 || true)
  modelavg=$(echo "$clean" | grep -E "^Avg model" | head -1 || true)
  wall=$(echo "$clean" | grep -E "^Wall-clock total:" | head -1 || true)
  fatal=$(echo "$clean" | grep -E "^FATAL:" | head -1 || true)

  if [[ -n "$fatal" ]]; then
    status="RETIRED"
    if [[ "$fatal" == *"Go"* ]]; then status="→ paid Go"; fi
    printf '%-30s %-12s %-12s %-12s %-10s\n' "$base" "—" "—" "—" "$status"
    continue
  fi

  tot_pct=$(echo "$total" | grep -oE '\([0-9.]+%\)' | head -1 || echo "?")
  per_ms=$(echo "$modelavg" | grep -oE 'per case\): [0-9]+ms' | grep -oE '[0-9]+ms' || echo "?")
  wall_s=$(echo "$wall" | grep -oE '[0-9]+\.[0-9]+s' | head -1 || echo "?")

  printf '%-30s %-12s %-12s %-12s %-10s\n' "$base" "$tot_pct" "$per_ms" "$wall_s" "live"
done
