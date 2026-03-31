#!/bin/bash

# LINKED mode benchmark - QUANTITY category
# Tests: many↔books↔were vs much↔water↔was

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

echo "=== Count Nouns (many/few) ==="
# 0=Many 1=books 2=were 3=read
run_linked_test "Many books were read" "0-1,0-2,1-2" "many/books/were"
# 0=Few 1=people 2=came
run_linked_test "Few people came" "0-1,1-0" "few/people"
# 0=Several 1=students 2=passed
run_linked_test "Several students passed" "0-1,1-0" "several/students"

echo ""
echo "=== Mass Nouns (much/little) ==="
# 0=Much 1=water 2=was 3=spilled
run_linked_test "Much water was spilled" "0-1,0-2,1-2" "much/water/was"
# 0=Little 1=time 2=remains
run_linked_test "Little time remains" "0-1,0-2,1-2" "little/time/remains"

echo ""
echo "=== Fewer/Less ==="
# 0=Fewer 1=cars 2=are 3=here
run_linked_test "Fewer cars are here" "0-1,1-0" "fewer/cars"
# 0=Less 1=noise 2=is 3=needed
run_linked_test "Less noise is needed" "0-1,1-0" "less/noise"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
