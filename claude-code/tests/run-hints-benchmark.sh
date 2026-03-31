#!/bin/bash
# HINTS Mode Benchmark Script
# Tests the accuracy of hint matching against expected results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_FILE="$SCRIPT_DIR/hints-test-cases.txt"
RESULTS_DIR="$SCRIPT_DIR/results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/hints-${LLM_MODEL:-groq-120b}-$TIMESTAMP.txt"

mkdir -p "$RESULTS_DIR"

TOTAL=0
CORRECT=0
PARTIAL=0
WRONG=0

echo "HINTS Mode Benchmark - $(date)" | tee "$RESULT_FILE"
echo "Model: ${LLM_MODEL:-groq-120b}" | tee -a "$RESULT_FILE"
echo "========================================" | tee -a "$RESULT_FILE"

while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip empty lines and comments
    [[ -z "$line" || "$line" =~ ^# ]] && continue

    # Parse: INPUT | EXPECTED | DESCRIPTION
    INPUT=$(echo "$line" | cut -d'|' -f1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    EXPECTED=$(echo "$line" | cut -d'|' -f2 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    DESC=$(echo "$line" | cut -d'|' -f3 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    [[ -z "$INPUT" ]] && continue

    ((TOTAL++))

    # Run HINTS analysis
    echo "$INPUT" > /tmp/hints-bench-input.txt
    rm -f /tmp/hints-bench-output.json
    LLM_MODE=HINTS bash ~/.claude/llm-analyze-auto.sh /tmp/hints-bench-input.txt /tmp/hints-bench-output.json 2>/dev/null
    sleep 2

    # Extract hint results using node
    RESULT=""
    if [[ -f /tmp/hints-bench-output.json ]]; then
        RESULT=$(node -e "
            try {
                const data = require('/tmp/hints-bench-output.json');
                const hints = data.words.filter(w => w.claudelogTipId).map(w => w.index + ':' + w.claudelogTipId);
                console.log(hints.length > 0 ? hints.join(',') : 'none');
            } catch(e) { console.log('none'); }
        " 2>/dev/null || echo "none")
        rm -f /tmp/hints-bench-output.json
    else
        RESULT="none"
    fi

    # Normalize expected and result
    [[ -z "$RESULT" ]] && RESULT="none"
    [[ "$EXPECTED" == "" ]] && EXPECTED="none"

    # Compare results
    if [[ "$EXPECTED" == "none" && "$RESULT" == "none" ]]; then
        STATUS="PASS"
        ((CORRECT++))
    elif [[ "$EXPECTED" == "none" && "$RESULT" != "none" ]]; then
        STATUS="FALSE_POS"
        ((WRONG++))
    elif [[ "$EXPECTED" != "none" && "$RESULT" == "none" ]]; then
        STATUS="MISS"
        ((WRONG++))
    else
        # Both have hints - compare
        EXP_SORTED=$(echo "$EXPECTED" | tr ',' '\n' | sort | tr '\n' ',' | sed 's/,$//')
        RES_SORTED=$(echo "$RESULT" | tr ',' '\n' | sort | tr '\n' ',' | sed 's/,$//')

        if [[ "$EXP_SORTED" == "$RES_SORTED" ]]; then
            STATUS="PASS"
            ((CORRECT++))
        else
            # Check for partial match (at least one correct hint)
            PARTIAL_MATCH=0
            for exp in $(echo "$EXPECTED" | tr ',' ' '); do
                if echo ",$RESULT," | grep -q ",$exp,"; then
                    PARTIAL_MATCH=1
                    break
                fi
            done
            if [[ $PARTIAL_MATCH -eq 1 ]]; then
                STATUS="PARTIAL"
                ((PARTIAL++))
            else
                STATUS="WRONG"
                ((WRONG++))
            fi
        fi
    fi

    echo "" | tee -a "$RESULT_FILE"
    echo "[$STATUS] $DESC" | tee -a "$RESULT_FILE"
    echo "  Input: \"$INPUT\"" | tee -a "$RESULT_FILE"
    echo "  Expected: $EXPECTED" | tee -a "$RESULT_FILE"
    echo "  Got: $RESULT" | tee -a "$RESULT_FILE"

done < "$TEST_FILE"

echo "" | tee -a "$RESULT_FILE"
echo "========================================" | tee -a "$RESULT_FILE"
echo "RESULTS SUMMARY" | tee -a "$RESULT_FILE"
echo "Total: $TOTAL" | tee -a "$RESULT_FILE"
echo "Correct: $CORRECT ($(( CORRECT * 100 / TOTAL ))%)" | tee -a "$RESULT_FILE"
echo "Partial: $PARTIAL ($(( PARTIAL * 100 / TOTAL ))%)" | tee -a "$RESULT_FILE"
echo "Wrong/Miss: $WRONG ($(( WRONG * 100 / TOTAL ))%)" | tee -a "$RESULT_FILE"
echo "Accuracy (full+partial): $(( (CORRECT + PARTIAL) * 100 / TOTAL ))%" | tee -a "$RESULT_FILE"

rm -f /tmp/hints-bench-input.txt
