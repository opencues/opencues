#!/usr/bin/env bash
set -euo pipefail
DIR="$(dirname "$0")"

printf '%-40s %-12s %-12s %-12s %-10s\n' "Run" "Total-pass" "Per-case" "Wall-clock" "Throughput"
printf '%-40s %-12s %-12s %-12s %-10s\n' "---" "----------" "--------" "----------" "----------"

for f in "$DIR"/*.log; do
  name=$(basename "$f" .log)
  clean=$(sed 's/\x1b\[[0-9;]*m//g' "$f")
  total=$(echo "$clean" | grep -E "^Total:" | head -1 || true)
  modelavg=$(echo "$clean" | grep -E "^Avg model" | head -1 || true)
  wall=$(echo "$clean" | grep -E "^Wall-clock total:" | head -1 || true)
  thr=$(echo "$clean" | grep -E "^Throughput:" | head -1 || true)

  tot_pct=$(echo "$total" | grep -oE '\([0-9.]+%\)' | head -1 || echo "?")
  per_ms=$(echo "$modelavg" | grep -oE 'per case\): [0-9]+ms' | grep -oE '[0-9]+ms' || echo "?")
  wall_s=$(echo "$wall" | grep -oE '[0-9]+\.[0-9]+s' | head -1 || echo "?")
  thr_v=$(echo "$thr" | grep -oE '[0-9]+\.[0-9]+ cases/sec' || echo "?")

  printf '%-40s %-12s %-12s %-12s %-10s\n' "$name" "$tot_pct" "$per_ms" "$wall_s" "$thr_v"
done
