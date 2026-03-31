#!/bin/bash

# LINKED mode benchmark - COMPARATIVE category
# Tests: taller↔than, most↔of/in

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

echo "=== Comparative + Than ==="
# 0=She 1=is 2=taller 3=than 4=him
run_linked_test "She is taller than him" "2-3,3-2" "taller/than"
# 0=This 1=is 2=better 3=than 4=that
run_linked_test "This is better than that" "2-3,3-2" "better/than"
# 0=He 1=runs 2=faster 3=than 4=me
run_linked_test "He runs faster than me" "2-3,3-2" "faster/than"
# 0=It 1=was 2=more 3=expensive 4=than 5=expected
run_linked_test "It was more expensive than expected" "2-4,4-2" "more/than"

echo ""
echo "=== Most/Least + Of ==="
# 0=The 1=most 2=beautiful 3=of 4=all
run_linked_test "The most beautiful of all" "1-3,3-1" "most/of"
# 0=She 1=is 2=the 3=least 4=experienced 5=of 6=all
run_linked_test "She is the least experienced of all" "3-5,5-3" "least/of"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
