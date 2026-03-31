#!/bin/bash

# Run all benchmarks for a single model
# Usage: LLM_MODEL=groq-120b ./run-all.sh
#
# Models: groq-120b (default), groq-20b, cerebras-120b, cerebras-glm

set -e
cd "$(dirname "$0")"

MODEL="${LLM_MODEL:-groq-120b}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="../results"
mkdir -p "$RESULTS_DIR"
OUTPUT_FILE="$RESULTS_DIR/${MODEL}-${TIMESTAMP}.txt"

echo "=========================================="
echo "Model: $MODEL"
echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
echo ""

# Arrays to track results
declare -A BENCH_PASSED
declare -A BENCH_FAILED
declare -A BENCH_LATENCY_SUM
declare -A BENCH_LATENCY_COUNT

# Run a benchmark and capture results
run_benchmark() {
    local script="$1"
    local name=$(basename "$script" .sh)

    echo "Running $name..."

    local start_time=$(date +%s%3N)

    # Run benchmark and capture output
    local output
    output=$(LLM_MODEL="$MODEL" bash "$script" 2>&1)

    local end_time=$(date +%s%3N)
    local duration=$((end_time - start_time))

    # Parse passed/failed from output
    local passed=$(echo "$output" | grep -oP 'Results: \K\d+(?= passed)' || echo "0")
    local failed=$(echo "$output" | grep -oP '\d+(?= failed)' | tail -1 || echo "0")
    local total=$((passed + failed))

    # Calculate per-test latency (rough estimate)
    local avg_latency=0
    if [[ $total -gt 0 ]]; then
        avg_latency=$((duration / total))
    fi

    # Store results
    BENCH_PASSED[$name]=$passed
    BENCH_FAILED[$name]=$failed
    BENCH_LATENCY_SUM[$name]=$duration
    BENCH_LATENCY_COUNT[$name]=$total

    local pct=0
    if [[ $total -gt 0 ]]; then
        pct=$(echo "scale=1; $passed * 100 / $total" | bc)
    fi

    echo "$name: $passed/$total ($pct%) avg: ${avg_latency}ms"
    echo ""
}

# Capture all output
{
    echo "Model: $MODEL"
    echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""

    echo "=== MATH ==="
    run_benchmark "./math.sh"
    run_benchmark "./math-edge.sh"

    math_passed=$((${BENCH_PASSED[math]:-0} + ${BENCH_PASSED[math-edge]:-0}))
    math_failed=$((${BENCH_FAILED[math]:-0} + ${BENCH_FAILED[math-edge]:-0}))
    math_total=$((math_passed + math_failed))
    math_pct=$(echo "scale=1; $math_passed * 100 / $math_total" | bc 2>/dev/null || echo "0")
    echo "Subtotal: $math_passed/$math_total ($math_pct%)"
    echo ""

    echo "=== FACTUAL ==="
    run_benchmark "./factual.sh"
    run_benchmark "./factual-edge.sh"

    fact_passed=$((${BENCH_PASSED[factual]:-0} + ${BENCH_PASSED[factual-edge]:-0}))
    fact_failed=$((${BENCH_FAILED[factual]:-0} + ${BENCH_FAILED[factual-edge]:-0}))
    fact_total=$((fact_passed + fact_failed))
    fact_pct=$(echo "scale=1; $fact_passed * 100 / $fact_total" | bc 2>/dev/null || echo "0")
    echo "Subtotal: $fact_passed/$fact_total ($fact_pct%)"
    echo ""

    echo "=== GRAMMAR ==="
    run_benchmark "./word.sh"
    run_benchmark "./word-edge.sh"

    gram_passed=$((${BENCH_PASSED[word]:-0} + ${BENCH_PASSED[word-edge]:-0}))
    gram_failed=$((${BENCH_FAILED[word]:-0} + ${BENCH_FAILED[word-edge]:-0}))
    gram_total=$((gram_passed + gram_failed))
    gram_pct=$(echo "scale=1; $gram_passed * 100 / $gram_total" | bc 2>/dev/null || echo "0")
    echo "Subtotal: $gram_passed/$gram_total ($gram_pct%)"
    echo ""

    echo "=== LINKED ==="
    run_benchmark "./linked/link-gender.sh"
    run_benchmark "./linked/link-number.sh"
    run_benchmark "./linked/link-verb.sh"
    run_benchmark "./linked/link-possession.sh"
    run_benchmark "./linked/link-tense.sh"
    run_benchmark "./linked/link-reflexive.sh"
    run_benchmark "./linked/link-quantity.sh"
    run_benchmark "./linked/link-determiner.sh"
    run_benchmark "./linked/link-negation.sh"
    run_benchmark "./linked/link-comparative.sh"
    run_benchmark "./linked/link-conditional.sh"
    run_benchmark "./linked/link-concept.sh"

    link_passed=$((${BENCH_PASSED[link-gender]:-0} + ${BENCH_PASSED[link-number]:-0} + ${BENCH_PASSED[link-verb]:-0} + ${BENCH_PASSED[link-possession]:-0} + ${BENCH_PASSED[link-tense]:-0} + ${BENCH_PASSED[link-reflexive]:-0} + ${BENCH_PASSED[link-quantity]:-0} + ${BENCH_PASSED[link-determiner]:-0} + ${BENCH_PASSED[link-negation]:-0} + ${BENCH_PASSED[link-comparative]:-0} + ${BENCH_PASSED[link-conditional]:-0} + ${BENCH_PASSED[link-concept]:-0}))
    link_failed=$((${BENCH_FAILED[link-gender]:-0} + ${BENCH_FAILED[link-number]:-0} + ${BENCH_FAILED[link-verb]:-0} + ${BENCH_FAILED[link-possession]:-0} + ${BENCH_FAILED[link-tense]:-0} + ${BENCH_FAILED[link-reflexive]:-0} + ${BENCH_FAILED[link-quantity]:-0} + ${BENCH_FAILED[link-determiner]:-0} + ${BENCH_FAILED[link-negation]:-0} + ${BENCH_FAILED[link-comparative]:-0} + ${BENCH_FAILED[link-conditional]:-0} + ${BENCH_FAILED[link-concept]:-0}))
    link_total=$((link_passed + link_failed))
    link_pct=$(echo "scale=1; $link_passed * 100 / $link_total" | bc 2>/dev/null || echo "0")
    echo "Subtotal: $link_passed/$link_total ($link_pct%)"
    echo ""

    echo "=== TOTAL ==="
    total_passed=$((math_passed + fact_passed + gram_passed + link_passed))
    total_failed=$((math_failed + fact_failed + gram_failed + link_failed))
    total_tests=$((total_passed + total_failed))
    total_pct=$(echo "scale=1; $total_passed * 100 / $total_tests" | bc 2>/dev/null || echo "0")

    # Calculate total latency
    total_latency=0
    for name in "${!BENCH_LATENCY_SUM[@]}"; do
        total_latency=$((total_latency + ${BENCH_LATENCY_SUM[$name]}))
    done
    avg_latency=$((total_latency / total_tests))

    echo "Passed: $total_passed/$total_tests ($total_pct%)"
    echo "Avg Latency: ${avg_latency}ms"

    # Cost estimate (assuming 80 input tokens, 30 output tokens per request at 1k req/day * 30 days)
    # Formula: (input_tokens * input_price + output_tokens * output_price) * 30000 / 1000000
    case "$MODEL" in
        groq-120b)
            monthly=$(echo "scale=2; (80 * 0.15 + 30 * 0.60) * 30000 / 1000000" | bc -l)
            ;;
        groq-20b)
            monthly=$(echo "scale=2; (80 * 0.075 + 30 * 0.30) * 30000 / 1000000" | bc -l)
            ;;
        cerebras-120b)
            monthly=$(echo "scale=2; (80 * 0.35 + 30 * 0.75) * 30000 / 1000000" | bc -l)
            ;;
        cerebras-glm)
            monthly=$(echo "scale=2; (80 * 2.25 + 30 * 2.75) * 30000 / 1000000" | bc -l)
            ;;
        *)
            monthly="N/A"
            ;;
    esac
    echo "Est. Monthly (1k req/day): \$$monthly"

} | tee "$OUTPUT_FILE"

echo ""
echo "Results saved to: $OUTPUT_FILE"
