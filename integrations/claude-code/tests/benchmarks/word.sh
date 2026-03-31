#!/bin/bash

# GRAMMAR mode benchmark - tests synonym/antonym quality
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0
RESULTS=""

# Test that a word has expected alternatives
# Usage: run_test "input sentence" word_index "expected_alt1,expected_alt2,..."
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
except Exception as e:
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
        RESULTS="$RESULTS\n✗ $desc"
    fi
}

echo "=== Basic Adjective Synonyms ==="
run_test "The happy boy ran" 1 "glad,joyful,cheerful,content,pleased" "happy synonyms"
run_test "The big house" 1 "large,huge,enormous,massive,giant" "big synonyms"
run_test "The old man" 1 "elderly,aged,ancient,senior,mature" "old synonyms"
run_test "A beautiful sunset" 1 "gorgeous,stunning,lovely,pretty,magnificent" "beautiful synonyms"
run_test "The small dog" 1 "tiny,little,miniature,petite,compact" "small synonyms"
run_test "A fast car" 1 "quick,rapid,speedy,swift,hasty" "fast synonyms"
run_test "The tall building" 1 "high,lofty,towering,elevated,soaring" "tall synonyms"
run_test "A cold day" 1 "chilly,freezing,icy,frigid,cool" "cold synonyms"

echo ""
echo "=== Basic Adjective Antonyms ==="
run_test "The happy child smiled" 1 "sad,unhappy,miserable,gloomy,sorrowful" "happy antonyms"
run_test "The hot day" 1 "cold,cool,chilly,freezing,frigid" "hot antonyms"
run_test "The tall man" 1 "short,small,low,little" "tall antonyms"
run_test "The bright light" 1 "dim,dark,dull,faint" "bright antonyms"
run_test "A young child" 1 "old,elderly,aged,mature" "young antonyms"
run_test "The loud noise" 1 "quiet,soft,silent,faint,hushed" "loud antonyms"
run_test "The easy test" 1 "hard,difficult,tough,challenging" "easy antonyms"
run_test "A clean room" 1 "dirty,messy,filthy,grimy" "clean antonyms"

echo ""
echo "=== Adverb Synonyms ==="
run_test "She walked quickly" 2 "fast,rapidly,swiftly,briskly,speedily" "quickly synonyms"
run_test "He spoke softly" 2 "quietly,gently,tenderly,faintly" "softly synonyms"
run_test "They moved slowly" 2 "gradually,leisurely,sluggishly,unhurriedly" "slowly synonyms"
run_test "She smiled happily" 2 "joyfully,gladly,cheerfully,merrily" "happily synonyms"
run_test "He waited patiently" 2 "calmly,quietly,stoically" "patiently synonyms"

echo ""
echo "=== Adverb Antonyms ==="
run_test "She ran fast" 2 "slow,slowly,sluggishly,leisurely" "fast antonyms"
run_test "He spoke loudly" 2 "quietly,softly,faintly,silently" "loudly antonyms"
run_test "They arrived early" 2 "late,tardily,belatedly" "early antonyms"

echo ""
echo "=== Verb Synonyms ==="
run_test "He ran to the store" 1 "sprinted,jogged,rushed,dashed,hurried" "ran synonyms"
run_test "She ate dinner" 1 "consumed,devoured,finished,had" "ate synonyms"
run_test "They walked home" 1 "strolled,wandered,marched,ambled,trudged" "walked synonyms"
run_test "He looked at me" 1 "gazed,stared,glanced,peered,watched" "looked synonyms"
run_test "She said goodbye" 1 "whispered,shouted,muttered,exclaimed,stated" "said synonyms"
run_test "He threw the ball" 1 "tossed,hurled,pitched,flung,launched" "threw synonyms"
run_test "She took the book" 1 "grabbed,seized,snatched,took,picked" "took synonyms"
run_test "They made dinner" 1 "prepared,cooked,created,fixed" "made synonyms"

echo ""
echo "=== Noun Synonyms ==="
run_test "The dog barked" 1 "hound,canine,mutt,pup,pooch" "dog synonyms"
run_test "The house was big" 1 "home,dwelling,residence,abode,building" "house synonyms"
run_test "The car stopped" 1 "vehicle,automobile,auto,machine" "car synonyms"
run_test "The kid laughed" 1 "child,youngster,youth,minor" "kid synonyms"
run_test "The road was long" 1 "street,path,highway,route,way" "road synonyms"

echo ""
echo "=== Emotion Words ==="
run_test "The angry man" 1 "furious,mad,irate,upset,enraged" "angry synonyms"
run_test "A scared child" 1 "frightened,afraid,terrified,fearful" "scared synonyms"
run_test "The sad story" 1 "depressing,tragic,sorrowful,melancholy" "sad synonyms"
run_test "An excited crowd" 1 "thrilled,eager,enthusiastic,animated" "excited synonyms"
run_test "A worried mother" 1 "concerned,anxious,troubled,uneasy" "worried synonyms"

echo ""
echo "=== Sensory Words ==="
run_test "A quiet room" 1 "silent,peaceful,calm,still,hushed" "quiet synonyms"
run_test "The smooth surface" 1 "soft,sleek,silky,even,polished" "smooth synonyms"
run_test "A rough texture" 1 "coarse,uneven,rugged,bumpy" "rough synonyms"
run_test "The sweet taste" 1 "sugary,honeyed,saccharine" "sweet synonyms"
run_test "A sharp knife" 1 "keen,pointed,cutting,razor" "sharp synonyms"
run_test "The bitter coffee" 1 "sour,harsh,acrid,acidic" "bitter synonyms"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [[ $FAILED -gt 0 ]]; then
    echo -e "Failed tests:$RESULTS"
fi
