#!/bin/bash
# Full benchmark comparison of V1 vs V2

cd "$(dirname "$0")"
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
V1_PROMPT="$HOME/tweakcc/system_prompts/linked.txt"
V2_PROMPT="$HOME/tweakcc/system_prompts/linked-v2.txt"

V1_TOTAL_PASSED=0
V1_TOTAL_FAILED=0
V2_TOTAL_PASSED=0
V2_TOTAL_FAILED=0

run_benchmark() {
    local test_script="$1"
    local version="$2"
    local prompt_file="$3"

    # Run the benchmark with the specified prompt
    LINKED_PROMPT="$prompt_file" bash "$test_script" 2>/dev/null | tail -1
}

# Test all benchmarks
for benchmark in link-gender.sh link-number.sh link-verb.sh link-possession.sh link-tense.sh link-reflexive.sh link-quantity.sh link-determiner.sh link-negation.sh link-comparative.sh link-conditional.sh link-concept.sh; do
    if [[ ! -f "$benchmark" ]]; then
        continue
    fi

    name=$(basename "$benchmark" .sh)
    echo "Testing $name..."

    # V1
    v1_result=$(LINKED_PROMPT="$V1_PROMPT" bash "$benchmark" 2>/dev/null | grep -oP '\d+(?= passed)')
    v1_failed=$(LINKED_PROMPT="$V1_PROMPT" bash "$benchmark" 2>/dev/null | grep -oP '\d+(?= failed)')

    # V2
    v2_result=$(LINKED_PROMPT="$V2_PROMPT" bash "$benchmark" 2>/dev/null | grep -oP '\d+(?= passed)')
    v2_failed=$(LINKED_PROMPT="$V2_PROMPT" bash "$benchmark" 2>/dev/null | grep -oP '\d+(?= failed)')

    v1_result=${v1_result:-0}
    v1_failed=${v1_failed:-0}
    v2_result=${v2_result:-0}
    v2_failed=${v2_failed:-0}

    V1_TOTAL_PASSED=$((V1_TOTAL_PASSED + v1_result))
    V1_TOTAL_FAILED=$((V1_TOTAL_FAILED + v1_failed))
    V2_TOTAL_PASSED=$((V2_TOTAL_PASSED + v2_result))
    V2_TOTAL_FAILED=$((V2_TOTAL_FAILED + v2_failed))

    printf "  V1: %d/%d  |  V2: %d/%d\n" "$v1_result" "$((v1_result + v1_failed))" "$v2_result" "$((v2_result + v2_failed))"
done

echo ""
echo "=== TOTAL RESULTS ==="
v1_total=$((V1_TOTAL_PASSED + V1_TOTAL_FAILED))
v2_total=$((V2_TOTAL_PASSED + V2_TOTAL_FAILED))
v1_pct=$(echo "scale=1; $V1_TOTAL_PASSED * 100 / $v1_total" | bc 2>/dev/null || echo "0")
v2_pct=$(echo "scale=1; $V2_TOTAL_PASSED * 100 / $v2_total" | bc 2>/dev/null || echo "0")

echo "V1 (320 lines): $V1_TOTAL_PASSED / $v1_total ($v1_pct%)"
echo "V2 (146 lines): $V2_TOTAL_PASSED / $v2_total ($v2_pct%)"
