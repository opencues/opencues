#!/bin/bash

# FACTUAL mode edge cases - obscure facts, multi-word answers
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0

run_test() {
    local input="$1"
    local expected="$2"
    local desc="$3"

    echo "$input" > /tmp/factual-test.txt
    timeout 15 bash "$SCRIPT" /tmp/factual-test.txt /tmp/factual-result.json 2>/dev/null

    local result=$(cat /tmp/factual-result.json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for w in d.get('words', []):
        if w.get('alts') and len(w['alts']) > 1:
            print(w['alts'][1].lower())
            break
    else:
        print('null')
except:
    print('error')
" 2>/dev/null)

    local expected_lower=$(echo "$expected" | tr '[:upper:]' '[:lower:]')

    if [[ "$result" == *"$expected_lower"* ]]; then
        echo "✓ $desc: $result"
        ((PASSED++))
    else
        echo "✗ $desc: got '$result', expected '$expected'"
        ((FAILED++))
    fi
}

echo "=== Lesser-Known Capitals ==="
run_test "The capital of Myanmar is _" "Naypyidaw" "Myanmar capital"
run_test "The capital of Kazakhstan is _" "Astana" "Kazakhstan capital"
run_test "The capital of Sri Lanka is _" "Sri Jayawardenepura Kotte" "Sri Lanka capital"
run_test "The capital of Nigeria is _" "Abuja" "Nigeria capital"
run_test "The capital of Turkey is _" "Ankara" "Turkey capital"
run_test "The capital of South Africa is _" "Pretoria" "South Africa capital"
run_test "The capital of Pakistan is _" "Islamabad" "Pakistan capital"
run_test "The capital of Morocco is _" "Rabat" "Morocco capital"

echo ""
echo "=== Scientific Constants ==="
run_test "Pi equals approximately _" "3.14159" "Pi value"
run_test "Euler's number e is approximately _" "2.718" "Euler's number"
run_test "Avogadro's number is _ x 10^23" "6.022" "Avogadro"
run_test "The golden ratio is approximately _" "1.618" "Golden ratio"

echo ""
echo "=== Atomic Numbers ==="
run_test "The atomic number of hydrogen is _" "1" "Hydrogen"
run_test "The atomic number of carbon is _" "6" "Carbon"
run_test "The atomic number of oxygen is _" "8" "Oxygen"
run_test "The atomic number of nitrogen is _" "7" "Nitrogen"
run_test "The atomic number of helium is _" "2" "Helium"

echo ""
echo "=== Tech History ==="
run_test "ChatGPT was created by _" "OpenAI" "ChatGPT"
run_test "The iPhone was first released in _" "2007" "iPhone release"
run_test "The World Wide Web was invented by _" "Tim Berners-Lee" "WWW inventor"
run_test "Linux was created by _" "Linus Torvalds" "Linux creator"
run_test "Python was created by _" "Guido van Rossum" "Python creator"

echo ""
echo "=== Astronomy ==="
run_test "The largest planet is _" "Jupiter" "Largest planet"
run_test "The smallest planet is _" "Mercury" "Smallest planet"
run_test "The closest planet to the Sun is _" "Mercury" "Closest to Sun"
run_test "The red planet is _" "Mars" "Red planet"
run_test "The number of planets in our solar system is _" "8" "Planet count"

echo ""
echo "=== Human Body ==="
run_test "The human body has _ bones" "206" "Human bones"
run_test "The largest organ is the _" "skin" "Largest organ"
run_test "The human heart has _ chambers" "4" "Heart chambers"
run_test "Normal body temperature is _ degrees Fahrenheit" "98.6" "Body temp F"
run_test "Normal body temperature is _ degrees Celsius" "37" "Body temp C"

echo ""
echo "=== Numbers ==="
run_test "There are _ continents" "7" "Continents"
run_test "A year has _ days" "365" "Days in year"
run_test "A decade has _ years" "10" "Years in decade"
run_test "A century has _ years" "100" "Years in century"
run_test "A millennium has _ years" "1000" "Years in millennium"

echo ""
echo "=== US Presidents ==="
run_test "The first President of the USA was _" "George Washington" "First president"
run_test "Abraham Lincoln was the _ president" "16th" "Lincoln number"
run_test "The president during WWII was _" "Franklin Roosevelt" "FDR"

echo ""
echo "=== Inventors ==="
run_test "The inventor of the telephone is _" "Alexander Graham Bell" "Telephone"
run_test "The inventor of the light bulb is _" "Thomas Edison" "Light bulb"
run_test "The inventor of the airplane is _" "Wright Brothers" "Airplane"
run_test "The inventor of the printing press is _" "Gutenberg" "Printing press"

echo ""
echo "=== Composers ==="
run_test "The composer of Fur Elise is _" "Beethoven" "Fur Elise"
run_test "The composer of The Four Seasons is _" "Vivaldi" "Four Seasons"
run_test "The composer of The Nutcracker is _" "Tchaikovsky" "Nutcracker"

echo ""
echo "=== Abbreviations ==="
run_test "NASA stands for National _ and Space Administration" "Aeronautics" "NASA"
run_test "The UN headquarters is in _" "New York" "UN HQ"
run_test "FBI stands for Federal Bureau of _" "Investigation" "FBI"
run_test "CIA stands for Central _ Agency" "Intelligence" "CIA"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
