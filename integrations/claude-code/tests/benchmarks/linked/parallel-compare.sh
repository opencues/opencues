#!/bin/bash
# Parallel benchmark comparison

DIR="$(dirname "$0")"
V1="$HOME/tweakcc/system_prompts/linked.txt"
V2="$HOME/tweakcc/system_prompts/linked-v2.txt"
SCRIPT="$HOME/.claude/llm-analyze-auto.sh"
PARALLEL=3

WORK_DIR=$(mktemp -d)
trap "rm -rf $WORK_DIR" EXIT

# Collect tests
declare -a INPUTS
declare -a EXPECTS

for f in "$DIR"/link-*.sh; do
    while IFS= read -r line; do
        if [[ "$line" =~ run_linked_test\ \"([^\"]+)\"\ \"([^\"]+)\" ]]; then
            INPUTS+=("${BASH_REMATCH[1]}")
            EXPECTS+=("${BASH_REMATCH[2]}")
        fi
    done < "$f"
done

TOTAL=${#INPUTS[@]}
echo "Found $TOTAL tests"

# Run single test - uses index for unique files
run_test() {
    local idx="$1"
    local input="$2"
    local expected="$3"
    local prompt="$4"
    local prefix="$5"

    # Unique files per test
    local infile="$WORK_DIR/${prefix}_${idx}.txt"
    local outfile="$WORK_DIR/${prefix}_${idx}.json"
    local resultfile="$WORK_DIR/${prefix}_${idx}.result"

    echo "$input" > "$infile"
    LINKED_PROMPT="$prompt" LLM_MODE=LINKED timeout 15 bash "$SCRIPT" "$infile" "$outfile" 2>/dev/null

    local links=$(python3 -c "
import json
try:
    with open('$outfile') as f:
        d = json.load(f)
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

    # Check pass
    local passed=0
    if [[ "$expected" == "none" ]]; then
        [[ "$links" == "none" ]] && passed=1
    else
        IFS=',' read -ra EXPS <<< "$expected"
        for exp in "${EXPS[@]}"; do
            if [[ "$links" == *"$exp"* ]]; then
                passed=1
                break
            fi
        done
    fi
    echo "$passed" > "$resultfile"
}

run_version() {
    local prompt="$1"
    local prefix="$2"
    local running=0

    for i in "${!INPUTS[@]}"; do
        # Pass all args to subshell to avoid variable capture issues
        run_test "$i" "${INPUTS[$i]}" "${EXPECTS[$i]}" "$prompt" "$prefix" &
        ((running++))

        if [[ $running -ge $PARALLEL ]]; then
            wait -n 2>/dev/null || wait
            ((running--))
        fi
    done
    wait

    # Count results
    local passed=0
    for i in "${!INPUTS[@]}"; do
        local rf="$WORK_DIR/${prefix}_${i}.result"
        [[ -f "$rf" ]] && passed=$((passed + $(cat "$rf")))
    done
    echo $passed
}

echo ""
echo "Running V1 ($PARALLEL parallel)..."
START=$(date +%s)
V1_PASS=$(run_version "$V1" "v1")
V1_TIME=$(($(date +%s) - START))
echo "V1: $V1_PASS / $TOTAL (${V1_TIME}s)"

echo ""
echo "Running V2 ($PARALLEL parallel)..."
START=$(date +%s)
V2_PASS=$(run_version "$V2" "v2")
V2_TIME=$(($(date +%s) - START))
echo "V2: $V2_PASS / $TOTAL (${V2_TIME}s)"

echo ""
echo "=== RESULTS ==="
V1_PCT=$(awk "BEGIN {printf \"%.1f\", $V1_PASS * 100 / $TOTAL}")
V2_PCT=$(awk "BEGIN {printf \"%.1f\", $V2_PASS * 100 / $TOTAL}")
echo "V1 (320 lines): $V1_PASS / $TOTAL ($V1_PCT%)"
echo "V2 (160 lines): $V2_PASS / $TOTAL ($V2_PCT%)"
