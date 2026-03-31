#!/bin/bash

# LINKED mode benchmark - CONCEPT category
# Tests: semantic/real-world knowledge links
# e.g., website↔HTML, car↔road, doctor↔hospital

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

echo "=== Technology ==="
# 0=building 1=a 2=website 3=with 4=HTML
run_linked_test "building a website with HTML" "2-4,4-2" "website/HTML"
# 0=building 1=an 2=app 3=with 4=Swift
run_linked_test "building an app with Swift" "2-4,4-2" "app/Swift"
# 0=developing 1=a 2=website 3=using 4=JavaScript
run_linked_test "developing a website using JavaScript" "2-4,4-2" "website/JavaScript"
# 0=creating 1=a 2=game 3=in 4=Unity
run_linked_test "creating a game in Unity" "2-4,4-2" "game/Unity"

echo ""
echo "=== Vehicle + Surface ==="
# 0=driving 1=a 2=car 3=on 4=the 5=road
run_linked_test "driving a car on the road" "2-5,5-2" "car/road"
# 0=sailing 1=a 2=boat 3=on 4=the 5=water
run_linked_test "sailing a boat on the water" "2-5,5-2" "boat/water"
# 0=flying 1=a 2=plane 3=in 4=the 5=sky
run_linked_test "flying a plane in the sky" "2-5,5-2" "plane/sky"
# 0=a 1=train 2=on 3=the 4=tracks
run_linked_test "a train on the tracks" "1-4,4-1" "train/tracks"

echo ""
echo "=== Profession + Place ==="
# 0=the 1=doctor 2=at 3=the 4=hospital
run_linked_test "the doctor at the hospital" "1-4,4-1" "doctor/hospital"
# 0=the 1=teacher 2=at 3=the 4=school
run_linked_test "the teacher at the school" "1-4,4-1" "teacher/school"
# 0=the 1=chef 2=in 3=the 4=kitchen
run_linked_test "the chef in the kitchen" "1-4,4-1" "chef/kitchen"
# 0=the 1=pilot 2=in 3=the 4=cockpit
run_linked_test "the pilot in the cockpit" "1-4,4-1" "pilot/cockpit"

echo ""
echo "=== Animal + Habitat ==="
# 0=the 1=fish 2=in 3=the 4=water
run_linked_test "the fish in the water" "1-4,4-1" "fish/water"
# 0=the 1=bird 2=in 3=the 4=sky
run_linked_test "the bird in the sky" "1-4,4-1" "bird/sky"
# 0=the 1=bear 2=in 3=the 4=forest
run_linked_test "the bear in the forest" "1-4,4-1" "bear/forest"

echo ""
echo "=== Sport + Equipment ==="
# 0=playing 1=tennis 2=with 3=a 4=racket
run_linked_test "playing tennis with a racket" "1-4,4-1" "tennis/racket"
# 0=playing 1=golf 2=with 3=a 4=club
run_linked_test "playing golf with a club" "1-4,4-1" "golf/club"
# 0=playing 1=baseball 2=with 3=a 4=bat
run_linked_test "playing baseball with a bat" "1-4,4-1" "baseball/bat"

echo ""
echo "=== Food + Container ==="
# 0=drinking 1=coffee 2=from 3=a 4=cup
run_linked_test "drinking coffee from a cup" "1-4,4-1" "coffee/cup"
# 0=eating 1=soup 2=from 3=a 4=bowl
run_linked_test "eating soup from a bowl" "1-4,4-1" "soup/bowl"
# 0=pouring 1=wine 2=into 3=a 4=glass
run_linked_test "pouring wine into a glass" "1-4,4-1" "wine/glass"

echo ""
echo "=== Time + Meal ==="
# 0=eating 1=breakfast 2=in 3=the 4=morning
run_linked_test "eating breakfast in the morning" "1-4,4-1" "breakfast/morning"
# 0=eating 1=dinner 2=in 3=the 4=evening
run_linked_test "eating dinner in the evening" "1-4,4-1" "dinner/evening"
# 0=eating 1=lunch 2=at 3=noon
run_linked_test "eating lunch at noon" "1-3,3-1" "lunch/noon"

echo ""
echo "=== Language + Country ==="
# 0=speaking 1=French 2=in 3=France
run_linked_test "speaking French in France" "1-3,3-1" "French/France"
# 0=speaking 1=Japanese 2=in 3=Japan
run_linked_test "speaking Japanese in Japan" "1-3,3-1" "Japanese/Japan"
# 0=speaking 1=Spanish 2=in 3=Spain
run_linked_test "speaking Spanish in Spain" "1-3,3-1" "Spanish/Spain"

echo ""
echo "=== Currency + Country ==="
# 0=paying 1=with 2=dollars 3=in 4=America
run_linked_test "paying with dollars in America" "2-4,4-2" "dollars/America"
# 0=paying 1=with 2=euros 3=in 4=France
run_linked_test "paying with euros in France" "2-4,4-2" "euros/France"
# 0=paying 1=with 2=yen 3=in 4=Japan
run_linked_test "paying with yen in Japan" "2-4,4-2" "yen/Japan"

echo ""
echo "=== Weather + Clothing ==="
# 0=wearing 1=a 2=coat 3=in 4=winter
run_linked_test "wearing a coat in winter" "2-4,4-2" "coat/winter"
# 0=wearing 1=shorts 2=in 3=summer
run_linked_test "wearing shorts in summer" "1-3,3-1" "shorts/summer"
# 0=carrying 1=an 2=umbrella 3=in 4=the 5=rain
run_linked_test "carrying an umbrella in the rain" "2-5,5-2" "umbrella/rain"

echo ""
echo "=== Activity + Tool ==="
# 0=cutting 1=wood 2=with 3=a 4=saw (activity↔tool link)
run_linked_test "cutting wood with a saw" "0-4,4-0" "cutting/saw"
# 0=hammering 1=nails 2=with 3=a 4=hammer
run_linked_test "hammering nails with a hammer" "0-4,4-0" "hammering/hammer"
# 0=painting 1=walls 2=with 3=a 4=brush
run_linked_test "painting walls with a brush" "0-4,4-0" "painting/brush"

echo ""
echo "=== Device + Action ==="
# 0=taking 1=photos 2=with 3=a 4=camera
run_linked_test "taking photos with a camera" "1-4,4-1" "photos/camera"
# 0=making 1=calls 2=on 3=a 4=phone
run_linked_test "making calls on a phone" "1-4,4-1" "calls/phone"
# 0=typing 1=emails 2=on 3=a 4=computer
run_linked_test "typing emails on a computer" "1-4,4-1" "emails/computer"

echo ""
echo "=== Academic ==="
# 0=the 1=student 2=at 3=the 4=university
run_linked_test "the student at the university" "1-4,4-1" "student/university"
# 0=the 1=professor 2=at 3=the 4=college
run_linked_test "the professor at the college" "1-4,4-1" "professor/college"

echo ""
echo "=== Instrument + Genre ==="
# 0=playing 1=guitar 2=in 3=a 4=rock 5=band
run_linked_test "playing guitar in a rock band" "1-4,4-1" "guitar/rock"
# 0=playing 1=violin 2=in 3=an 4=orchestra
run_linked_test "playing violin in an orchestra" "1-4,4-1" "violin/orchestra"

echo ""
echo "=== EDGE CASES (generalization tests - not in examples) ==="

echo ""
echo "--- Technology (novel stacks) ---"
# 0=building 1=a 2=database 3=with 4=SQL
run_linked_test "building a database with SQL" "2-4,4-2" "database/SQL"
# 0=building 1=a 2=blockchain 3=with 4=Solidity
run_linked_test "building a blockchain with Solidity" "2-4,4-2" "blockchain/Solidity"
# 0=creating 1=an 2=API 3=with 4=REST
run_linked_test "creating an API with REST" "2-4,4-2" "API/REST"

echo ""
echo "--- Vehicle (novel vehicles) ---"
# 0=flying 1=a 2=helicopter 3=in 4=the 5=air
run_linked_test "flying a helicopter in the air" "2-5,5-2" "helicopter/air"
# 0=paddling 1=a 2=kayak 3=on 4=the 5=river
run_linked_test "paddling a kayak on the river" "2-5,5-2" "kayak/river"
# 0=riding 1=a 2=motorcycle 3=on 4=the 5=highway
run_linked_test "riding a motorcycle on the highway" "2-5,5-2" "motorcycle/highway"

echo ""
echo "--- Profession (novel jobs) ---"
# 0=the 1=nurse 2=at 3=the 4=clinic
run_linked_test "the nurse at the clinic" "1-4,4-1" "nurse/clinic"
# 0=the 1=firefighter 2=at 3=the 4=station
run_linked_test "the firefighter at the station" "1-4,4-1" "firefighter/station"
# 0=the 1=librarian 2=at 3=the 4=library
run_linked_test "the librarian at the library" "1-4,4-1" "librarian/library"

echo ""
echo "--- Animal (novel animals) ---"
# 0=the 1=monkey 2=in 3=the 4=jungle
run_linked_test "the monkey in the jungle" "1-4,4-1" "monkey/jungle"
# 0=the 1=shark 2=in 3=the 4=ocean
run_linked_test "the shark in the ocean" "1-4,4-1" "shark/ocean"
# 0=the 1=eagle 2=in 3=the 4=mountains
run_linked_test "the eagle in the mountains" "1-4,4-1" "eagle/mountains"

echo ""
echo "--- Sport (novel sports) ---"
# 0=playing 1=bowling 2=with 3=a 4=ball
run_linked_test "playing bowling with a ball" "1-4,4-1" "bowling/ball"
# 0=doing 1=archery 2=with 3=a 4=bow
run_linked_test "doing archery with a bow" "1-4,4-1" "archery/bow"
# 0=practicing 1=fencing 2=with 3=a 4=sword (accept sport↔equipment OR activity↔tool)
run_linked_test "practicing fencing with a sword" "1-4,4-1,0-4,4-0" "fencing/sword"

echo ""
echo "--- Food/Drink (novel items) ---"
# 0=drinking 1=tea 2=from 3=a 4=teapot
run_linked_test "drinking tea from a teapot" "1-4,4-1" "tea/teapot"
# 0=eating 1=cereal 2=from 3=a 4=bowl
run_linked_test "eating cereal from a bowl" "1-4,4-1" "cereal/bowl"
# 0=drinking 1=soda 2=from 3=a 4=can
run_linked_test "drinking soda from a can" "1-4,4-1" "soda/can"

echo ""
echo "--- Language (novel languages) ---"
# 0=speaking 1=Portuguese 2=in 3=Brazil
run_linked_test "speaking Portuguese in Brazil" "1-3,3-1" "Portuguese/Brazil"
# 0=speaking 1=Chinese 2=in 3=China
run_linked_test "speaking Chinese in China" "1-3,3-1" "Chinese/China"
# 0=speaking 1=Russian 2=in 3=Russia
run_linked_test "speaking Russian in Russia" "1-3,3-1" "Russian/Russia"

echo ""
echo "--- Currency (novel currencies) ---"
# 0=paying 1=with 2=rupees 3=in 4=India
run_linked_test "paying with rupees in India" "2-4,4-2" "rupees/India"
# 0=paying 1=with 2=pesos 3=in 4=Mexico
run_linked_test "paying with pesos in Mexico" "2-4,4-2" "pesos/Mexico"
# 0=paying 1=with 2=rubles 3=in 4=Russia
run_linked_test "paying with rubles in Russia" "2-4,4-2" "rubles/Russia"

echo ""
echo "--- Weather/Season (novel clothing) ---"
# 0=wearing 1=sunglasses 2=in 3=the 4=sun
run_linked_test "wearing sunglasses in the sun" "1-4,4-1" "sunglasses/sun"
# 0=wearing 1=gloves 2=in 3=the 4=cold
run_linked_test "wearing gloves in the cold" "1-4,4-1" "gloves/cold"
# 0=wearing 1=sandals 2=at 3=the 4=beach
run_linked_test "wearing sandals at the beach" "1-4,4-1" "sandals/beach"

echo ""
echo "--- Activity+Tool (novel activities) ---"
# 0=sewing 1=fabric 2=with 3=a 4=needle
run_linked_test "sewing fabric with a needle" "0-4,4-0" "sewing/needle"
# 0=digging 1=holes 2=with 3=a 4=shovel
run_linked_test "digging holes with a shovel" "0-4,4-0" "digging/shovel"
# 0=writing 1=notes 2=with 3=a 4=pen (accept action↔tool OR a↔pen determiner)
run_linked_test "writing notes with a pen" "0-4,4-0,3-4,4-3" "writing/pen"

echo ""
echo "--- Device (novel devices) ---"
# 0=scanning 1=documents 2=with 3=a 4=scanner (accept action↔tool OR output↔device)
run_linked_test "scanning documents with a scanner" "1-4,4-1,0-4,4-0" "documents/scanner"
# 0=watching 1=shows 2=on 3=a 4=TV
run_linked_test "watching shows on a TV" "1-4,4-1,0-4,4-0" "shows/TV"
# 0=playing 1=music 2=on 3=a 4=speaker (accept action↔device OR output↔device)
run_linked_test "playing music on a speaker" "1-4,4-1,0-4,4-0" "music/speaker"

echo ""
echo "--- Instrument (novel instruments) ---"
# 0=playing 1=saxophone 2=in 3=a 4=jazz 5=band
run_linked_test "playing saxophone in a jazz band" "1-4,4-1" "saxophone/jazz"
# 0=playing 1=sitar 2=in 3=a 4=classical 5=ensemble
run_linked_test "playing sitar in a classical ensemble" "1-4,4-1" "sitar/classical"

echo ""
AVG_TIME=0
if [[ $COUNT -gt 0 ]]; then
    AVG_TIME=$((TOTAL_TIME / COUNT))
fi
echo "=== Results: $PASSED passed, $FAILED failed (avg: ${AVG_TIME}ms) ==="
