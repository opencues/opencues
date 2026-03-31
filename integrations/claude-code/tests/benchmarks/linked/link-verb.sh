#!/bin/bash

# LINKED mode benchmark - VERB (subject-verb agreement) category
# Tests: she↔has vs they↔have

SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0
TOTAL_TIME=0
COUNT=0

run_linked_test() {
    local input="$1"
    local expected_links="$2"
    local desc="$3"

    local start_time=$(date +%s%3N)

    echo "$input" > /tmp/word-test.txt
    LLM_MODE=LINKED timeout 15 bash "$SCRIPT" /tmp/word-test.txt /tmp/word-result.json 2>/dev/null

    local end_time=$(date +%s%3N)
    local elapsed=$((end_time - start_time))
    TOTAL_TIME=$((TOTAL_TIME + elapsed))
    ((COUNT++))

    local result=$(cat /tmp/word-result.json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    links = []
    for w in d.get('words', []):
        if w.get('linked'):
            for l in w['linked']:
                pair = f\"{w['index']}-{l}\"
                if pair not in links:
                    links.append(pair)
    print(','.join(sorted(links)) if links else 'none')
except:
    print('error')
" 2>/dev/null)

    local found=0
    IFS=',' read -ra EXPECTED <<< "$expected_links"
    for exp in "${EXPECTED[@]}"; do
        if [[ "$result" == *"$exp"* ]]; then
            found=1
            break
        fi
    done

    if [[ $found -eq 1 ]]; then
        echo "✓ $desc: found '$result'"
        ((PASSED++))
    else
        echo "✗ $desc: got '$result', expected one of '$expected_links'"
        ((FAILED++))
    fi
}

echo "=== Pronoun + Has/Have ==="
# 0=She 1=has 2=arrived
run_linked_test "She has arrived" "0-1" "she/has"
# 0=They 1=have 2=arrived
run_linked_test "They have arrived" "0-1" "they/have"
# 0=He 1=has 2=finished
run_linked_test "He has finished" "0-1" "he/has"
# 0=We 1=have 2=finished
run_linked_test "We have finished" "0-1" "we/have"

echo ""
echo "=== Pronoun + Is/Are ==="
# 0=She 1=is 2=happy
run_linked_test "She is happy" "0-1" "she/is"
# 0=They 1=are 2=happy
run_linked_test "They are happy" "0-1" "they/are"
# 0=It 1=is 2=working
run_linked_test "It is working" "0-1" "it/is"

echo ""
echo "=== Pronoun + Does/Do ==="
# 0=She 1=does 2=know
run_linked_test "She does know" "0-1" "she/does"
# 0=They 1=do 2=know
run_linked_test "They do know" "0-1" "they/do"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
