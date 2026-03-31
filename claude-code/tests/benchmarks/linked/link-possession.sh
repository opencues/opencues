#!/bin/bash

# LINKED mode benchmark - POSSESSION category
# Tests: John↔his, Mary↔her, dog↔its, they↔their

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

echo "=== Name + Possessive ==="
# 0=John 1=forgot 2=his 3=keys
run_linked_test "John forgot his keys" "0-2,2-0" "John/his"
# 0=Mary 1=lost 2=her 3=wallet
run_linked_test "Mary lost her wallet" "0-2,2-0" "Mary/her"
# 0=Tom 1=found 2=his 3=phone
run_linked_test "Tom found his phone" "0-2,2-0" "Tom/his"

echo ""
echo "=== Pronoun + Possessive ==="
# 0=I 1=lost 2=my 3=phone
run_linked_test "I lost my phone" "0-2,2-0" "I/my"
# 0=We 1=finished 2=our 3=project
run_linked_test "We finished our project" "0-2,2-0" "we/our"
# 0=They 1=cleaned 2=their 3=room
run_linked_test "They cleaned their room" "0-2,2-0" "they/their"
# 0=You 1=forgot 2=your 3=bag
run_linked_test "You forgot your bag" "0-2,2-0" "you/your"

echo ""
echo "=== Noun + Its ==="
# 0=The 1=dog 2=wagged 3=its 4=tail
run_linked_test "The dog wagged its tail" "1-3,3-1" "dog/its"
# 0=The 1=cat 2=licked 3=its 4=paw
run_linked_test "The cat licked its paw" "1-3,3-1" "cat/its"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
