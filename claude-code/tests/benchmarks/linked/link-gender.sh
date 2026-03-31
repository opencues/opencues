#!/bin/bash

# LINKED mode benchmark - GENDER category
# Tests: boy↔he, girl↔she, man↔his, woman↔her linking
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0
TOTAL_TIME=0
COUNT=0

# Test that linked arrays are populated correctly
run_linked_test() {
    local input="$1"
    local expected_links="$2"  # Format: "1-3,4-6" meaning index 1 links to 3, index 4 links to 6
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

    # Check if any expected link is found
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

echo "=== Gender-Linked Words (boy/girl ↔ he/she/him/her) ==="
# Indices: 0=The 1=boy 2=said 3=he 4=was 5=happy
run_linked_test "The boy said he was happy" "1-3,3-1" "boy/he linking"
# Indices: 0=The 1=girl 2=told 3=her 4=mother
run_linked_test "The girl told her mother" "1-3,3-1" "girl/her linking"
# Indices: 0=The 1=man 2=walked 3=with 4=his 5=dog
run_linked_test "The man walked with his dog" "1-4,4-1" "man/his linking"
# Indices: 0=The 1=woman 2=picked 3=up 4=her 5=bag
run_linked_test "The woman picked up her bag" "1-4,4-1" "woman/her linking"

echo ""
echo "=== Pronoun Chains ==="
# Indices: 0=He 1=gave 2=him 3=the 4=book
run_linked_test "He gave him the book" "0-2,2-0" "he/him linking"
# Indices: 0=She 1=helped 2=her 3=friend
run_linked_test "She helped her friend" "0-2,2-0" "she/her linking"
# Indices: 0=The 1=boy 2=hurt 3=himself
run_linked_test "The boy hurt himself" "1-3,3-1" "boy/himself linking"
# Indices: 0=The 1=girl 2=saw 3=herself
run_linked_test "The girl saw herself" "1-3,3-1" "girl/herself linking"

echo ""
echo "=== Multiple Pronouns ==="
# Indices: 0=The 1=boy 2=said 3=he 4=hurt 5=his 6=arm
run_linked_test "The boy said he hurt his arm" "1-3,1-5,3-5" "boy/he/his chain"
# Indices: 0=The 1=girl 2=told 3=her 4=friend 5=she 6=was 7=tired
run_linked_test "The girl told her friend she was tired" "1-3,1-5,3-5" "girl/her/she chain"

echo ""
echo "=== Mixed Genders (no linking expected) ==="
# These should NOT have links between different genders
run_linked_test "The boy helped the girl" "none" "boy/girl no link"
run_linked_test "He talked to her" "none" "he/her no link"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
