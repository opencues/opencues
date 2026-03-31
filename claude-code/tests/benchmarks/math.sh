#!/bin/bash

# MATH mode benchmark - tests computation accuracy
# Tests: percentages, arithmetic, word math
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0
RESULTS=""

run_test() {
    local input="$1"
    local expected="$2"
    local desc="$3"

    echo "$input" > /tmp/math-test.txt
    timeout 15 bash "$SCRIPT" /tmp/math-test.txt /tmp/math-result.json 2>/dev/null

    local result=$(cat /tmp/math-result.json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for w in d.get('words', []):
        if w.get('alts') and len(w['alts']) > 1:
            val = w['alts'][1]
            if '.' in str(val):
                val = str(float(val)).rstrip('0').rstrip('.')
            print(val)
            break
    else:
        print('null')
except:
    print('error')
" 2>/dev/null)

    local expected_norm=$(python3 -c "
v = '$expected'
if '.' in v:
    v = str(float(v)).rstrip('0').rstrip('.')
print(v)
")

    if [[ "$result" == "$expected_norm" ]]; then
        echo "✓ $desc: $result"
        ((PASSED++))
    else
        echo "✗ $desc: got '$result', expected '$expected_norm'"
        ((FAILED++))
        RESULTS="$RESULTS\n✗ $desc"
    fi
}

echo "=== Basic Arithmetic ==="
run_test "8 + 5 = _" "13" "addition"
run_test "20 - 7 = _" "13" "subtraction"
run_test "6 * 9 = _" "54" "multiplication"
run_test "72 / 8 = _" "9" "division"
run_test "15 + 23 = _" "38" "two digit add"
run_test "100 - 37 = _" "63" "two digit sub"
run_test "12 * 11 = _" "132" "two digit mul"
run_test "144 / 12 = _" "12" "two digit div"

echo ""
echo "=== Word Arithmetic ==="
run_test "five plus three = _" "8" "word addition"
run_test "twelve minus four = _" "8" "word subtraction"
run_test "seven times eight = _" "56" "word multiplication"
run_test "twenty divided by five = _" "4" "word division"
run_test "nine plus eleven = _" "20" "teens addition"
run_test "fifteen times two = _" "30" "teen multiply"

echo ""
echo "=== Half/Double/Triple ==="
run_test "half of 50 = _" "25" "half"
run_test "double 35 = _" "70" "double"
run_test "triple 12 = _" "36" "triple"
run_test "half of 99 = _" "49.5" "half decimal"
run_test "double 0.5 = _" "1" "double decimal"
run_test "quadruple 8 = _" "32" "quadruple"

echo ""
echo "=== Sales Tax ==="
run_test "100 plus 10% tax = _" "110" "10% tax"
run_test "50 plus 8% tax = _" "54" "8% tax"
run_test "200 plus 5% tax = _" "210" "5% tax"
run_test "75 plus 6% tax = _" "79.5" "6% tax"
run_test "125 plus 9% tax = _" "136.25" "9% tax"
run_test "80 plus 7% sales tax = _" "85.6" "7% sales tax"

echo ""
echo "=== VAT ==="
run_test "100 plus 20% VAT = _" "120" "20% VAT"
run_test "50 plus 19% VAT = _" "59.5" "19% VAT"
run_test "150 plus 21% VAT = _" "181.5" "21% VAT"
run_test "90 plus 23% VAT = _" "110.7" "23% VAT"

echo ""
echo "=== Discounts ==="
run_test "100 minus 10% = _" "90" "10% off"
run_test "80 with 25% off = _" "60" "25% off"
run_test "200 with 15% off = _" "170" "15% off"
run_test "60 minus 20% discount = _" "48" "20% discount"
run_test "250 with 30% off = _" "175" "30% off"

echo ""
echo "=== Tips ==="
run_test "50 plus 15% tip = _" "57.5" "15% tip"
run_test "80 plus 20% tip = _" "96" "20% tip"
run_test "35 plus 18% tip = _" "41.3" "18% tip"
run_test "100 plus 22% tip = _" "122" "22% tip"
run_test "65 plus 12% gratuity = _" "72.8" "12% gratuity"

echo ""
echo "=== Percentage Of ==="
run_test "10% of 200 = _" "20" "10% of"
run_test "25% of 80 = _" "20" "25% of"
run_test "15% of 300 = _" "45" "15% of"
run_test "50% of 120 = _" "60" "50% of"
run_test "5% of 500 = _" "25" "5% of"

echo ""
echo "=== Splitting ==="
run_test "split 100 between 4 people = _" "25" "split 4 ways"
run_test "divide 150 by 3 = _" "50" "divide 3 ways"
run_test "share 200 among 5 = _" "40" "share 5 ways"
run_test "split 90 three ways = _" "30" "three ways"

echo ""
echo "=== Combined Operations ==="
run_test "3 + 4 * 2 = _" "11" "order of ops"
run_test "(5 + 3) * 2 = _" "16" "parentheses"
run_test "10 * 10 - 50 = _" "50" "mul then sub"
run_test "100 / 5 + 20 = _" "40" "div then add"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
if [[ $FAILED -gt 0 ]]; then
    echo -e "Failed tests:$RESULTS"
fi
