/**
 * cues-core/prompts.ts
 *
 * System prompts for LLM-based cue sources.
 * These are the same prompts used by llm-analyze-auto.sh, now in TypeScript.
 */

/**
 * Classifier prompt - determines MATH, FACTUAL, or GRAMMAR mode for blanks.
 */
export const CLASSIFIER_PROMPT = `Classify the input into one mode: MATH, FACTUAL, or GRAMMAR.

NOTE: This classifier only runs for inputs with blanks (_).

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

Classify: `;

/**
 * Math prompt - returns COMPUTE=expression for evaluation.
 */
export const MATH_PROMPT = `Solve the math. Output ONLY: COMPUTE=expression

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

Solve: `;

/**
 * Factual prompt - returns ANSWER=value for knowledge questions.
 */
export const FACTUAL_PROMPT = `Answer the factual question. Output ONLY: ANSWER=answer

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

Question: `;

/**
 * Grammar prompt for word alternatives (no blanks).
 */
export const GRAMMAR_PROMPT = `Provide 3 alternatives per word: synonym, opposite, creative. Skip function words.

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Adjectives:
- 1=beautiful → 1:gorgeous,ugly,stunning
- 1=happy → 1:joyful,sad,cheerful
- 1=big → 1:large,small,enormous

Adverbs:
- 1=quickly → 1:slowly,rapidly,swiftly
- 1=softly → 1:loudly,quietly,gently

Verbs:
- 1=ran → 1:walked,sprinted,jogged
- 1=said → 1:whispered,shouted,stated

Nouns:
- 1=dog → 1:cat,wolf,puppy
- 1=boy → 1:girl,child,lad

Proper Nouns (give similar entities):
- Companies: 1=Google → 1:Microsoft,Apple,Amazon
- People: 1=Einstein → 1:Newton,Darwin,Hawking
- Countries: 1=France → 1:Germany,Italy,Spain
- Programming: 1=Python → 1:Java,JavaScript,C++
- Job titles: 1=CEO → 1:CFO,CTO,President

Emotional:
- 1=sad → 1:happy,melancholy,depressed
- 1=angry → 1:calm,furious,enraged

Output ONLY index:alternatives format.

Input: `;

/**
 * Blank grammar prompt for fill-in-the-blank (with underscore).
 */
export const BLANK_GRAMMAR_PROMPT = `Fill the blank (_) with 5 words that make the sentence grammatical.

RULES - check BOTH sides of blank:
1. Blank at START + VERB after (ran/walked/jumped) → give NOUNS (subject of verb)
2. Blank at START + NOUN/ADJECTIVE after → give DETERMINERS (The/A/My/That)
3. Determiner BEFORE blank (The/A/My) + NOUN after → give ADJECTIVES (NOT more determiners!)
4. Determiner BEFORE + VERB after → give NOUNS (subject of verb)
5. Subject + blank + ADVERB → give VERBS
6. Blank at END after preposition (using/with/in/for/to) → give NOUNS that fit context

IMPORTANT: If there's already "The/A/My" before the blank, DON'T give determiners!

Examples:
Start + verb → noun:
- 0=_ 1=ran 2=across → 0:He,She,Someone,The dog,A cat

Start + noun/adj → determiner:
- 0=_ 1=computer 2=crashed → 0:The,My,His,That,Our

Determiner + blank + noun → adjective:
- 0=The 1=_ 2=dog 3=barked → 1:big,small,brown,happy,loud

Verb after blank → noun:
- 0=The 1=_ 2=ran → 1:dog,boy,girl,athlete,child

Subject + blank + adverb → verb:
- 0=The 1=team 2=_ 3=convincingly → 2:won,lost,played,dominated,performed

Blank at END after preposition → contextual noun:
- ...5=app 6=using 7=_ → 7:Python,React,Flutter,Swift,Kotlin

Output format: INDEX:word1,word2,word3,word4,word5

Input: `;
