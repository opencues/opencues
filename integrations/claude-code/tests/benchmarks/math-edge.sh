#!/bin/bash

# MATH mode edge cases - decimals, large numbers, powers, word forms
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PASSED=0
FAILED=0

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
    fi
}

echo "=== Word Form Arithmetic ==="
run_test "four times four = _" "16" "four squared"
run_test "six times seven = _" "42" "six times seven"
run_test "eight times nine = _" "72" "eight times nine"
run_test "three times eleven = _" "33" "three times eleven"
run_test "five times twelve = _" "60" "five times twelve"
run_test "two times two times two = _" "8" "chained multiply"

echo ""
echo "=== Symbolic Arithmetic ==="
run_test "4 x 4 = _" "16" "4 x 4"
run_test "7 x 8 = _" "56" "7 x 8"
run_test "9 x 9 = _" "81" "9 x 9"
run_test "12 x 12 = _" "144" "12 x 12"
run_test "25 x 4 = _" "100" "25 x 4"

echo ""
echo "=== Decimal Operations ==="
run_test "3.5 + 2.5 = _" "6" "decimal add"
run_test "10.5 - 4.3 = _" "6.2" "decimal sub"
run_test "2.5 * 4 = _" "10" "decimal mul"
run_test "15.6 / 3 = _" "5.2" "decimal div"
run_test "0.1 + 0.2 = _" "0.3" "small decimals"
run_test "99.99 + 0.01 = _" "100" "decimal to whole"

echo ""
echo "=== Large Numbers ==="
run_test "1000 + 2000 = _" "3000" "thousands add"
run_test "5000 - 1500 = _" "3500" "thousands sub"
run_test "100 * 100 = _" "10000" "hundred squared"
run_test "10000 / 100 = _" "100" "divide thousands"
run_test "999 + 1 = _" "1000" "rollover"

echo ""
echo "=== Powers ==="
run_test "2 to the power of 3 = _" "8" "2 cubed"
run_test "3 to the power of 3 = _" "27" "3 cubed"
run_test "2 to the power of 10 = _" "1024" "2^10"
run_test "5 squared = _" "25" "5 squared"
run_test "10 squared = _" "100" "10 squared"
run_test "4 cubed = _" "64" "4 cubed"

echo ""
echo "=== Roots ==="
run_test "square root of 16 = _" "4" "sqrt 16"
run_test "square root of 81 = _" "9" "sqrt 81"
run_test "square root of 100 = _" "10" "sqrt 100"
run_test "square root of 144 = _" "12" "sqrt 144"
run_test "cube root of 27 = _" "3" "cbrt 27"
run_test "cube root of 64 = _" "4" "cbrt 64"

echo ""
echo "=== Factorials ==="
run_test "5 factorial = _" "120" "5!"
run_test "4 factorial = _" "24" "4!"
run_test "6 factorial = _" "720" "6!"
run_test "3! = _" "6" "3! symbol"

echo ""
echo "=== Modulo/Remainder ==="
run_test "17 mod 5 = _" "2" "mod"
run_test "23 remainder 7 = _" "2" "remainder"
run_test "100 mod 3 = _" "1" "100 mod 3"
run_test "15 mod 4 = _" "3" "15 mod 4"

echo ""
echo "=== Averages ==="
run_test "average of 10 and 20 = _" "15" "avg 2 nums"
run_test "average of 5, 10, 15 = _" "10" "avg 3 nums"
run_test "mean of 2, 4, 6, 8 = _" "5" "mean 4 nums"

echo ""
echo "=== Negatives ==="
run_test "-5 + 10 = _" "5" "neg plus pos"
run_test "-3 * -4 = _" "12" "neg times neg"
run_test "-20 / 4 = _" "-5" "neg div"
run_test "10 - 15 = _" "-5" "result neg"

echo ""
echo "=== Unit Conversions ==="
run_test "100 celsius to fahrenheit = _" "212" "C to F"
run_test "32 fahrenheit to celsius = _" "0" "F to C"
run_test "1 mile in feet = _" "5280" "mi to ft"

echo ""
echo "=== Word Problems ==="
run_test "3 items at 5 each = _" "15" "item cost"
run_test "distance at 60 mph for 2 hours = _" "120" "distance"
run_test "6 packs of 12 = _" "72" "packs"
run_test "price per unit if 10 cost 50 = _" "5" "unit price"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
