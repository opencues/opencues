#!/bin/bash

# GRAMMAR mode edge cases - context, compounds, formal words
# Note: Linked word tests are in word-link.sh
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0

run_test() {
    local input="$1"
    local word_idx="$2"
    local expected="$3"
    local desc="$4"

    echo "$input" > /tmp/word-test.txt
    timeout 15 bash "$SCRIPT" /tmp/word-test.txt /tmp/word-result.json 2>/dev/null

    local result=$(cat /tmp/word-result.json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    idx = $word_idx
    for w in d.get('words', []):
        if w.get('index') == idx and w.get('alts'):
            alts = w['alts'][1:] if len(w['alts']) > 1 else []
            print(','.join(alts[:3]).lower())
            break
    else:
        print('none')
except:
    print('error')
" 2>/dev/null)

    local found=0
    IFS=',' read -ra EXPECTED <<< "$expected"
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
        echo "✗ $desc: got '$result', expected one of '$expected'"
        ((FAILED++))
    fi
}

echo "=== Uncommon/Formal Words ==="
run_test "The ephemeral beauty" 1 "fleeting,transient,brief,temporary,momentary" "ephemeral"
run_test "A ubiquitous presence" 1 "common,widespread,pervasive,omnipresent,universal" "ubiquitous"
run_test "The cacophony of sounds" 1 "noise,din,racket,discord,clamor" "cacophony"
run_test "An enigmatic smile" 1 "mysterious,puzzling,cryptic,ambiguous" "enigmatic"
run_test "A meticulous worker" 1 "careful,precise,thorough,painstaking,detailed" "meticulous"
run_test "The arduous journey" 1 "difficult,hard,tough,strenuous,demanding" "arduous"
run_test "A benevolent ruler" 1 "kind,generous,compassionate,charitable" "benevolent"
run_test "The clandestine meeting" 1 "secret,covert,hidden,stealthy" "clandestine"

echo ""
echo "=== Contextual Meaning (Polysemy) ==="
run_test "He ran the company" 1 "managed,led,operated,directed,headed" "ran (manage)"
run_test "The bank was steep" 1 "slope,edge,embankment,shore,riverbank" "bank (riverbank)"
run_test "She felt blue" 2 "sad,down,unhappy,melancholy,depressed" "blue (sad)"
run_test "The bat flew away" 1 "animal,creature,mammal" "bat (animal)"
run_test "He broke his record" 2 "achievement,mark,score,best" "record (achievement)"
run_test "The spring was cold" 1 "fountain,source,well,stream" "spring (water)"
run_test "She gave a light touch" 2 "gentle,soft,delicate,faint" "light (gentle)"
run_test "The fair price" 1 "reasonable,just,equitable,honest" "fair (reasonable)"

echo ""
echo "=== Words with Modifiers ==="
run_test "The extremely fast car" 2 "quick,rapid,speedy,swift" "fast with extremely"
run_test "A very small house" 2 "tiny,little,miniature,compact" "small with very"
run_test "The incredibly beautiful sunset" 2 "gorgeous,stunning,lovely,magnificent" "beautiful with incredibly"
run_test "A particularly bright star" 2 "luminous,radiant,brilliant,shining" "bright with particularly"
run_test "The exceptionally cold winter" 2 "freezing,frigid,icy,bitter" "cold with exceptionally"

echo ""
echo "=== Compound/Hyphenated Words ==="
run_test "The well-known actor" 1 "famous,celebrated,renowned,popular" "well-known"
run_test "A high-quality product" 1 "premium,superior,excellent,first-rate" "high-quality"
run_test "The long-lasting effect" 1 "enduring,durable,permanent,persistent" "long-lasting"
run_test "A hard-working student" 1 "diligent,industrious,dedicated,tireless" "hard-working"
run_test "The fast-moving train" 1 "rapid,quick,speedy,swift" "fast-moving"

echo ""
echo "=== Prefixed Words (Un-, In-, Dis-) ==="
run_test "The unhappy child" 1 "happy,joyful,content,cheerful,pleased" "unhappy antonym"
run_test "An impossible task" 1 "possible,doable,achievable,feasible" "impossible antonym"
run_test "The uncomfortable chair" 1 "comfortable,cozy,pleasant,relaxing" "uncomfortable"
run_test "An unsuccessful attempt" 1 "successful,winning,effective,triumphant" "unsuccessful"
run_test "The invisible man" 1 "visible,seen,apparent,noticeable" "invisible"
run_test "An incomplete work" 1 "complete,finished,done,whole" "incomplete"

echo ""
echo "=== Abstract Concepts ==="
run_test "The justice prevailed" 1 "fairness,equity,righteousness,law" "justice"
run_test "A sense of freedom" 3 "liberty,independence,autonomy" "freedom"
run_test "The truth emerged" 1 "fact,reality,verity,honesty" "truth"
run_test "A feeling of hope" 3 "optimism,expectation,faith,aspiration" "hope"
run_test "The love was strong" 1 "affection,devotion,passion,adoration" "love"

echo ""
echo "=== Modern/Tech Words ==="
run_test "A viral video" 1 "trending,popular,famous,widespread" "viral"
run_test "He ghosted her" 1 "ignored,avoided,abandoned,ditched" "ghosted"
run_test "The data was stored" 1 "information,records,files,details" "data"
run_test "A digital copy" 1 "electronic,virtual,computerized,online" "digital"
run_test "The online store" 1 "web,internet,virtual,digital" "online"

echo ""
echo "=== Action Verbs (Strong) ==="
run_test "He demolished the wall" 1 "destroyed,obliterated,razed,wrecked" "demolished"
run_test "She whispered a secret" 1 "murmured,muttered,breathed,hissed" "whispered"
run_test "They sprinted away" 1 "ran,dashed,bolted,rushed,raced" "sprinted"
run_test "He shattered the glass" 1 "broke,smashed,cracked,fragmented" "shattered"
run_test "She embraced him" 1 "hugged,held,clasped,squeezed" "embraced"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
