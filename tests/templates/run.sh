#!/usr/bin/env bash
# run.sh — runs every template instruction test.
#
# Each child script exits non-zero on failure. We collect results and
# print a final summary. Optional LLM smoke is run if GROQ_API_KEY set.

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCRIPTS=(
  "test-init-flow.sh"
  "test-cues-examples.sh"
  "test-blanks-cascade.sh"
  "test-blanks-shapes.sh"
  "llm-smoke.sh"
)

PASSED=()
FAILED=()
SKIPPED=()

for s in "${SCRIPTS[@]}"; do
  echo
  echo "######################################################################"
  echo "# $s"
  echo "######################################################################"
  if bash "$DIR/$s"; then
    if grep -q "^SKIP:" <(bash "$DIR/$s" 2>&1) 2>/dev/null; then
      SKIPPED+=("$s")
    else
      PASSED+=("$s")
    fi
  else
    FAILED+=("$s")
  fi
done

echo
echo "######################################################################"
echo "# SUMMARY"
echo "######################################################################"
echo "Passed:  ${#PASSED[@]}"
for s in "${PASSED[@]}"; do echo "  [32m●[0m $s"; done
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo "Skipped: ${#SKIPPED[@]}"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
fi
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed:  ${#FAILED[@]}"
  for s in "${FAILED[@]}"; do echo "  ✗ $s"; done
  exit 1
fi
echo
echo "All template instruction tests passed."
