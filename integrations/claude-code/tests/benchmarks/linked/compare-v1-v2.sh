#!/bin/bash
# Compare linked-v1 vs linked-v2 prompt accuracy

SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
V1_PROMPT="$HOME/tweakcc/system_prompts/linked.txt"
V2_PROMPT="$HOME/tweakcc/system_prompts/linked-v2.txt"

V1_PASSED=0
V2_PASSED=0
TOTAL=0

run_test() {
    local input="$1"
    local expected="$2"
    local desc="$3"

    ((TOTAL++))

    # Test V1
    echo "$input" > /tmp/word-test.txt
    LINKED_PROMPT="$V1_PROMPT" LLM_MODE=LINKED timeout 15 bash "$SCRIPT" /tmp/word-test.txt /tmp/word-result-v1.json 2>/dev/null
    local v1_result=$(cat /tmp/word-result-v1.json 2>/dev/null | python3 -c "
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

    # Test V2
    LINKED_PROMPT="$V2_PROMPT" LLM_MODE=LINKED timeout 15 bash "$SCRIPT" /tmp/word-test.txt /tmp/word-result-v2.json 2>/dev/null
    local v2_result=$(cat /tmp/word-result-v2.json 2>/dev/null | python3 -c "
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

    # Check V1
    local v1_pass="✗"
    IFS=',' read -ra EXPECTED <<< "$expected"
    for exp in "${EXPECTED[@]}"; do
        if [[ "$v1_result" == *"$exp"* ]]; then
            v1_pass="✓"
            ((V1_PASSED++))
            break
        fi
    done

    # Check V2
    local v2_pass="✗"
    for exp in "${EXPECTED[@]}"; do
        if [[ "$v2_result" == *"$exp"* ]]; then
            v2_pass="✓"
            ((V2_PASSED++))
            break
        fi
    done

    printf "%-40s | V1: %s %-15s | V2: %s %-15s\n" "$desc" "$v1_pass" "$v1_result" "$v2_pass" "$v2_result"
}

echo "=== Comparing linked.txt (V1) vs linked-v2.txt (V2) ==="
echo ""
printf "%-40s | %-22s | %-22s\n" "Test" "V1 (450 lines)" "V2 (130 lines)"
echo "-------------------------------------------------------------------"

echo ""
echo "--- GENDER ---"
run_test "The boy said he" "1-3,3-1" "boy/he"
run_test "The girl told her mother" "1-3,3-1" "girl/her"

echo ""
echo "--- NUMBER ---"
run_test "This dog runs" "0-1-2" "this/dog/runs"
run_test "These dogs run" "0-1-2" "these/dogs/run"

echo ""
echo "--- VERB ---"
run_test "She has arrived" "0-1,1-0" "she/has"
run_test "They have arrived" "0-1,1-0" "they/have"

echo ""
echo "--- TENSE ---"
run_test "Yesterday I walked" "0-2,2-0" "yesterday/walked"
run_test "Tomorrow I will walk" "0-2,2-0" "tomorrow/will"

echo ""
echo "--- POSSESSION ---"
run_test "John forgot his keys" "0-2,2-0" "John/his"

echo ""
echo "--- REFLEXIVE ---"
run_test "I hurt myself" "0-2,2-0" "I/myself"

echo ""
echo "--- NEGATION ---"
run_test "I don't have any" "1-3,3-1" "don't/any"

echo ""
echo "--- CONDITIONAL ---"
run_test "If I were rich I would travel" "0-2-5" "if/were/would"

echo ""
echo "--- CONCEPT: Profession+Place ---"
run_test "the doctor at the hospital" "1-4,4-1" "doctor/hospital"
run_test "the teacher at the school" "1-4,4-1" "teacher/school"
run_test "the nurse at the clinic" "1-4,4-1" "nurse/clinic (novel)"

echo ""
echo "--- CONCEPT: Animal+Habitat ---"
run_test "the fish in the water" "1-4,4-1" "fish/water"
run_test "the shark in the ocean" "1-4,4-1" "shark/ocean (novel)"

echo ""
echo "--- CONCEPT: Vehicle+Surface ---"
run_test "driving a car on the road" "2-5,5-2" "car/road"
run_test "paddling a kayak on the river" "2-5,5-2" "kayak/river (novel)"

echo ""
echo "--- CONCEPT: Technology ---"
run_test "building a website with HTML" "2-4,4-2" "website/HTML"
run_test "building a database with SQL" "2-4,4-2" "database/SQL (novel)"

echo ""
echo "--- CONCEPT: Activity+Tool ---"
run_test "cutting wood with a saw" "0-4,4-0" "cutting/saw"
run_test "digging holes with a shovel" "0-4,4-0" "digging/shovel (novel)"

echo ""
echo "--- CONCEPT: Creator+Creation ---"
run_test "Edison invented the lightbulb" "0-3,3-0" "Edison/lightbulb"
run_test "Shakespeare wrote Hamlet" "0-2,2-0" "Shakespeare/Hamlet"
run_test "Picasso painted Guernica" "0-2,2-0" "Picasso/Guernica (novel)"

echo ""
echo "--- CONCEPT: Names ---"
run_test "Elon Musk founded Tesla" "0-1,1-0,0-3,3-0" "Elon/Musk, founder/Tesla"
run_test "Tim Cook runs Apple" "0-1,1-0,0-3,3-0" "Tim/Cook, runs/Apple"

echo ""
echo "--- NO LINK (false positive tests) ---"
run_test "The cat sat on the mat" "none" "no link expected"
run_test "I like pizza and coffee" "none" "no link expected"
run_test "The red car is fast" "none" "no link expected"

echo ""
echo "=== RESULTS ==="
echo "V1 (450 lines): $V1_PASSED / $TOTAL"
echo "V2 (130 lines): $V2_PASSED / $TOTAL"

V1_PCT=$(echo "scale=1; $V1_PASSED * 100 / $TOTAL" | bc)
V2_PCT=$(echo "scale=1; $V2_PASSED * 100 / $TOTAL" | bc)
echo ""
echo "V1: ${V1_PCT}%"
echo "V2: ${V2_PCT}%"
