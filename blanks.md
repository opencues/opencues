---
name: claude-code-blanks
domain: claude-code
version: 1
---

# blanks.md

OpenCues blanks configuration. Controls fill-in-the-blank behaviour —
words replaced with `_` that the LLM fills in during cue resolution.

## Ignore

Anthropic
Claude
OpenCues
TypeScript
JavaScript
Groq
Gemini

## Prompt

### classifier

```yaml
priority: 100
```

Classify the input into one mode: MATH, FACTUAL, TRANSLATION, UNIT, SPELLING, COLOR, HTTP, or GRAMMAR.

NOTE: This classifier only runs for inputs with blanks (_) when fast heuristics (match/keywords) don't match.
Claude Code terms are detected via per-word tips lookup (no classifier needed).

MATH - Contains calculations, numbers with operators, percentages, or word math:
- "4 * 12 = _" → MATH
- "half of 16 = _" → MATH
- "50 plus 20% tax = _" → MATH
- "average of 80, 90, 100 = _" → MATH

FACTUAL - Asks for specific facts, names, dates, or knowledge:
- "The CEO of Apple is _" → FACTUAL
- "The capital of France is _" → FACTUAL
- "The chemical symbol for gold is _" → FACTUAL

TRANSLATION - Translating a word or phrase into another language:
- "Hello in French is _" → TRANSLATION
- "Dog in Spanish is _" → TRANSLATION

UNIT - Converting between measurement units:
- "100 celsius in fahrenheit is _" → UNIT
- "5 miles in km is _" → UNIT
- "10 kg in pounds is _" → UNIT

SPELLING - Word relationships (opposites, synonyms, rhymes):
- "The opposite of hot is _" → SPELLING
- "A synonym for happy is _" → SPELLING
- "Rhymes with cat _" → SPELLING

COLOR - Color codes and color space conversions:
- "Red in hex is _" → COLOR
- "Hex for blue is _" → COLOR
- "#FF0000 in rgb is _" → COLOR

HTTP - HTTP status codes and meanings:
- "HTTP status for not found is _" → HTTP
- "HTTP 200 means _" → HTTP
- "Status code for unauthorized is _" → HTTP

TIMEZONE - Time zone conversions:
- "3pm London in Tokyo is _" → TIMEZONE
- "9am EST in PST is _" → TIMEZONE
- "Noon UTC in IST is _" → TIMEZONE

ROMAN - Roman numeral conversions:
- "14 in roman numerals is _" → ROMAN
- "MCMXC in numbers is _" → ROMAN
- "2024 in roman is _" → ROMAN

GRAMMAR - Needs word alternatives or sentence completion (default):
- "The nervous boy _ quickly" → GRAMMAR
- "She walked _ to school" → GRAMMAR
- "The _ dog barked loudly" → GRAMMAR
- "_ ran across the street" → GRAMMAR

Output ONLY: MODE=MATH or MODE=FACTUAL or MODE=TRANSLATION or MODE=UNIT or MODE=SPELLING or MODE=COLOR or MODE=HTTP or MODE=TIMEZONE or MODE=ROMAN or MODE=GRAMMAR

Classify:

### math

```yaml
priority: 90
parser: compute
match: \d+\s*[+\-*/^%]\s*\d+|\d+%
keywords: factorial, average, half of, double, triple, square root, sqrt, power of, tip, tax, discount, split, divide, multiply, mod, remainder, gcd, lcm, log, sine, cosine, floor, ceiling, round
```

Solve the math. Output ONLY: COMPUTE=expression

Examples:
- 4 * 12 = BLANK → COMPUTE=4*12
- 100 / 4 = BLANK → COMPUTE=100/4
- half of 16 = BLANK → COMPUTE=16/2
- double 25 = BLANK → COMPUTE=25*2
- triple 7 = BLANK → COMPUTE=7*3
- 5 factorial = BLANK → COMPUTE=1*2*3*4*5
- 3! = BLANK → COMPUTE=1*2*3
- 50 plus 20% tax = BLANK → COMPUTE=50*1.20
- 80 with 25% off = BLANK → COMPUTE=80*0.75
- 15% of 200 = BLANK → COMPUTE=0.15*200
- tip 18% on 85 = BLANK → COMPUTE=0.18*85
- 2 to the power of 8 = BLANK → COMPUTE=2**8
- square root of 144 = BLANK → COMPUTE=12
- celsius to fahrenheit 100C = BLANK → COMPUTE=(100*9/5)+32
- distance at 60 mph for 2.5 hours = BLANK → COMPUTE=60*2.5
- split 150 between 3 people = BLANK → COMPUTE=150/3
- average of 80, 90, 100 = BLANK → COMPUTE=(80+90+100)/3
- sum of 1 to 10 = BLANK → COMPUTE=1+2+3+4+5+6+7+8+9+10
- 3 items at 4.99 each = BLANK → COMPUTE=3*4.99
- permutations 5 choose 2 = BLANK → COMPUTE=(1*2*3*4*5)/(1*2*3)
- combinations 5 choose 2 = BLANK → COMPUTE=(1*2*3*4*5)/((1*2)*(1*2*3))
- negative 5 times negative 3 = BLANK → COMPUTE=-5*-3
- absolute value of -42 = BLANK → COMPUTE=42
- 17 mod 5 = BLANK → COMPUTE=17%5
- 7 remainder 3 = BLANK → COMPUTE=7%3
- log base 10 of 1000 = BLANK → COMPUTE=3
- sine of 90 degrees = BLANK → COMPUTE=1
- cosine of 0 degrees = BLANK → COMPUTE=1
- gcd of 48 and 18 = BLANK → COMPUTE=6
- lcm of 12 and 18 = BLANK → COMPUTE=36
- floor of 3.7 = BLANK → COMPUTE=3
- ceiling of 2.1 = BLANK → COMPUTE=3
- round 3.5 = BLANK → COMPUTE=4

Solve:

### factual

```yaml
priority: 90
parser: answer
match: the (capital|ceo|founder|author|inventor|creator|president|king|queen|leader|currency|language|population|area) of .+ is|who (is|was|invented|wrote|painted|composed)|capital of|ceo of|founder of|author of|chemical symbol|atomic number|speed of light|largest (ocean|planet|desert|continent)|tallest (mountain|building)|longest (river|bridge)
keywords: capital of, ceo of, founder of, author of, who is, who was, when did, when was, where is, chemical symbol, atomic number, boils at, freezes at, speed of light
```

Answer the factual question. Output ONLY: ANSWER=answer

Examples by category:

People:
- The CEO of Apple is BLANK → ANSWER=Tim Cook
- The founder of Microsoft is BLANK → ANSWER=Bill Gates
- The first president of the US was BLANK → ANSWER=George Washington
- The inventor of the telephone is BLANK → ANSWER=Alexander Graham Bell
- The author of Harry Potter is BLANK → ANSWER=J.K. Rowling
- The painter of Mona Lisa is BLANK → ANSWER=Leonardo da Vinci
- The composer of Fur Elise is BLANK → ANSWER=Beethoven
- The sculptor of David is BLANK → ANSWER=Michelangelo
- The architect of the Eiffel Tower is BLANK → ANSWER=Gustave Eiffel
- The first woman in space was BLANK → ANSWER=Valentina Tereshkova

Places:
- The capital of France is BLANK → ANSWER=Paris
- The largest ocean is the BLANK → ANSWER=Pacific
- The tallest mountain is BLANK → ANSWER=Mount Everest
- The longest river is the BLANK → ANSWER=Nile
- The largest desert is the BLANK → ANSWER=Sahara
- The smallest continent is BLANK → ANSWER=Australia

Dates/Years:
- World War 2 ended in BLANK → ANSWER=1945
- The Berlin Wall fell in BLANK → ANSWER=1989
- The Titanic sank in BLANK → ANSWER=1912
- The Soviet Union collapsed in BLANK → ANSWER=1991
- The first Olympics were held in BLANK → ANSWER=1896
- Queen Elizabeth II became queen in BLANK → ANSWER=1952
- The first iPhone was released in BLANK → ANSWER=2007

Science:
- The chemical symbol for gold is BLANK → ANSWER=Au
- The chemical symbol for iron is BLANK → ANSWER=Fe
- The atomic number of carbon is BLANK → ANSWER=6
- Water boils at BLANK degrees Celsius → ANSWER=100
- Water freezes at BLANK degrees Celsius → ANSWER=0
- The speed of light is approximately BLANK km/s → ANSWER=299792
- The closest star to Earth is the BLANK → ANSWER=Sun
- The largest planet is BLANK → ANSWER=Jupiter

Question:

### translation

```yaml
priority: 85
parser: answer
match: in (french|spanish|german|italian|japanese|chinese|korean|portuguese|arabic|russian|hindi|dutch|swedish|greek|latin|hebrew) (is|means)|how do you say .+ in|translate .+ to|(french|spanish|german|italian|japanese|chinese|korean|portuguese|arabic|russian) word for
keywords: in french, in spanish, in german, in italian, in japanese, in chinese, in korean, in portuguese, in arabic, in russian, translate to, how do you say, french word for, german word for, spanish word for, italian word for, japanese word for, chinese word for, korean word for, arabic word for, russian word for, latin word for, hebrew word for
```

Translate the word or phrase. Output ONLY: ANSWER=translation

Use the most common/standard translation. For languages with non-Latin scripts,
provide the romanized form (e.g., "arigatou" not "ありがとう").

Examples:
- Hello in French is BLANK → ANSWER=Bonjour
- Thank you in Japanese is BLANK → ANSWER=Arigatou
- Dog in Spanish is BLANK → ANSWER=Perro
- The German word for house is BLANK → ANSWER=Haus
- How do you say goodbye in Italian BLANK → ANSWER=Arrivederci
- Water in Arabic is BLANK → ANSWER=Maa
- Cat in Portuguese is BLANK → ANSWER=Gato
- Love in Latin is BLANK → ANSWER=Amor
- Friend in Korean is BLANK → ANSWER=Chingu
- Good morning in Chinese is BLANK → ANSWER=Zao shang hao
- Beautiful in Russian is BLANK → ANSWER=Krasivyy
- Peace in Hebrew is BLANK → ANSWER=Shalom
- Bread in French is BLANK → ANSWER=Pain
- Book in German is BLANK → ANSWER=Buch
- Red in Spanish is BLANK → ANSWER=Rojo

Translate:

### unit

```yaml
priority: 85
parser: compute
match: \d+\s*(celsius|fahrenheit|km|miles|kg|pounds|liters|gallons|meters|feet|inches|cm|oz|grams|yards|ounces|tons|mph|kph)\s+(in|to)\s+
keywords: in celsius, in fahrenheit, in km, in miles, in kg, in pounds, in liters, in gallons, in meters, in feet, in inches, in cm, convert to, to celsius, to fahrenheit, in yards, in ounces
```

Convert between units. Output ONLY: COMPUTE=expression

Use these conversion formulas:
- Celsius to Fahrenheit: COMPUTE=(C*9/5)+32
- Fahrenheit to Celsius: COMPUTE=(F-32)*5/9
- Miles to Kilometers: COMPUTE=miles*1.60934
- Kilometers to Miles: COMPUTE=km*0.621371
- Kilograms to Pounds: COMPUTE=kg*2.20462
- Pounds to Kilograms: COMPUTE=lbs*0.453592
- Liters to Gallons: COMPUTE=liters*0.264172
- Gallons to Liters: COMPUTE=gallons*3.78541
- Meters to Feet: COMPUTE=meters*3.28084
- Feet to Meters: COMPUTE=feet*0.3048
- Inches to Centimeters: COMPUTE=inches*2.54
- Centimeters to Inches: COMPUTE=cm*0.393701
- Yards to Meters: COMPUTE=yards*0.9144
- Ounces to Grams: COMPUTE=oz*28.3495

Examples:
- 100 celsius in fahrenheit = BLANK → COMPUTE=(100*9/5)+32
- 32 fahrenheit in celsius = BLANK → COMPUTE=(32-32)*5/9
- 5 miles in km = BLANK → COMPUTE=5*1.60934
- 10 km in miles = BLANK → COMPUTE=10*0.621371
- 70 kg in pounds = BLANK → COMPUTE=70*2.20462
- 150 pounds in kg = BLANK → COMPUTE=150*0.453592
- 10 meters in feet = BLANK → COMPUTE=10*3.28084
- 6 feet in meters = BLANK → COMPUTE=6*0.3048
- 12 inches in cm = BLANK → COMPUTE=12*2.54

Convert:

### spelling

```yaml
priority: 82
parser: answer
match: (opposite|synonym|antonym|rhymes?) (of|for|with)|another word for|means the same as
keywords: opposite of, synonym for, antonym of, rhymes with, another word for, means the same as
```

Answer the word relationship question. Output ONLY: ANSWER=word

Examples:
- The opposite of hot is BLANK → ANSWER=cold
- The opposite of big is BLANK → ANSWER=small
- The opposite of fast is BLANK → ANSWER=slow
- A synonym for happy is BLANK → ANSWER=joyful
- A synonym for big is BLANK → ANSWER=large
- A synonym for fast is BLANK → ANSWER=quick
- An antonym of light is BLANK → ANSWER=dark
- Rhymes with cat BLANK → ANSWER=hat
- Rhymes with dog BLANK → ANSWER=log
- Another word for beautiful is BLANK → ANSWER=gorgeous
- Means the same as angry BLANK → ANSWER=furious

Answer:

### color

```yaml
priority: 83
parser: answer
match: (hex|rgb|hsl|color code|colour code) (for|of|is)|in (hex|rgb|hsl)|#[0-9a-fA-F]{3,6}
keywords: in hex, in rgb, hex for, rgb for, color code, hex code, colour code, color for, colour for
```

Answer the color code question. Output ONLY: ANSWER=value

For hex codes, include the # prefix. For RGB, use format "rgb(R,G,B)".

Examples:
- Red in hex is BLANK → ANSWER=#FF0000
- Blue in hex is BLANK → ANSWER=#0000FF
- Green in hex is BLANK → ANSWER=#00FF00
- White in hex is BLANK → ANSWER=#FFFFFF
- Black in hex is BLANK → ANSWER=#000000
- Yellow in hex is BLANK → ANSWER=#FFFF00
- Hex for purple is BLANK → ANSWER=#800080
- Hex for orange is BLANK → ANSWER=#FFA500
- Red in rgb is BLANK → ANSWER=rgb(255,0,0)
- Blue in rgb is BLANK → ANSWER=rgb(0,0,255)
- Hex for cyan is BLANK → ANSWER=#00FFFF
- Hex for pink is BLANK → ANSWER=#FFC0CB

Answer:

### http

```yaml
priority: 84
parser: answer
match: http (status|code|error|\d{3})|status code for
keywords: http status, status code, http code, http error, status for
```

Answer the HTTP status code question. Output ONLY: ANSWER=value

For code-to-meaning: give the standard reason phrase.
For meaning-to-code: give the 3-digit status code.

Examples:
- HTTP status for not found is BLANK → ANSWER=404
- HTTP status for OK is BLANK → ANSWER=200
- HTTP status for unauthorized is BLANK → ANSWER=401
- HTTP status for forbidden is BLANK → ANSWER=403
- HTTP status for server error is BLANK → ANSWER=500
- HTTP status for redirect is BLANK → ANSWER=301
- HTTP status for bad request is BLANK → ANSWER=400
- HTTP status for created is BLANK → ANSWER=201
- HTTP 200 means BLANK → ANSWER=OK
- HTTP 404 means BLANK → ANSWER=Not Found
- HTTP 500 means BLANK → ANSWER=Internal Server Error
- HTTP 301 means BLANK → ANSWER=Moved Permanently
- HTTP 403 means BLANK → ANSWER=Forbidden
- HTTP 401 means BLANK → ANSWER=Unauthorized

Answer:

### timezone

```yaml
priority: 84
parser: answer
match: \d{1,2}\s*(am|pm)\s+(in|to)\s+\w+\s+(is|time)|(noon|midnight)\s+(in|to)\s+|(\bEST\b|\bPST\b|\bCST\b|\bMST\b|\bUTC\b|\bGMT\b|\bCET\b|\bIST\b|\bJST\b|\bAEST\b|\bBST\b|\bKST\b)\s+(in|to)\s+
keywords: in est, in pst, in cst, in mst, in utc, in gmt, in cet, in ist, in jst, in aest, in bst, in kst, time in, to est, to pst, to utc, to gmt, london time, tokyo time, new york time
```

Convert between time zones. Output ONLY: ANSWER=time

Use these UTC offsets:
- UTC/GMT: +0
- EST (New York): -5, EDT: -4
- CST (Chicago): -6, CDT: -5
- MST (Denver): -7, MDT: -6
- PST (Los Angeles): -8, PDT: -7
- GMT/London: +0, BST: +1
- CET (Paris/Berlin): +1, CEST: +2
- IST (India): +5:30
- JST (Tokyo): +9
- KST (Seoul): +9
- AEST (Sydney): +10, AEDT: +11
- CST (China/Beijing): +8

Give the converted time in 12-hour format with am/pm.

Examples:
- 3pm London in Tokyo is BLANK → ANSWER=midnight (12am next day)
- 9am EST in PST is BLANK → ANSWER=6am
- noon UTC in IST is BLANK → ANSWER=5:30pm
- 8pm Tokyo in London is BLANK → ANSWER=11am
- 10am PST in EST is BLANK → ANSWER=1pm
- 6am UTC in CET is BLANK → ANSWER=7am
- 3pm New York in London is BLANK → ANSWER=8pm
- midnight UTC in JST is BLANK → ANSWER=9am
- 2pm London in New York is BLANK → ANSWER=9am
- 7am PST in Tokyo is BLANK → ANSWER=midnight (12am next day)

Answer:

### roman

```yaml
priority: 81
parser: answer
match: \b[IVXLCDM]{2,}\b|in roman (numeral|number)|to roman|from roman
keywords: roman numeral, roman numerals, in roman, to roman, from roman
```

Convert between Arabic and Roman numerals. Output ONLY: ANSWER=value

Roman numeral rules:
- I=1, V=5, X=10, L=50, C=100, D=500, M=1000
- Subtractive: IV=4, IX=9, XL=40, XC=90, CD=400, CM=900
- Numbers 1-3999 only

Examples:
- 14 in roman numerals is BLANK → ANSWER=XIV
- 2024 in roman numerals is BLANK → ANSWER=MMXXIV
- 99 in roman numerals is BLANK → ANSWER=XCIX
- 1990 in roman numerals is BLANK → ANSWER=MCMXC
- 500 in roman numerals is BLANK → ANSWER=D
- MCMXC in numbers is BLANK → ANSWER=1990
- XIV in numbers is BLANK → ANSWER=14
- XLII in numbers is BLANK → ANSWER=42
- MMXXIV in numbers is BLANK → ANSWER=2024
- IX in numbers is BLANK → ANSWER=9
- CDXLIV in numbers is BLANK → ANSWER=444
- DCCCLXXXVIII in numbers is BLANK → ANSWER=888

Answer:

### grammar

```yaml
priority: 50
parser: alternatives
```

Fill each blank (_) with 5 words that make the sentence grammatical.
Use the EXACT index shown for each blank. If there are multiple blanks, fill ALL of them.

RULES - check BOTH sides of blank:
1. Blank at START + VERB after (ran/walked/jumped) → give NOUNS (subject of verb)
2. Blank at START + NOUN/ADJECTIVE after → give DETERMINERS (The/A/My/That)
3. Determiner BEFORE blank (The/A/My) + NOUN after → give ADJECTIVES (NOT more determiners!)
4. Determiner BEFORE + VERB after → give NOUNS (subject of verb)
5. Pronoun BEFORE + pronoun/adverb after → give VERBS
6. Subject + blank + ADVERB → give VERBS
7. Blank at END after preposition (using/with/in/for/to) → give NOUNS that fit context

IMPORTANT: If there's already "The/A/My" before the blank, DON'T give determiners!

WRONG answers to avoid:
- "The _ dog" → The/A/My are WRONG (already has "The"!)
- "The _ dog" → cat/puppy are WRONG (those replace "dog", not blank)
- "The _ dog" → big/small/brown are CORRECT (adjectives)
- "The _ software" → The/My/Our are WRONG (already has "The"!)
- "The _ software" → new/old/buggy are CORRECT (adjectives)
- "The _ ran" → fast/quick are WRONG (needs subject noun)
- "The _ ran" → dog/boy/man are CORRECT (subject of verb)

Examples:
Start + verb → noun (subject needed!):
- 0=_ 1=ran 2=across → 0:He,She,Someone,The dog,A cat
- 0=_ 1=walked 2=slowly → 0:He,She,They,The man,A woman
- 0=_ 1=crashed 2=into → 0:It,The car,A truck,Someone,The plane

Start + noun/adj → determiner:
- 0=_ 1=computer 2=crashed → 0:The,My,His,That,Our
- 0=_ 1=ancient 2=civilization → 0:The,An,That,One,Each
- 0=_ 1=football 2=team → 0:The,A,Our,Their,Every

Determiner + blank + noun (+ anything) → adjective:
- 0=The 1=_ 2=dog 3=barked → 1:big,small,brown,happy,loud
- 0=The 1=_ 2=team 3=won → 1:winning,local,national,strong,home
- 0=The 1=_ 2=software 3=failed → 1:new,old,buggy,faulty,broken
- 0=A 1=_ 2=victory → 1:great,stunning,narrow,decisive,historic
- 0=The 1=_ 2=car 3=crashed → 1:fast,old,new,stolen,red

Verb after blank → noun (subject of verb):
- 0=The 1=_ 2=ran → 1:dog,boy,girl,athlete,child
- 0=The 1=_ 2=crashed → 1:server,computer,system,car,plane
- 0=The 1=_ 2=scored → 1:team,player,striker,forward,star
- 0=The 1=_ 2=walked → 1:man,woman,dog,child,stranger

Pronoun + blank + pronoun → verb:
- 0=They 1=_ 2=us → 1:defeated,beat,helped,joined,told
- 0=We 1=_ 2=them → 1:defeated,beat,helped,joined,told

Subject + blank + adverb → verb:
- 0=The 1=team 2=_ 3=convincingly → 2:won,lost,played,dominated,performed
- 0=The 1=server 2=_ 3=unexpectedly → 2:crashed,failed,rebooted,stopped,froze

Blank at END after preposition → contextual noun:
- ...5=app 6=using 7=_ → 7:Python,React,Flutter,Swift,Kotlin
- ...3=written 4=in 5=_ → 5:Python,Java,C++,Rust,Go
- ...2=built 3=with 4=_ → 4:React,Angular,Vue,Django,Rails
- ...3=going 4=to 5=_ → 5:Paris,Tokyo,London,school,work

Output format: INDEX:word1,word2,word3,word4,word5
