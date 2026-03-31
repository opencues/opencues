#!/bin/bash

# FACTUAL mode benchmark - tests knowledge accuracy
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0
RESULTS=""

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
        RESULTS="$RESULTS\n✗ $desc"
    fi
}

echo "=== Tech Company Leaders ==="
run_test "The CEO of Apple is _" "Tim Cook" "Apple CEO"
run_test "The CEO of Microsoft is _" "Satya Nadella" "Microsoft CEO"
run_test "The CEO of Tesla is _" "Elon Musk" "Tesla CEO"
run_test "The CEO of Amazon is _" "Andy Jassy" "Amazon CEO"
run_test "The CEO of Google is _" "Sundar Pichai" "Google CEO"
run_test "The CEO of Meta is _" "Mark Zuckerberg" "Meta CEO"
run_test "The CEO of Netflix is _" "Ted Sarandos" "Netflix CEO"
run_test "The CEO of Nvidia is _" "Jensen Huang" "Nvidia CEO"

echo ""
echo "=== Tech Founders ==="
run_test "The founder of Amazon is _" "Jeff Bezos" "Amazon founder"
run_test "The founder of Facebook is _" "Mark Zuckerberg" "Facebook founder"
run_test "The founder of Microsoft is _" "Bill Gates" "Microsoft founder"
run_test "The founder of Apple is _" "Steve Jobs" "Apple founder"
run_test "The founder of SpaceX is _" "Elon Musk" "SpaceX founder"

echo ""
echo "=== World Capitals ==="
run_test "The capital of France is _" "Paris" "France capital"
run_test "The capital of Japan is _" "Tokyo" "Japan capital"
run_test "The capital of Australia is _" "Canberra" "Australia capital"
run_test "The capital of Brazil is _" "Brasilia" "Brazil capital"
run_test "The capital of Canada is _" "Ottawa" "Canada capital"
run_test "The capital of Germany is _" "Berlin" "Germany capital"
run_test "The capital of Italy is _" "Rome" "Italy capital"
run_test "The capital of Spain is _" "Madrid" "Spain capital"
run_test "The capital of China is _" "Beijing" "China capital"
run_test "The capital of India is _" "New Delhi" "India capital"

echo ""
echo "=== Chemical Symbols ==="
run_test "The chemical symbol for gold is _" "Au" "Gold symbol"
run_test "The chemical symbol for silver is _" "Ag" "Silver symbol"
run_test "The chemical symbol for iron is _" "Fe" "Iron symbol"
run_test "The chemical symbol for copper is _" "Cu" "Copper symbol"
run_test "The chemical symbol for sodium is _" "Na" "Sodium symbol"
run_test "The chemical symbol for potassium is _" "K" "Potassium symbol"

echo ""
echo "=== Historical Dates ==="
run_test "World War II ended in _" "1945" "WWII end"
run_test "The Berlin Wall fell in _" "1989" "Berlin Wall"
run_test "Man first walked on the moon in _" "1969" "Moon landing"
run_test "The Titanic sank in _" "1912" "Titanic"
run_test "World War I started in _" "1914" "WWI start"
run_test "The Declaration of Independence was signed in _" "1776" "US independence"
run_test "The French Revolution began in _" "1789" "French Revolution"

echo ""
echo "=== Science Facts ==="
run_test "Water boils at _ degrees Celsius" "100" "Water boiling"
run_test "Water freezes at _ degrees Celsius" "0" "Water freezing"
run_test "The speed of light is _ km/s" "299792" "Speed of light"
run_test "Absolute zero is _ Kelvin" "0" "Absolute zero"

echo ""
echo "=== Literature ==="
run_test "The author of 1984 is _" "George Orwell" "1984 author"
run_test "The author of Romeo and Juliet is _" "Shakespeare" "Shakespeare"
run_test "The author of Pride and Prejudice is _" "Jane Austen" "Austen"
run_test "The author of The Great Gatsby is _" "F. Scott Fitzgerald" "Fitzgerald"

echo ""
echo "=== Art ==="
run_test "The Mona Lisa was painted by _" "Leonardo da Vinci" "Mona Lisa"
run_test "The Starry Night was painted by _" "Van Gogh" "Starry Night"
run_test "The Scream was painted by _" "Edvard Munch" "The Scream"

echo ""
echo "=== Geography ==="
run_test "The largest ocean is the _" "Pacific" "Largest ocean"
run_test "The longest river is the _" "Nile" "Longest river"
run_test "The tallest mountain is _" "Everest" "Tallest mountain"
run_test "The largest desert is the _" "Sahara" "Largest desert"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [[ $FAILED -gt 0 ]]; then
    echo -e "Failed tests:$RESULTS"
fi
