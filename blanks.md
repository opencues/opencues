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

Classify the input into one mode: MATH, FACTUAL, or GRAMMAR.

NOTE: This classifier only runs for inputs with blanks (_) when fast heuristics (match/keywords) don't match.
Claude Code terms are detected via per-word tips lookup (no classifier needed).

MATH - Contains calculations, numbers with operators, percentages, or word math:
- "4 * 12 = _" → MATH
- "half of 16 = _" → MATH
- "50 plus 20% tax = _" → MATH
- "tip 18% on 85 = _" → MATH
- "average of 80, 90, 100 = _" → MATH
- "5 factorial = _" → MATH
- "celsius to fahrenheit 100C = _" → MATH
- "distance at 60 mph for 2 hours = _" → MATH

FACTUAL - Asks for specific facts, names, dates, or knowledge:
- "The CEO of Apple is _" → FACTUAL
- "The capital of France is _" → FACTUAL
- "World War 2 ended in _" → FACTUAL
- "The chemical symbol for gold is _" → FACTUAL
- "The author of Harry Potter is _" → FACTUAL
- "The tallest mountain is _" → FACTUAL
- "The first president of the US was _" → FACTUAL
- "The speed of light is _" → FACTUAL

GRAMMAR - Needs word alternatives or sentence completion (default):
- "The nervous boy _ quickly" → GRAMMAR
- "She walked _ to school" → GRAMMAR
- "The beautiful sunset _" → GRAMMAR
- "He felt extremely _" → GRAMMAR
- "The ancient temple stood _" → GRAMMAR
- "I want to build an app using _" → GRAMMAR
- "The code is written in _" → GRAMMAR
- "We are going to _" → GRAMMAR
- "She works at _" → GRAMMAR
- "_ quick fox jumped" → GRAMMAR
- "_ ran across the street" → GRAMMAR

Output ONLY: MODE=MATH or MODE=FACTUAL or MODE=GRAMMAR

Classify:

### math

```yaml
priority: 90
parser: compute
match: \d+\s*[+\-*/^%]\s*\d+|\d+%
keywords: factorial, average, half of, double, triple, square root, sqrt, power of, celsius, fahrenheit, mph, km/h, tip, tax, discount, split, divide, multiply, mod, remainder, gcd, lcm, log, sine, cosine, floor, ceiling, round
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
match: the .+ of .+ is|who (is|was|invented|wrote|painted|composed)|capital of|ceo of|founder of|author of|chemical symbol|atomic number|speed of light|largest (ocean|planet|desert|continent)|tallest (mountain|building)|longest (river|bridge)
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
