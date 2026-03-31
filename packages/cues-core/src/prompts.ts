/**
 * cues-core/prompts.ts
 *
 * System prompts for LLM-based cue sources.
 * These MUST match the files in ~/tweakcc/system_prompts/ exactly.
 * Both the inline code and bash scripts use these prompts.
 */

/**
 * Classifier prompt - determines MATH, FACTUAL, or GRAMMAR mode for blanks.
 * Matches: ~/tweakcc/system_prompts/classifier.txt
 */
export const CLASSIFIER_PROMPT = `Classify the input into one mode: MATH, FACTUAL, or GRAMMAR.

NOTE: This classifier only runs for inputs with blanks (_).
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

Classify: `;

/**
 * Math prompt - returns COMPUTE=expression for evaluation.
 * Matches: ~/tweakcc/system_prompts/blank_math.txt
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
 * Matches: ~/tweakcc/system_prompts/blank_factual.txt
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
 * Matches: ~/tweakcc/system_prompts/grammar.txt
 */
export const GRAMMAR_PROMPT = `Provide 3 alternatives per word: synonym, opposite, creative. Skip function words.
For BLANK (_): provide 5 words of the CORRECT TYPE (see BLANK rules below). NOT synonyms for nearby words!

Format: INDEX:alt1,alt2,alt3|INDEX:alt1,alt2

Examples:

Adjectives:
- 1=beautiful → 1:gorgeous,ugly,stunning
- 1=happy → 1:joyful,sad,cheerful
- 1=big → 1:large,small,enormous
- 1=fast → 1:quick,slow,rapid
- 1=old → 1:elderly,young,ancient
- 1=tall → 1:high,short,towering
- 1=loud → 1:quiet,soft,deafening
- 1=bright → 1:dim,brilliant,dazzling
- 1=hot → 1:cold,warm,scalding
- 1=cold → 1:hot,freezing,chilly
- 1=clean → 1:dirty,messy,spotless
- 1=easy → 1:hard,difficult,simple

Adverbs:
- 1=quickly → 1:slowly,rapidly,swiftly
- 1=softly → 1:loudly,quietly,gently
- 1=slowly → 1:quickly,gradually,leisurely
- 1=happily → 1:sadly,joyfully,cheerfully
- 1=loudly → 1:quietly,softly,noisily
- 1=silently → 1:loudly,quietly,stealthily
- 1=carefully → 1:carelessly,gently,cautiously
- 1=patiently → 1:impatiently,calmly,eagerly

Verbs:
- 1=ran → 1:walked,sprinted,jogged
- 1=said → 1:whispered,shouted,stated
- 1=looked → 1:glanced,stared,gazed
- 1=walked → 1:ran,strolled,marched
- 1=whispered → 1:shouted,murmured,screamed
- 1=demolished → 1:destroyed,built,obliterated

Nouns:
- 1=dog → 1:cat,wolf,puppy
- 1=boy → 1:girl,child,lad
- 1=man → 1:woman,person,gentleman

Proper Nouns (give similar entities, not synonyms):
- Companies: 1=Google → 1:Microsoft,Apple,Amazon
- Companies: 1=Tesla → 1:Ford,BMW,Toyota
- Companies: 1=Amazon → 1:Google,Microsoft,Apple
- People: 1=Einstein → 1:Newton,Darwin,Hawking
- Countries: 1=France → 1:Germany,Italy,Spain
- Cities: 1=Paris → 1:London,Tokyo,Berlin
- Universities: 1=Harvard → 1:Yale,MIT,Stanford
- Universities: 1=Oxford → 1:Cambridge,Harvard,Princeton
- Programming: 1=Python → 1:Java,JavaScript,C++
- Programming: 1=React → 1:Vue,Angular,Svelte
- Sports teams: 1=Lakers → 1:Celtics,Bulls,Warriors
- Sports teams: 1=Yankees → 1:Red Sox,Dodgers,Cubs
- Car brands: 1=BMW → 1:Mercedes,Audi,Tesla
- Car brands: 1=Toyota → 1:Honda,Ford,Chevrolet
- Currencies: 1=Dollar → 1:Euro,Pound,Yen
- Currencies: 1=Bitcoin → 1:Ethereum,Dogecoin,Litecoin
- Planets: 1=Mars → 1:Venus,Jupiter,Saturn
- Planets: 1=Earth → 1:Mars,Venus,Mercury
- Social media: 1=Twitter → 1:Facebook,Instagram,TikTok
- Social media: 1=YouTube → 1:Twitch,Vimeo,TikTok
- Streaming: 1=Netflix → 1:Hulu,Disney+,HBO
- Streaming: 1=Spotify → 1:Apple Music,Pandora,Tidal
- OS: 1=Windows → 1:macOS,Linux,Android
- OS: 1=iOS → 1:Android,Windows,Linux
- Sports: 1=Football → 1:Basketball,Tennis,Soccer
- Sports: 1=Golf → 1:Tennis,Baseball,Hockey
- Languages: 1=English → 1:Spanish,French,Chinese
- Languages: 1=Japanese → 1:Chinese,Korean,Vietnamese
- Months: 1=January → 1:February,March,December
- Months: 1=Summer → 1:Winter,Spring,Fall
- Days: 1=Monday → 1:Tuesday,Friday,Sunday
- Religions: 1=Christianity → 1:Islam,Buddhism,Judaism
- Historical: 1=WW2 → 1:WW1,Vietnam War,Civil War
- Musicians: 1=Beatles → 1:Rolling Stones,Queen,Led Zeppelin
- Musicians: 1=Mozart → 1:Beethoven,Bach,Chopin
- Job titles: 1=CEO → 1:CFO,CTO,President
- Job titles: 1=President → 1:CEO,Chairman,Director
- Job titles: 1=Manager → 1:Director,Supervisor,Lead
- Job titles: 1=Engineer → 1:Developer,Architect,Designer
- Job titles: 1=Doctor → 1:Nurse,Surgeon,Physician
- Job titles: 1=Teacher → 1:Professor,Instructor,Tutor
- Job titles: 1=Lawyer → 1:Attorney,Judge,Paralegal
- Job titles: 1=Chef → 1:Cook,Baker,Sous-chef
- Job titles: 1=Actor → 1:Actress,Director,Producer
- Job titles: 1=Author → 1:Writer,Novelist,Poet

Emotional:
- 1=sad → 1:happy,melancholy,depressed
- 1=angry → 1:calm,furious,enraged
- 1=excited → 1:bored,thrilled,eager
- 1=worried → 1:calm,anxious,concerned

BLANK/_ (the underscore _ is a PLACEHOLDER for a missing word - find words that fit grammatically):

NOTE: _ is a PLACEHOLDER. Fill it with a word that makes the sentence grammatical.

COMMON MISTAKES TO AVOID:
- DON'T give synonyms for "blank/underscore" like empty/void/missing/gap/space
- "The _ dog" → DON'T give nouns like cat/puppy (those replace "dog", not the blank!)
- "The _ dog" → DO give adjectives like big/small/brown (describes the dog)
- "The _ ran" → DON'T give adjectives like fast/quick (sentence needs a SUBJECT!)
- "The _ ran" → DO give nouns like dog/boy/man (subject of "ran")

KEY PRINCIPLE: The blank needs a DIFFERENT word type than the words around it!

STEP 1 - Is the word AFTER the blank a VERB?
Past tense verbs: ran, walked, jumped, spoke, slept, sang, ate, fell, flew, went, came, saw, took
Also: -ed endings (walked, jumped, talked, played, cried, laughed)
IF YES → blank needs NOUN (subject of verb). "The _ ran" needs dog/cat/boy NOT big/fast!

STEP 2 - Is the word AFTER the blank a NOUN?
Common nouns: dog, cat, boy, girl, man, woman, house, car, tree, bird, child
IF YES → blank needs ADJECTIVE. "The _ dog" needs big/small/brown.

STEP 3 - Is the word AFTER the blank an ADJECTIVE? (at start of sentence)
IF YES → blank needs DETERMINER. "_ quick fox" needs The/A/That.

STEP 4 - Is the word AFTER the blank an ADVERB?
Adverbs: quickly, slowly, loudly, softly, carefully (often -ly endings)
IF YES → blank needs VERB. "She _ quickly" needs ran/walked/moved.

Examples (in priority order):

1. VERB after blank → NOUN (most important - sentence needs subject!):
- 0=The 1=_ 2=ran → 1:dog,cat,boy,girl,man
- 0=The 1=_ 2=walked → 1:man,woman,child,dog,cat
- 0=The 1=_ 2=jumped → 1:frog,cat,boy,rabbit,athlete
- 0=The 1=_ 2=slept → 1:baby,cat,dog,child,man
- 0=The 1=_ 2=sang → 1:bird,choir,singer,woman,child

2. NOUN after blank → ADJECTIVE:
- 0=The 1=_ 2=dog → 1:big,small,brown,happy,loud
- 0=A 1=_ 2=cat → 1:fluffy,orange,small,cute,lazy

3. Start + ADJECTIVE/NOUN → DETERMINER:
- 0=_ 1=dog → 0:The,A,My,That,His
- 0=_ 1=quick 2=fox → 0:The,A,That,One,Each

4. Subject + _ + ADVERB → VERB:
- 0=She 1=_ 2=quickly → 1:ran,walked,moved,left,spoke
- 0=The 1=dog 2=_ 3=loudly → 2:barked,howled,growled,whined,yelped

Output ONLY index:alternatives format.

`;

/**
 * Blank grammar prompt for fill-in-the-blank (with underscore).
 * Matches: ~/tweakcc/system_prompts/blank_grammar.txt
 */
export const BLANK_GRAMMAR_PROMPT = `Fill the blank (_) with 5 words that make the sentence grammatical.

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

`;
