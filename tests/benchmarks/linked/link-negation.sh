#!/bin/bash

# LINKED mode benchmark - NEGATION category
# Tests: don't↔any vs do↔some, nobody↔ever vs somebody↔always

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

echo "=== Negative Verb + Any ==="
# 0=I 1=don't 2=have 3=any 4=money
run_linked_test "I don't have any money" "1-3,3-1" "don't/any"
# 0=She 1=can't 2=find 3=anything
run_linked_test "She can't find anything" "1-3,3-1" "can't/anything"
# 0=They 1=won't 2=accept 3=any 4=excuse
run_linked_test "They won't accept any excuse" "1-3,3-1" "won't/any"

echo ""
echo "=== Nobody/Nothing + Ever ==="
# 0=Nobody 1=ever 2=came
run_linked_test "Nobody ever came" "0-1,1-0" "nobody/ever"
# 0=Nothing 1=ever 2=works
run_linked_test "Nothing ever works" "0-1,1-0" "nothing/ever"
# 0=No 1=one 2=ever 3=saw 4=him
run_linked_test "No one ever saw him" "0-2,2-0" "no one/ever"

echo ""
echo "=== Nowhere/Anywhere ==="
# 0=He 1=can't 2=go 3=anywhere
run_linked_test "He can't go anywhere" "1-3,3-1" "can't/anywhere"
# 0=She 1=doesn't 2=go 3=anywhere
run_linked_test "She doesn't go anywhere" "1-3,3-1" "doesn't/anywhere"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
