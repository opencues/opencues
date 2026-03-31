#!/bin/bash

# LINKED mode benchmark - CONDITIONAL category
# Tests: if↔were↔would, if↔is↔will

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

echo "=== Unreal Conditional (were/would) ==="
# 0=If 1=I 2=were 3=rich 4=I 5=would 6=travel
run_linked_test "If I were rich I would travel" "0-2,0-5,2-5" "if/were/would"
# 0=If 1=she 2=were 3=here 4=she 5=would 6=help
run_linked_test "If she were here she would help" "0-2,0-5,2-5" "if/were/would"

echo ""
echo "=== Real Conditional (is/will) ==="
# 0=If 1=she 2=is 3=ready 4=she 5=will 6=leave
run_linked_test "If she is ready she will leave" "0-2,0-5,2-5" "if/is/will"
# 0=If 1=it 2=rains 3=we 4=will 5=stay
run_linked_test "If it rains we will stay" "0-2,0-4,2-4" "if/rains/will"

echo ""
echo "=== Unless ==="
# 0=Unless 1=you 2=try 3=you 4=won't 5=succeed
run_linked_test "Unless you try you won't succeed" "0-2,0-4,2-4" "unless/try/won't"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
