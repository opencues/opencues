#!/bin/bash

# LINKED mode benchmark - NUMBER category
# Tests: this↔dog↔runs (singular) vs these↔dogs↔run (plural)

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

echo "=== Demonstrative + Noun + Verb ==="
# 0=This 1=dog 2=runs
run_linked_test "This dog runs" "0-1,0-2,1-2" "this/dog/runs"
# 0=These 1=dogs 2=run
run_linked_test "These dogs run" "0-1,0-2,1-2" "these/dogs/run"
# 0=That 1=cat 2=sleeps
run_linked_test "That cat sleeps" "0-1,0-2,1-2" "that/cat/sleeps"
# 0=Those 1=cats 2=sleep
run_linked_test "Those cats sleep" "0-1,0-2,1-2" "those/cats/sleep"

echo ""
echo "=== Distributive + Noun + Verb ==="
# 0=Each 1=student 2=writes
run_linked_test "Each student writes" "0-1,0-2,1-2" "each/student/writes"
# 0=Every 1=child 2=plays
run_linked_test "Every child plays" "0-1,0-2,1-2" "every/child/plays"
# 0=All 1=students 2=write
run_linked_test "All students write" "0-1,0-2,1-2" "all/students/write"
# 0=All 1=children 2=play
run_linked_test "All children play" "0-1,0-2,1-2" "all/children/play"

echo ""
echo "=== Article + Noun ==="
# 0=The 1=child 2=has 3=a 4=toy
run_linked_test "The child has a toy" "1-2,3-4" "child/has + a/toy"
# 0=The 1=children 2=have 3=some 4=toys
run_linked_test "The children have toys" "1-2" "children/have"

echo ""
echo "=== Subject + Be verb ==="
# 0=The 1=book 2=is 3=here
run_linked_test "The book is here" "1-2" "book/is"
# 0=The 1=books 2=are 3=here
run_linked_test "The books are here" "1-2" "books/are"
# 0=The 1=team 2=is 3=winning
run_linked_test "The team is winning" "1-2" "team/is (collective)"
# 0=The 1=teams 2=are 3=winning
run_linked_test "The teams are winning" "1-2" "teams/are"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
