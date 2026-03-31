#!/bin/bash

# LINKED mode benchmark - DETERMINER category
# Tests: a↔dog vs some↔dogs, each↔child vs all↔children

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

echo "=== Indefinite Articles ==="
# 0=A 1=dog 2=barked
run_linked_test "A dog barked" "0-1,1-0" "a/dog"
# 0=An 1=apple 2=fell
run_linked_test "An apple fell" "0-1,1-0" "an/apple"

echo ""
echo "=== Every/Each (singular) ==="
# 0=Every 1=child 2=deserves 3=care
run_linked_test "Every child deserves care" "0-1,0-2,1-2" "every/child/deserves"
# 0=Each 1=student 2=has 3=a 4=book
run_linked_test "Each student has a book" "0-1,0-2,1-2" "each/student/has"

echo ""
echo "=== All (plural) ==="
# 0=All 1=children 2=deserve 3=care
run_linked_test "All children deserve care" "0-1,0-2,1-2" "all/children/deserve"
# 0=All 1=students 2=have 3=books
run_linked_test "All students have books" "0-1,0-2,1-2" "all/students/have"

echo ""
echo "=== Some/Any ==="
# 0=Some 1=people 2=came
run_linked_test "Some people came" "0-1,1-0" "some/people"
# 0=Any 1=person 2=can 3=enter
run_linked_test "Any person can enter" "0-1,1-0" "any/person"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
