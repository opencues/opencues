#!/bin/bash

# LINKED mode benchmark - TENSE category
# Tests: yesterday↔walked, tomorrow↔will, currently↔is

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

echo "=== Past Time + Past Verb ==="
# 0=Yesterday 1=I 2=walked 3=home
run_linked_test "Yesterday I walked home" "0-2,2-0" "yesterday/walked"
# 0=Last 1=week 2=they 3=visited 4=us
run_linked_test "Last week they visited us" "0-3,3-0" "last/visited"
# 0=Earlier 1=she 2=called 3=me
run_linked_test "Earlier she called me" "0-2,2-0" "earlier/called"

echo ""
echo "=== Future Time + Will ==="
# 0=Tomorrow 1=I 2=will 3=walk
run_linked_test "Tomorrow I will walk" "0-2,2-0" "tomorrow/will"
# 0=Next 1=week 2=we 3=will 4=move
run_linked_test "Next week we will move" "0-3,3-0" "next/will"
# 0=Soon 1=they 2=will 3=arrive
run_linked_test "Soon they will arrive" "0-2,2-0" "soon/will"

echo ""
echo "=== Present Time + Present Verb ==="
# 0=Currently 1=she 2=is 3=working
run_linked_test "Currently she is working" "0-2,2-0" "currently/is"
# 0=Now 1=they 2=are 3=playing
run_linked_test "Now they are playing" "0-2,2-0" "now/are"
# 0=Today 1=I 2=am 3=busy
run_linked_test "Today I am busy" "0-2,2-0" "today/am"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
