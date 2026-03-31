#!/bin/bash

# LINKED mode benchmark - REFLEXIVE category
# Tests: I↔myself, she↔herself, they↔themselves

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

echo "=== First Person Reflexive ==="
# 0=I 1=hurt 2=myself
run_linked_test "I hurt myself" "0-2,2-0" "I/myself"
# 0=We 1=prepared 2=ourselves
run_linked_test "We prepared ourselves" "0-2,2-0" "we/ourselves"

echo ""
echo "=== Second Person Reflexive ==="
# 0=You 1=should 2=believe 3=in 4=yourself
run_linked_test "You should believe in yourself" "0-4,4-0" "you/yourself"

echo ""
echo "=== Third Person Reflexive ==="
# 0=She 1=taught 2=herself 3=piano
run_linked_test "She taught herself piano" "0-2,2-0" "she/herself"
# 0=He 1=injured 2=himself
run_linked_test "He injured himself" "0-2,2-0" "he/himself"
# 0=They 1=blamed 2=themselves
run_linked_test "They blamed themselves" "0-2,2-0" "they/themselves"
# 0=It 1=cleaned 2=itself
run_linked_test "It cleaned itself" "0-2,2-0" "it/itself"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
