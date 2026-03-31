#!/bin/bash

# Compare all 4 models across all benchmarks
# Usage: ./compare-models.sh
#
# Requires: GROQ_API_KEY and CEREBRAS_API_KEY

set -e
cd "$(dirname "$0")"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="../results"
mkdir -p "$RESULTS_DIR"
COMPARISON_FILE="$RESULTS_DIR/comparison-${TIMESTAMP}.md"

# Check API keys
MODELS_TO_RUN=()

if [[ -n "$GROQ_API_KEY" ]]; then
    MODELS_TO_RUN+=("groq-120b" "groq-20b")
    echo "✓ GROQ_API_KEY set - will test groq-120b, groq-20b"
else
    echo "✗ GROQ_API_KEY not set - skipping Groq models"
fi

if [[ -n "$CEREBRAS_API_KEY" ]]; then
    MODELS_TO_RUN+=("cerebras-120b" "cerebras-glm")
    echo "✓ CEREBRAS_API_KEY set - will test cerebras-120b, cerebras-glm"
else
    echo "✗ CEREBRAS_API_KEY not set - skipping Cerebras models"
fi

if [[ ${#MODELS_TO_RUN[@]} -eq 0 ]]; then
    echo ""
    echo "Error: No API keys set. Please set GROQ_API_KEY and/or CEREBRAS_API_KEY"
    exit 1
fi

echo ""
echo "=========================================="
echo "Running benchmarks for ${#MODELS_TO_RUN[@]} models..."
echo "=========================================="
echo ""

# Arrays to store results for each model
declare -A MODEL_MATH_PASSED MODEL_MATH_TOTAL
declare -A MODEL_FACT_PASSED MODEL_FACT_TOTAL
declare -A MODEL_GRAM_PASSED MODEL_GRAM_TOTAL
declare -A MODEL_LINK_PASSED MODEL_LINK_TOTAL
declare -A MODEL_TOTAL_PASSED MODEL_TOTAL_TESTS
declare -A MODEL_AVG_LATENCY MODEL_MONTHLY
declare -A MODEL_MATH_CORE MODEL_MATH_EDGE
declare -A MODEL_FACT_CORE MODEL_FACT_EDGE
declare -A MODEL_GRAM_CORE MODEL_GRAM_EDGE
declare -A MODEL_LINK_CORE

# Run each model
for model in "${MODELS_TO_RUN[@]}"; do
    echo "=========================================="
    echo "Testing: $model"
    echo "=========================================="

    output=$(LLM_MODEL="$model" bash ./run-all.sh 2>&1)
    result_file=$(echo "$output" | grep "Results saved to:" | sed 's/Results saved to: //')

    # Parse results from output
    MODEL_MATH_CORE[$model]=$(echo "$output" | grep "^math:" | head -1 | grep -oP '\d+/\d+' || echo "0/0")
    MODEL_MATH_EDGE[$model]=$(echo "$output" | grep "^math-edge:" | head -1 | grep -oP '\d+/\d+' || echo "0/0")
    MODEL_FACT_CORE[$model]=$(echo "$output" | grep "^factual:" | head -1 | grep -oP '\d+/\d+' || echo "0/0")
    MODEL_FACT_EDGE[$model]=$(echo "$output" | grep "^factual-edge:" | head -1 | grep -oP '\d+/\d+' || echo "0/0")
    MODEL_GRAM_CORE[$model]=$(echo "$output" | grep "^word:" | head -1 | grep -oP '\d+/\d+' || echo "0/0")
    MODEL_GRAM_EDGE[$model]=$(echo "$output" | grep "^word-edge:" | head -1 | grep -oP '\d+/\d+' || echo "0/0")
    MODEL_LINK_CORE[$model]=$(echo "$output" | grep "^word-link:" | head -1 | grep -oP '\d+/\d+' || echo "0/0")

    # Parse subtotals
    MODEL_MATH_PASSED[$model]=$(echo "$output" | grep -A1 "=== MATH ===" | tail -1 | grep -oP 'Subtotal: \K\d+' || echo "0")
    MODEL_MATH_TOTAL[$model]=$(echo "$output" | grep -A1 "=== MATH ===" | tail -1 | grep -oP 'Subtotal: \d+/\K\d+' || echo "0")
    MODEL_FACT_PASSED[$model]=$(echo "$output" | grep -A1 "=== FACTUAL ===" | tail -1 | grep -oP 'Subtotal: \K\d+' || echo "0")
    MODEL_FACT_TOTAL[$model]=$(echo "$output" | grep -A1 "=== FACTUAL ===" | tail -1 | grep -oP 'Subtotal: \d+/\K\d+' || echo "0")
    MODEL_GRAM_PASSED[$model]=$(echo "$output" | grep -A1 "=== GRAMMAR ===" | tail -1 | grep -oP 'Subtotal: \K\d+' || echo "0")
    MODEL_GRAM_TOTAL[$model]=$(echo "$output" | grep -A1 "=== GRAMMAR ===" | tail -1 | grep -oP 'Subtotal: \d+/\K\d+' || echo "0")
    MODEL_LINK_PASSED[$model]=$(echo "$output" | grep -A1 "=== LINKED ===" | tail -1 | grep -oP 'Subtotal: \K\d+' || echo "0")
    MODEL_LINK_TOTAL[$model]=$(echo "$output" | grep -A1 "=== LINKED ===" | tail -1 | grep -oP 'Subtotal: \d+/\K\d+' || echo "0")

    # Parse totals
    MODEL_TOTAL_PASSED[$model]=$(echo "$output" | grep "^Passed:" | grep -oP 'Passed: \K\d+' || echo "0")
    MODEL_TOTAL_TESTS[$model]=$(echo "$output" | grep "^Passed:" | grep -oP 'Passed: \d+/\K\d+' || echo "0")
    MODEL_AVG_LATENCY[$model]=$(echo "$output" | grep "^Avg Latency:" | grep -oP '\d+(?=ms)' || echo "0")
    MODEL_MONTHLY[$model]=$(echo "$output" | grep "^Est. Monthly" | grep -oP '\$[\d.]+' || echo "N/A")

    echo ""
done

# Generate comparison report
{
    echo "# Model Comparison Results"
    echo ""
    echo "**Generated:** $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""

    echo "## Summary"
    echo ""
    echo "| Model | Provider | Passed | Total | Accuracy | Avg Latency | Est. \$/mo |"
    echo "|-------|----------|--------|-------|----------|-------------|-----------|"

    for model in "${MODELS_TO_RUN[@]}"; do
        provider="Groq"
        [[ "$model" == cerebras-* ]] && provider="Cerebras"

        passed=${MODEL_TOTAL_PASSED[$model]:-0}
        total=${MODEL_TOTAL_TESTS[$model]:-0}
        pct="0.0"
        if [[ $total -gt 0 ]]; then
            pct=$(echo "scale=1; $passed * 100 / $total" | bc)
        fi
        latency=${MODEL_AVG_LATENCY[$model]:-0}
        monthly=${MODEL_MONTHLY[$model]:-N/A}

        echo "| $model | $provider | $passed | $total | ${pct}% | ${latency}ms | $monthly |"
    done

    echo ""
    echo "## Per-Benchmark Breakdown"
    echo ""

    echo "### MATH Mode"
    echo ""
    echo "| Model | math.sh (54) | math-edge.sh (57) | Total | Accuracy |"
    echo "|-------|--------------|-------------------|-------|----------|"
    for model in "${MODELS_TO_RUN[@]}"; do
        core=${MODEL_MATH_CORE[$model]:-0/54}
        edge=${MODEL_MATH_EDGE[$model]:-0/57}
        passed=${MODEL_MATH_PASSED[$model]:-0}
        total=${MODEL_MATH_TOTAL[$model]:-111}
        pct="0.0"
        if [[ $total -gt 0 ]]; then
            pct=$(echo "scale=1; $passed * 100 / $total" | bc)
        fi
        echo "| $model | $core | $edge | $passed/$total | ${pct}% |"
    done

    echo ""
    echo "### FACTUAL Mode"
    echo ""
    echo "| Model | factual.sh (52) | factual-edge.sh (52) | Total | Accuracy |"
    echo "|-------|-----------------|----------------------|-------|----------|"
    for model in "${MODELS_TO_RUN[@]}"; do
        core=${MODEL_FACT_CORE[$model]:-0/52}
        edge=${MODEL_FACT_EDGE[$model]:-0/52}
        passed=${MODEL_FACT_PASSED[$model]:-0}
        total=${MODEL_FACT_TOTAL[$model]:-104}
        pct="0.0"
        if [[ $total -gt 0 ]]; then
            pct=$(echo "scale=1; $passed * 100 / $total" | bc)
        fi
        echo "| $model | $core | $edge | $passed/$total | ${pct}% |"
    done

    echo ""
    echo "### GRAMMAR Mode"
    echo ""
    echo "| Model | word.sh (48) | word-edge.sh (47) | Total | Accuracy |"
    echo "|-------|--------------|-------------------|-------|----------|"
    for model in "${MODELS_TO_RUN[@]}"; do
        core=${MODEL_GRAM_CORE[$model]:-0/48}
        edge=${MODEL_GRAM_EDGE[$model]:-0/47}
        passed=${MODEL_GRAM_PASSED[$model]:-0}
        total=${MODEL_GRAM_TOTAL[$model]:-95}
        pct="0.0"
        if [[ $total -gt 0 ]]; then
            pct=$(echo "scale=1; $passed * 100 / $total" | bc)
        fi
        echo "| $model | $core | $edge | $passed/$total | ${pct}% |"
    done

    echo ""
    echo "### LINKED Mode"
    echo ""
    echo "| Model | word-link.sh (12) | Total | Accuracy |"
    echo "|-------|-------------------|-------|----------|"
    for model in "${MODELS_TO_RUN[@]}"; do
        core=${MODEL_LINK_CORE[$model]:-0/12}
        passed=${MODEL_LINK_PASSED[$model]:-0}
        total=${MODEL_LINK_TOTAL[$model]:-12}
        pct="0.0"
        if [[ $total -gt 0 ]]; then
            pct=$(echo "scale=1; $passed * 100 / $total" | bc)
        fi
        echo "| $model | $core | $passed/$total | ${pct}% |"
    done

    echo ""
    echo "## Cost Analysis"
    echo ""
    echo "Assuming 80 input tokens, 30 output tokens per request at 1,000 requests/day:"
    echo ""
    echo "| Model | Input \$/M | Output \$/M | Est. Monthly |"
    echo "|-------|-----------|------------|--------------|"
    echo "| groq-120b | \$0.15 | \$0.60 | \$0.90 |"
    echo "| groq-20b | \$0.075 | \$0.30 | \$0.45 |"
    echo "| cerebras-120b | \$0.35 | \$0.75 | \$1.52 |"
    echo "| cerebras-glm | \$2.25 | \$2.75 | \$7.88 |"

} > "$COMPARISON_FILE"

echo "=========================================="
echo "Comparison complete!"
echo "Results saved to: $COMPARISON_FILE"
echo "=========================================="
cat "$COMPARISON_FILE"
