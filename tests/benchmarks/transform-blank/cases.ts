/**
 * transform-blank benchmark cases.
 *
 * Each case has an `input` (the full text the user typed, with `_` somewhere)
 * and an `expected.finalText` (what the input should look like after the
 * instruction next to `_` has been applied AND the instruction phrase itself
 * has been wiped).
 *
 * `expected.shouldFailSoft: true` means the input should NOT trigger a
 * transform — the model must bail (return null / empty edits) rather than
 * inventing changes. These cover ambiguous or non-imperative inputs.
 */

export interface TransformCase {
  id: string;
  category: 'literal' | 'concept' | 'transform' | 'negative' | 'multi-span' | 'math' | 'linked-concepts' | 'long-text' | 'targeted' | 'multi-paragraph' | 'conditional' | 'context-referring' | 'trailing-instruction';
  input: string;
  expected: {
    /** Final text after applying edits + wiping the instruction phrase. */
    finalText?: string;
    /** Acceptable variants — judged PASS if any matches. */
    finalTextAlternates?: string[];
    /** True when the model should refuse / bail. finalText is ignored. */
    shouldFailSoft?: boolean;
    /** Free-form description of what the test is exercising. */
    note?: string;
  };
}

export const CASES: TransformCase[] = [
  // ============================================================
  // LITERAL — direct find/replace, single span (10 cases)
  // ============================================================
  {
    id: 'literal-1',
    category: 'literal',
    input: 'change boy to girl _ the boy ran fast',
    expected: { finalText: 'the girl ran fast' },
  },
  {
    id: 'literal-2',
    category: 'literal',
    input: 'replace cat with dog _ I have a cat named whiskers',
    expected: { finalText: 'I have a dog named whiskers' },
  },
  {
    id: 'literal-3',
    category: 'literal',
    input: 'swap red for blue _ the red car is fast',
    expected: { finalText: 'the blue car is fast' },
  },
  {
    id: 'literal-4',
    category: 'literal',
    input: 'rename foo to bar _ function foo() { return foo + 1 }',
    expected: { finalText: 'function bar() { return bar + 1 }' },
  },
  {
    id: 'literal-5',
    category: 'literal',
    input: 'change Monday to Friday _ the meeting is on Monday',
    expected: { finalText: 'the meeting is on Friday' },
  },
  {
    id: 'literal-6',
    category: 'literal',
    input: 'replace 2025 with 2026 _ this report covers fiscal year 2025',
    expected: { finalText: 'this report covers fiscal year 2026' },
  },
  {
    id: 'literal-7',
    category: 'literal',
    input: 'change Alice to Bob _ Alice opened the door slowly',
    expected: { finalText: 'Bob opened the door slowly' },
  },
  {
    id: 'literal-8',
    category: 'literal',
    input: 'swap morning for evening _ I go for a run every morning',
    expected: { finalText: 'I go for a run every evening' },
  },
  {
    id: 'literal-9',
    category: 'literal',
    input: 'replace coffee with tea _ I would love a cup of coffee right now',
    expected: { finalText: 'I would love a cup of tea right now' },
  },
  {
    id: 'literal-10',
    category: 'literal',
    input: 'change Python to Rust _ the script is written in Python',
    expected: { finalText: 'the script is written in Rust' },
  },

  // ============================================================
  // MULTI-SPAN — same word appears multiple times (8 cases)
  // ============================================================
  {
    id: 'multi-1',
    category: 'multi-span',
    input: 'change boy to girl _ the boy and the other boy were friends',
    expected: { finalText: 'the girl and the other girl were friends' },
  },
  {
    id: 'multi-2',
    category: 'multi-span',
    input: 'replace USD with EUR _ price is 10 USD plus 2 USD shipping',
    expected: { finalText: 'price is 10 EUR plus 2 EUR shipping' },
  },
  {
    id: 'multi-3',
    category: 'multi-span',
    input: 'change he to she _ he came home and he saw her there',
    expected: { finalText: 'she came home and she saw her there' },
  },
  {
    id: 'multi-4',
    category: 'multi-span',
    input: 'rename count to total _ let count = 0; count += 1; return count',
    expected: { finalText: 'let total = 0; total += 1; return total' },
  },
  {
    id: 'multi-5',
    category: 'multi-span',
    input: 'replace tomorrow with next week _ tomorrow we ship and tomorrow we celebrate',
    expected: { finalText: 'next week we ship and next week we celebrate' },
  },
  {
    id: 'multi-6',
    category: 'multi-span',
    input: 'change cat to dog _ a cat sat on the mat near another cat',
    expected: { finalText: 'a dog sat on the mat near another dog' },
  },
  {
    id: 'multi-7',
    category: 'multi-span',
    input: 'swap red for blue _ a red apple, a red car, and a red shirt',
    expected: { finalText: 'a blue apple, a blue car, and a blue shirt' },
  },
  {
    id: 'multi-8',
    category: 'multi-span',
    input: 'rename user to account _ user.name = user.firstName + user.lastName',
    expected: { finalText: 'account.name = account.firstName + account.lastName' },
  },

  // ============================================================
  // CONCEPT — semantic swap (pronouns, gender, register pairs)  (10 cases)
  // ============================================================
  {
    id: 'concept-1',
    category: 'concept',
    input: 'he/she swap _ he gave the book to John',
    expected: { finalText: 'she gave the book to John' },
  },
  {
    id: 'concept-2',
    category: 'concept',
    input: 'make it british english _ the color of the harbor is gray',
    expected: { finalText: 'the colour of the harbour is grey' },
  },
  {
    id: 'concept-3',
    category: 'concept',
    input: 'swap genders _ the king visited his queen',
    expected: {
      finalText: 'the queen visited her king',
      finalTextAlternates: ['the queen visited his king'],
      note: 'pronoun coreference is genuinely ambiguous; either is acceptable',
    },
  },
  {
    id: 'concept-4',
    category: 'concept',
    input: 'make it american english _ the colour of the harbour is grey',
    expected: { finalText: 'the color of the harbor is gray' },
  },
  {
    id: 'concept-5',
    category: 'concept',
    input: 'expand contractions _ I won\'t go because I can\'t find it',
    expected: { finalText: 'I will not go because I cannot find it' },
  },
  {
    id: 'concept-6',
    category: 'concept',
    input: 'use contractions _ I will not go because I cannot find it',
    expected: { finalText: "I won't go because I can't find it" },
  },
  {
    id: 'concept-7',
    category: 'concept',
    input: 'first person to third person _ I went to the store and I bought milk',
    expected: {
      finalText: 'he went to the store and he bought milk',
      finalTextAlternates: [
        'she went to the store and she bought milk',
        'they went to the store and they bought milk',
      ],
    },
  },
  {
    id: 'concept-8',
    category: 'concept',
    input: 'singular to plural pronouns _ he is going to his house',
    expected: { finalText: 'they are going to their house' },
  },
  {
    id: 'concept-9',
    category: 'concept',
    input: 'remove all pronouns _ he gave her the book and she read it',
    expected: {
      finalText: 'gave the book and read',
      finalTextAlternates: [
        'gave book and read',
        'the person gave another the book and the other read it',
      ],
      note: 'open-ended; accept any rewrite that has no pronouns',
    },
  },
  {
    id: 'concept-10',
    category: 'concept',
    input: 'second person to first person _ you should check your email when you arrive',
    expected: { finalText: 'I should check my email when I arrive' },
  },

  // ============================================================
  // TRANSFORM — operations rather than swaps (12 cases)
  // ============================================================
  {
    id: 'transform-1',
    category: 'transform',
    input: 'make past tense _ I run to the store every day',
    expected: { finalText: 'I ran to the store every day' },
  },
  {
    id: 'transform-2',
    category: 'transform',
    input: 'capitalize proper nouns _ i visited paris and london last june',
    expected: { finalText: 'I visited Paris and London last June' },
  },
  {
    id: 'transform-3',
    category: 'transform',
    input: 'make it formal _ hey wanna grab lunch tomorrow',
    expected: {
      finalText: 'Would you like to have lunch tomorrow?',
      finalTextAlternates: [
        'Would you like to grab lunch tomorrow?',
        'Would you like to get lunch tomorrow?',
        'Hello, would you like to have lunch tomorrow?',
      ],
    },
  },
  {
    id: 'transform-4',
    category: 'transform',
    input: 'pluralize _ the child found one mouse',
    expected: { finalText: 'the children found mice' },
  },
  {
    id: 'transform-5',
    category: 'transform',
    input: 'make future tense _ she walks to school',
    expected: {
      finalText: 'she will walk to school',
      finalTextAlternates: ['she is going to walk to school'],
    },
  },
  {
    id: 'transform-6',
    category: 'transform',
    input: 'make it casual _ I would be most grateful if you could attend',
    expected: {
      finalText: 'It would be great if you could come',
      finalTextAlternates: [
        'It\'d be great if you could come',
        'Would love it if you could come',
        'Hope you can make it',
      ],
    },
  },
  {
    id: 'transform-7',
    category: 'transform',
    input: 'title case _ the lord of the rings is a great book',
    expected: { finalText: 'The Lord of the Rings Is a Great Book' },
  },
  {
    id: 'transform-8',
    category: 'transform',
    input: 'make it a question _ the meeting starts at 3pm',
    expected: {
      finalText: 'Does the meeting start at 3pm?',
      finalTextAlternates: ['When does the meeting start?', 'What time does the meeting start?'],
    },
  },
  {
    id: 'transform-9',
    category: 'transform',
    input: 'make it active voice _ the ball was kicked by the boy',
    expected: { finalText: 'the boy kicked the ball' },
  },
  {
    id: 'transform-10',
    category: 'transform',
    input: 'make it passive voice _ the chef cooked the meal',
    expected: { finalText: 'the meal was cooked by the chef' },
  },
  {
    id: 'transform-11',
    category: 'transform',
    input: 'spell out numbers _ I have 3 apples and 12 oranges',
    expected: { finalText: 'I have three apples and twelve oranges' },
  },
  {
    id: 'transform-12',
    category: 'transform',
    input: 'use numerals _ I have three apples and twelve oranges',
    expected: { finalText: 'I have 3 apples and 12 oranges' },
  },

  // ============================================================
  // NEGATIVE — should bail, not invent edits (10 cases)
  // ============================================================
  {
    id: 'negative-1',
    category: 'negative',
    input: 'capital of france _',
    expected: { shouldFailSoft: true, note: 'pure lookup — fluid-blank territory' },
  },
  {
    id: 'negative-2',
    category: 'negative',
    input: 'click _ to continue and then submit the form',
    expected: { shouldFailSoft: true, note: 'UI placeholder, no instruction' },
  },
  {
    id: 'negative-3',
    category: 'negative',
    input: 'change of plans _ we meet at 3pm',
    expected: { shouldFailSoft: true, note: '"change of plans" is idiom, not edit command' },
  },
  {
    id: 'negative-4',
    category: 'negative',
    input: 'I need to change boy to girl in this story _',
    expected: { shouldFailSoft: true, note: 'instruction stated but no target text yet' },
  },
  {
    id: 'negative-5',
    category: 'negative',
    input: 'change of heart _ she decided to stay after all',
    expected: { shouldFailSoft: true, note: '"change of heart" is idiom' },
  },
  {
    id: 'negative-6',
    category: 'negative',
    input: 'speaking of which _ I saw your brother yesterday',
    expected: { shouldFailSoft: true, note: 'discourse marker, not an instruction' },
  },
  {
    id: 'negative-7',
    category: 'negative',
    input: 'make sense of this _ the data shows three peaks but no troughs',
    expected: { shouldFailSoft: true, note: '"make sense of" is a request for analysis, not text-edit' },
  },
  {
    id: 'negative-8',
    category: 'negative',
    input: 'unicode for ampersand _',
    expected: { shouldFailSoft: true, note: 'pure lookup — fluid-blank territory' },
  },
  {
    id: 'negative-9',
    category: 'negative',
    input: 'the price changed from 10 to 12 _',
    expected: { shouldFailSoft: true, note: 'narrative use of "changed", not an edit command' },
  },
  {
    id: 'negative-10',
    category: 'negative',
    input: 'we need a swap _ but I dont know who to ask',
    expected: { shouldFailSoft: true, note: '"swap" used as noun, no edit target' },
  },

  // ============================================================
  // MATH — edits where dependent numbers must update together (10 cases)
  // ============================================================
  {
    id: 'math-1',
    category: 'math',
    input: 'fix the math _ 2 + 3 = 4',
    expected: { finalText: '2 + 3 = 5' },
  },
  {
    id: 'math-2',
    category: 'math',
    input: 'recalculate _ I bought 5 apples at $2 each, total $8',
    expected: { finalText: 'I bought 5 apples at $2 each, total $10' },
  },
  {
    id: 'math-3',
    category: 'math',
    input: 'double the numbers _ I have 3 apples and 6 oranges',
    expected: { finalText: 'I have 6 apples and 12 oranges' },
  },
  {
    id: 'math-4',
    category: 'math',
    input: 'convert to celsius _ water boils at 212 degrees fahrenheit',
    expected: {
      finalText: 'water boils at 100 degrees celsius',
      finalTextAlternates: ['water boils at 100 °C', 'water boils at 100 degrees Celsius'],
    },
  },
  {
    id: 'math-5',
    category: 'math',
    input: 'convert to kilometers _ the marathon is 26.2 miles long',
    expected: {
      finalText: 'the marathon is 42.2 kilometers long',
      finalTextAlternates: ['the marathon is 42.16 kilometers long', 'the marathon is 42 kilometers long'],
    },
  },
  {
    id: 'math-6',
    category: 'math',
    input: 'update bill for 20% tip _ the bill was $50, tip is $5, total $55',
    expected: { finalText: 'the bill was $50, tip is $10, total $60' },
  },
  {
    id: 'math-7',
    category: 'math',
    input: 'change unit price to $5 _ I bought 3 widgets at $4 each, total $12',
    expected: { finalText: 'I bought 3 widgets at $5 each, total $15' },
  },
  {
    id: 'math-8',
    category: 'math',
    input: 'make it half _ I worked 8 hours and earned 80 dollars',
    expected: { finalText: 'I worked 4 hours and earned 40 dollars' },
  },
  {
    id: 'math-9',
    category: 'math',
    input: 'add 10% _ original price 100, final price 100',
    expected: { finalText: 'original price 100, final price 110' },
  },
  {
    id: 'math-10',
    category: 'math',
    input: 'fix totals for 3 items at $4 _ I bought 3 widgets at $4 each, total $10',
    expected: { finalText: 'I bought 3 widgets at $4 each, total $12' },
  },

  // ============================================================
  // LINKED-CONCEPTS — semantic edits where changing one word triggers
  // updates to related vocabulary (10 cases)
  // ============================================================
  {
    id: 'linked-1',
    category: 'linked-concepts',
    input: 'change protagonist to wizard _ the knight drew his sword and charged the dragon',
    expected: {
      finalText: 'the wizard drew his wand and charged the dragon',
      finalTextAlternates: [
        'the wizard drew his staff and charged the dragon',
        'the wizard cast his spell and charged the dragon',
      ],
    },
  },
  {
    id: 'linked-2',
    category: 'linked-concepts',
    input: 'switch to winter _ I love summer afternoons swimming at the beach in my swimsuit',
    expected: {
      finalText: 'I love winter afternoons skiing at the slopes in my coat',
      finalTextAlternates: [
        'I love winter afternoons sledding at the hill in my coat',
        'I love winter afternoons skating at the rink in my coat',
        'I love winter afternoons skiing in the mountains in my coat',
        'I love winter afternoons skiing at the mountain in my coat',
        'I love winter afternoons sledding in the snow wearing my coat',
        'I love winter afternoons sledding at the snow in my coat',
      ],
    },
  },
  {
    id: 'linked-3',
    category: 'linked-concepts',
    input: 'change setting to ocean _ the camel walked across the dunes carrying water in its hump',
    expected: {
      finalText: 'the fish swam across the waves carrying water in its gills',
      finalTextAlternates: [
        'the whale swam across the waves carrying water in its blowhole',
        'the dolphin swam across the waves carrying water in its body',
        'the seal swam across the waves carrying water in its blubber',
        'the seal swam across the waves carrying water in its body',
      ],
      note: 'open-ended; accept any rewrite that consistently swaps desert→ocean vocabulary while preserving the "carrying water in its X" structure',
    },
  },
  {
    id: 'linked-4',
    category: 'linked-concepts',
    input: 'change era to medieval _ she sent him an email from her phone',
    expected: {
      finalText: 'she sent him a letter by messenger',
      finalTextAlternates: [
        'she sent him a letter from her chambers',
        'she sent him a scroll by messenger',
        'she sent him a letter by carrier',
      ],
    },
  },
  {
    id: 'linked-5',
    category: 'linked-concepts',
    input: 'convert to vegetarian _ I made a burger with bacon and a beef patty',
    expected: {
      finalText: 'I made a burger with mushrooms and a bean patty',
      finalTextAlternates: [
        'I made a burger with avocado and a veggie patty',
        'I made a burger with mushrooms and a black bean patty',
        'I made a veggie burger with mushrooms and a bean patty',
      ],
    },
  },
  {
    id: 'linked-6',
    category: 'linked-concepts',
    input: 'change country from US to Japan _ I had bagels and coffee for breakfast',
    expected: {
      finalText: 'I had miso soup and green tea for breakfast',
      finalTextAlternates: [
        'I had rice and miso soup for breakfast',
        'I had sushi and green tea for breakfast',
        'I had natto and rice for breakfast',
      ],
    },
  },
  {
    id: 'linked-7',
    category: 'linked-concepts',
    input: 'switch sport from basketball to soccer _ he dribbled past defenders and dunked the ball',
    expected: {
      finalText: 'he dribbled past defenders and kicked the ball into the goal',
      finalTextAlternates: [
        'he dribbled past defenders and scored a goal',
        'he dribbled past defenders and shot the ball into the net',
        'he dribbled past defenders and kicked the ball into the net',
      ],
    },
  },
  {
    id: 'linked-8',
    category: 'linked-concepts',
    input: 'change profession from doctor to teacher _ the doctor prescribed medicine for the patient',
    expected: {
      finalText: 'the teacher assigned homework for the student',
      finalTextAlternates: [
        'the teacher gave a lesson to the student',
        'the teacher assigned reading for the student',
      ],
    },
  },
  {
    id: 'linked-9',
    category: 'linked-concepts',
    input: 'change pet from dog to cat _ the dog wagged its tail and barked at the postman',
    expected: {
      finalText: 'the cat swished its tail and meowed at the postman',
      finalTextAlternates: [
        'the cat flicked its tail and meowed at the postman',
        'the cat twitched its tail and hissed at the postman',
      ],
    },
  },
  {
    id: 'linked-10',
    category: 'linked-concepts',
    input: 'change vehicle from bike to car _ I rode my bike to school and my helmet kept me safe',
    expected: {
      finalText: 'I drove my car to school and my seatbelt kept me safe',
      finalTextAlternates: [
        'I drove my car to school and my seat belt kept me safe',
        'I drove my car to school and my airbag kept me safe',
      ],
    },
  },

  // ============================================================
  // LONG-TEXT — 4 buckets, 5 cases each (20 total)
  //
  // Bucket A: Pure length stress — same edit type, but over 30+ words
  // Bucket B: Multi-sentence scope — instruction must apply across sentences
  // Bucket C: Mixed-edit composition — instruction combines two transforms
  // Bucket D: Long math — recalc across multiple line items / dependent values
  // ============================================================

  // ---- Bucket A: Pure length stress ----
  {
    id: 'long-A1',
    category: 'long-text',
    input: 'change boy to girl _ the boy ran to the park where the boy met another boy and the three of them played games until the boy had to go home for dinner',
    expected: {
      finalText: 'the girl ran to the park where the girl met another girl and the three of them played games until the girl had to go home for dinner',
    },
  },
  {
    id: 'long-A2',
    category: 'long-text',
    input: 'make past tense _ I wake up early and brush my teeth then I go downstairs and make coffee while my dog watches me from the kitchen door wagging his tail',
    expected: {
      finalText: 'I woke up early and brushed my teeth then I went downstairs and made coffee while my dog watched me from the kitchen door wagging his tail',
    },
  },
  {
    id: 'long-A3',
    category: 'long-text',
    input: 'capitalize proper nouns _ last summer i visited paris with my friend james and we went to the louvre then took a train to london where we met sarah at heathrow airport',
    expected: {
      finalText: 'last summer I visited Paris with my friend James and we went to the Louvre then took a train to London where we met Sarah at Heathrow Airport',
    },
  },
  {
    id: 'long-A4',
    category: 'long-text',
    input: 'make it british english _ the color of the harbor reflected the gray sky as we walked along the sidewalk past the theater toward our favorite restaurant where we ordered fries with our meal',
    expected: {
      finalText: 'the colour of the harbour reflected the grey sky as we walked along the pavement past the theatre toward our favourite restaurant where we ordered chips with our meal',
      finalTextAlternates: [
        'the colour of the harbour reflected the grey sky as we walked along the pavement past the theatre towards our favourite restaurant where we ordered chips with our meal',
      ],
    },
  },
  {
    id: 'long-A5',
    category: 'long-text',
    input: 'change he to she _ he came home from work and he opened the door then he saw the cat waiting for him on the couch and he smiled because he had missed her all day',
    expected: {
      finalText: 'she came home from work and she opened the door then she saw the cat waiting for her on the couch and she smiled because she had missed her all day',
    },
  },

  // ---- Bucket B: Multi-sentence scope ----
  {
    id: 'long-B1',
    category: 'long-text',
    input: 'change boy to girl _ The boy walked into the kitchen. He poured himself a glass of milk. Then the boy sat at the table and read his book until his mother called him for dinner.',
    expected: {
      finalText: 'The girl walked into the kitchen. She poured herself a glass of milk. Then the girl sat at the table and read her book until her mother called her for dinner.',
    },
  },
  {
    id: 'long-B2',
    category: 'long-text',
    input: 'make past tense _ I wake up at six. I make breakfast for the family. After everyone eats, I leave for work and drive across town. I arrive at the office by eight thirty.',
    expected: {
      finalText: 'I woke up at six. I made breakfast for the family. After everyone ate, I left for work and drove across town. I arrived at the office by eight thirty.',
    },
  },
  {
    id: 'long-B3',
    category: 'long-text',
    input: 'make it formal _ hey wanna grab coffee tomorrow? been ages since we caught up. lemme know if morning works for you. cool, see ya then.',
    expected: {
      finalText: 'Hello, would you like to have coffee tomorrow? It has been a long time since we last spoke. Please let me know if the morning is convenient for you. Wonderful, I will see you then.',
      finalTextAlternates: [
        'Hello, would you like to get coffee tomorrow? It has been a long time since we caught up. Please let me know if morning works for you. Wonderful, I will see you then.',
        'Hello, would you like to grab coffee tomorrow? It has been a long time since we caught up. Please let me know if morning is convenient for you. Excellent, I will see you then.',
      ],
      note: 'register transform across multiple sentences; accept any clearly-formal version',
    },
  },
  {
    id: 'long-B4',
    category: 'long-text',
    input: 'change setting to ocean _ The camel walked across the dunes. The sand burned its hooves. In the distance, the camel saw an oasis where it could rest and drink before continuing its journey.',
    expected: {
      finalText: 'The fish swam across the waves. The water cooled its scales. In the distance, the fish saw a coral reef where it could rest and drink before continuing its journey.',
      finalTextAlternates: [
        'The whale swam across the waves. The water cooled its skin. In the distance, the whale saw a coral reef where it could rest before continuing its journey.',
        'The fish swam across the waves. The water cooled its scales. In the distance, the fish saw a reef where it could rest before continuing its journey.',
      ],
      note: 'open-ended; accept any consistent desert→ocean rewrite that preserves sentence structure',
    },
  },
  {
    id: 'long-B5',
    category: 'long-text',
    input: 'pluralize _ The child found one mouse in the garden. The mouse ran away. Then the child saw a butterfly land on a flower and watched it for a long time.',
    expected: {
      finalText: 'The children found mice in the garden. The mice ran away. Then the children saw butterflies land on flowers and watched them for a long time.',
      finalTextAlternates: [
        'The children found mice in the garden. The mice ran away. Then the children saw butterflies land on the flowers and watched them for a long time.',
      ],
    },
  },

  // ---- Bucket C: Mixed-edit composition ----
  {
    id: 'long-C1',
    category: 'long-text',
    input: 'make past tense and remove pronouns _ I run to the store and I buy milk then I walk home and I pet my dog before I go to bed',
    expected: {
      finalText: 'ran to the store and bought milk then walked home and pet the dog before going to bed',
      finalTextAlternates: [
        'ran to the store and bought milk then walked home and petted the dog before going to bed',
        'ran to the store and bought milk then walked home and pet the dog before bed',
      ],
      note: 'two transforms composed; accept reasonable variants',
    },
  },
  {
    id: 'long-C2',
    category: 'long-text',
    input: 'expand contractions and capitalize proper nouns _ i won\'t go to paris because i can\'t find my passport but maybe james can lend me his copy of the map',
    expected: {
      finalText: 'I will not go to Paris because I cannot find my passport but maybe James can lend me his copy of the map',
    },
  },
  {
    id: 'long-C3',
    category: 'long-text',
    input: 'make it british english and past tense _ I drive my car to the harbor and watch the gray waves roll in while I drink coffee from a paper cup',
    expected: {
      finalText: 'I drove my car to the harbour and watched the grey waves roll in while I drank coffee from a paper cup',
    },
  },
  {
    id: 'long-C4',
    category: 'long-text',
    input: 'pluralize and make past tense _ the child runs to the park and finds one mouse hiding under a leaf then chases it across the grass',
    expected: {
      finalText: 'the children ran to the parks and found mice hiding under leaves then chased them across the grass',
      finalTextAlternates: [
        'the children ran to the park and found mice hiding under leaves then chased them across the grass',
      ],
      note: 'pluralization across long target with verb agreement',
    },
  },
  {
    id: 'long-C5',
    category: 'long-text',
    input: 'swap genders and make past tense _ the king walks through his castle and visits his queen who is reading a book in her chambers near the south tower',
    expected: {
      finalText: 'the queen walked through her castle and visited her king who was reading a book in his chambers near the south tower',
      finalTextAlternates: [
        'the queen walked through her castle and visited his king who was reading a book in her chambers near the south tower',
      ],
      note: 'pronoun coreference is ambiguous after swap',
    },
  },

  // ---- Bucket D: Long math ----
  {
    id: 'long-D1',
    category: 'long-text',
    input: 'recalculate the totals _ Item A: 3 widgets at $4 each = $12. Item B: 2 gadgets at $5 each = $10. Subtotal: $22. Tax (10%): $2.20. Total: $24.20.',
    expected: {
      finalText: 'Item A: 3 widgets at $4 each = $12. Item B: 2 gadgets at $5 each = $10. Subtotal: $22. Tax (10%): $2.20. Total: $24.20.',
      finalTextAlternates: [],
      note: 'math is already correct; rewrite should preserve verbatim. Tests over-eagerness on long math.',
    },
  },
  {
    id: 'long-D2',
    category: 'long-text',
    input: 'fix the math _ Item A: 3 widgets at $4 each = $10. Item B: 2 gadgets at $5 each = $8. Subtotal: $20. Tax (10%): $2. Total: $25.',
    expected: {
      finalText: 'Item A: 3 widgets at $4 each = $12. Item B: 2 gadgets at $5 each = $10. Subtotal: $22. Tax (10%): $2.20. Total: $24.20.',
      finalTextAlternates: [
        'Item A: 3 widgets at $4 each = $12. Item B: 2 gadgets at $5 each = $10. Subtotal: $22. Tax (10%): $2.2. Total: $24.2.',
      ],
    },
  },
  {
    id: 'long-D3',
    category: 'long-text',
    input: 'change tax rate to 20% _ Item A: $30. Item B: $50. Item C: $20. Subtotal: $100. Tax (10%): $10. Total: $110.',
    expected: {
      finalText: 'Item A: $30. Item B: $50. Item C: $20. Subtotal: $100. Tax (20%): $20. Total: $120.',
    },
  },
  {
    id: 'long-D4',
    category: 'long-text',
    input: 'apply 25% discount _ Apples: $4. Bananas: $3. Cherries: $5. Subtotal: $12. Total: $12.',
    expected: {
      finalText: 'Apples: $4. Bananas: $3. Cherries: $5. Subtotal: $12. Discount (25%): $3. Total: $9.',
      finalTextAlternates: [
        'Apples: $3. Bananas: $2.25. Cherries: $3.75. Subtotal: $9. Total: $9.',
        'Apples: $3. Bananas: $2.25. Cherries: $3.75. Subtotal: $9. Total: $9.00.',
      ],
      note: 'two valid interpretations: discount as separate line, or discount applied per-item',
    },
  },
  {
    id: 'long-D5',
    category: 'long-text',
    input: 'convert all to euros at 1 USD = 0.9 EUR _ Coffee: $5. Sandwich: $10. Tip: $3. Total: $18.',
    expected: {
      finalText: 'Coffee: €4.50. Sandwich: €9. Tip: €2.70. Total: €16.20.',
      finalTextAlternates: [
        'Coffee: €4.5. Sandwich: €9. Tip: €2.7. Total: €16.2.',
        'Coffee: 4.50 EUR. Sandwich: 9 EUR. Tip: 2.70 EUR. Total: 16.20 EUR.',
        'Coffee: €4.50. Sandwich: €9.00. Tip: €2.70. Total: €16.20.',
      ],
    },
  },

  // ============================================================
  // TARGETED — transformations with explicit category-scope.
  // Tests whether APPLY can correctly identify which words fall in scope
  // (names, brands, months, etc.) and apply the operation only to those.
  //
  // Single-scope:    capitalize the names
  // Multi-scope:     capitalize names, places, and months
  // Composition:     capitalize the names and uppercase the brands
  // Exclusion:       lowercase everything except the proper nouns
  // Position scope:  capitalize the first letter of each sentence
  // ============================================================

  {
    id: 'targeted-1',
    category: 'targeted',
    input: 'capitalize the names _ i had lunch with james and sarah at the new restaurant',
    expected: {
      finalText: 'i had lunch with James and Sarah at the new restaurant',
    },
  },
  {
    id: 'targeted-2',
    category: 'targeted',
    input: 'uppercase the brand names _ i bought apple and samsung phones online last week',
    expected: {
      finalText: 'i bought APPLE and SAMSUNG phones online last week',
    },
  },
  {
    id: 'targeted-3',
    category: 'targeted',
    input: 'lowercase the days _ I went to the gym on Monday and Friday this week',
    expected: {
      finalText: 'I went to the gym on monday and friday this week',
    },
  },
  {
    id: 'targeted-4',
    category: 'targeted',
    input: 'capitalize the months _ I was born in march and my brother in october',
    expected: {
      finalText: 'I was born in March and my brother in October',
    },
  },
  {
    id: 'targeted-5',
    category: 'targeted',
    input: 'title case the headline _ breaking news scientists discover new planet near earth',
    expected: {
      finalText: 'Breaking News Scientists Discover New Planet Near Earth',
      finalTextAlternates: [
        'Breaking News Scientists Discover a New Planet Near Earth',
      ],
    },
  },
  {
    id: 'targeted-6',
    category: 'targeted',
    input: 'capitalize names, places, and months _ john visited paris in march for his birthday',
    expected: {
      finalText: 'John visited Paris in March for his birthday',
    },
  },
  {
    id: 'targeted-7',
    category: 'targeted',
    input: 'capitalize the names and uppercase the brands _ james bought apple stock and sarah bought tesla',
    expected: {
      finalText: 'James bought APPLE stock and Sarah bought TESLA',
    },
  },
  {
    id: 'targeted-8',
    category: 'targeted',
    input: 'capitalize names, uppercase brands, and lowercase days _ alice bought nike on monday and bob bought adidas on tuesday',
    expected: {
      finalText: 'Alice bought NIKE on monday and Bob bought ADIDAS on tuesday',
    },
  },
  {
    id: 'targeted-9',
    category: 'targeted',
    input: 'capitalize the first letter of each sentence _ hello there. how are you doing today. i am fine thanks for asking.',
    expected: {
      finalText: 'Hello there. How are you doing today. I am fine thanks for asking.',
    },
  },
  {
    id: 'targeted-10',
    category: 'targeted',
    input: 'lowercase everything except the proper nouns _ JOHN WENT TO PARIS LAST SUMMER WITH HIS FRIEND SARAH',
    expected: {
      finalText: 'John went to Paris last summer with his friend Sarah',
    },
  },

  // ============================================================
  // MULTI-PARAGRAPH — 50-200 word inputs, edits across multiple ¶s
  // ============================================================
  {
    id: 'mp-1',
    category: 'multi-paragraph',
    input: 'make past tense _ I wake up at six. I make coffee. I sit at the kitchen table and read the news on my phone.\n\nLater I take the dog for a walk in the park. We see other people walking their dogs. The dog wags his tail at every passerby.',
    expected: {
      finalText: 'I woke up at six. I made coffee. I sat at the kitchen table and read the news on my phone.\n\nLater I took the dog for a walk in the park. We saw other people walking their dogs. The dog wagged his tail at every passerby.',
    },
  },
  {
    id: 'mp-2',
    category: 'multi-paragraph',
    input: 'change protagonist to wizard _ The knight rode his horse through the forest. He carried his sword at his side. The morning sun glinted off his armor.\n\nAt the edge of the woods, he saw the dragon. The knight drew his sword and charged.',
    expected: {
      finalText: 'The wizard rode his horse through the forest. He carried his staff at his side. The morning sun glinted off his robes.\n\nAt the edge of the woods, he saw the dragon. The wizard drew his staff and charged.',
      finalTextAlternates: [
        'The wizard rode his horse through the forest. He carried his wand at his side. The morning sun glinted off his robes.\n\nAt the edge of the woods, he saw the dragon. The wizard drew his wand and charged.',
      ],
    },
  },
  {
    id: 'mp-3',
    category: 'multi-paragraph',
    input: 'change boy to girl _ The boy walked into the kitchen. His mother smiled at him.\n\nThe boy poured himself a glass of milk and sat at the table. His sister joined him. They ate breakfast together while the boy read his comic book.',
    expected: {
      finalText: 'The girl walked into the kitchen. Her mother smiled at her.\n\nThe girl poured herself a glass of milk and sat at the table. Her sister joined her. They ate breakfast together while the girl read her comic book.',
    },
  },
  {
    id: 'mp-4',
    category: 'multi-paragraph',
    input: 'make it british english _ The color of the harbor was gray under the afternoon sky. We walked along the sidewalk past the old theater toward our favorite restaurant.\n\nThe waiter brought us fries with our meal. We finished with cookies and a check that came to twenty dollars.',
    expected: {
      finalText: 'The colour of the harbour was grey under the afternoon sky. We walked along the pavement past the old theatre toward our favourite restaurant.\n\nThe waiter brought us chips with our meal. We finished with biscuits and a bill that came to twenty pounds.',
      finalTextAlternates: [
        'The colour of the harbour was grey under the afternoon sky. We walked along the pavement past the old theatre towards our favourite restaurant.\n\nThe waiter brought us chips with our meal. We finished with biscuits and a bill that came to twenty pounds.',
        'The colour of the harbour was grey under the afternoon sky. We walked along the pavement past the old theatre toward our favourite restaurant.\n\nThe waiter brought us chips with our meal. We finished with biscuits and a bill that came to twenty dollars.',
      ],
    },
  },
  {
    id: 'mp-5',
    category: 'multi-paragraph',
    input: 'change setting to ocean _ The camel walked slowly across the dunes. The sand burned its hooves with each step. In the distance shimmered an oasis.\n\nThe traveler had been riding for three days. He needed to find shelter from the desert sun before nightfall fell on the dunes.',
    expected: {
      finalText: 'The fish swam slowly across the waves. The water cooled its scales with each motion. In the distance shimmered a coral reef.\n\nThe traveler had been swimming for three days. He needed to find shelter from the ocean currents before nightfall fell on the waves.',
      finalTextAlternates: [
        'The dolphin swam slowly across the waves. The water cooled its skin with each motion. In the distance shimmered a coral reef.\n\nThe traveler had been swimming for three days. He needed to find shelter from the ocean currents before nightfall fell on the waves.',
      ],
      note: 'open-ended ocean rewrite preserving structure',
    },
  },
  {
    id: 'mp-6',
    category: 'multi-paragraph',
    input: 'change he to she _ He walked into the office and sat at his desk. He opened his laptop and checked his email. He had three messages from his manager.\n\nHe responded to each one carefully. He thought about what to say. He sent the replies and went to get coffee from the break room.',
    expected: {
      finalText: 'She walked into the office and sat at her desk. She opened her laptop and checked her email. She had three messages from her manager.\n\nShe responded to each one carefully. She thought about what to say. She sent the replies and went to get coffee from the break room.',
    },
  },
  {
    id: 'mp-7',
    category: 'multi-paragraph',
    input: 'capitalize names and proper nouns _ john and sarah went to paris last june. they visited the louvre and walked along the seine.\n\nin the evening they had dinner near notre dame. james joined them at the restaurant. afterwards they took the metro back to their hotel near the eiffel tower.',
    expected: {
      finalText: 'John and Sarah went to Paris last June. They visited the Louvre and walked along the Seine.\n\nIn the evening they had dinner near Notre Dame. James joined them at the restaurant. Afterwards they took the Metro back to their hotel near the Eiffel Tower.',
      finalTextAlternates: [
        'John and Sarah went to Paris last June. They visited the Louvre and walked along the Seine.\n\nIn the evening they had dinner near Notre Dame. James joined them at the restaurant. Afterwards they took the metro back to their hotel near the Eiffel Tower.',
      ],
    },
  },
  {
    id: 'mp-8',
    category: 'multi-paragraph',
    input: 'pluralize _ The child found one mouse in the garden. The mouse ran away under a leaf.\n\nThen the child saw a butterfly land on a flower. The butterfly opened its wing and flew off when the child got close. The child sighed and walked back to the house.',
    expected: {
      finalText: 'The children found mice in the garden. The mice ran away under leaves.\n\nThen the children saw butterflies land on flowers. The butterflies opened their wings and flew off when the children got close. The children sighed and walked back to the houses.',
      finalTextAlternates: [
        'The children found mice in the garden. The mice ran away under leaves.\n\nThen the children saw butterflies land on flowers. The butterflies opened their wings and flew off when the children got close. The children sighed and walked back to the house.',
      ],
    },
  },
  {
    id: 'mp-9',
    category: 'multi-paragraph',
    input: 'make past tense and remove pronouns _ I drive to the office every morning. I park my car in the garage. I take the elevator to the fifth floor.\n\nI greet my coworkers. I sit at my desk. I check my email and start working on the report that is due by noon.',
    expected: {
      finalText: 'drove to the office every morning. parked the car in the garage. took the elevator to the fifth floor.\n\ngreeted the coworkers. sat at the desk. checked the email and started working on the report that was due by noon.',
      finalTextAlternates: [
        'drove to the office every morning. parked car in the garage. took the elevator to the fifth floor.\n\ngreeted coworkers. sat at the desk. checked email and started working on the report that was due by noon.',
      ],
      note: 'composition over multiple paragraphs',
    },
  },
  {
    id: 'mp-10',
    category: 'multi-paragraph',
    input: 'double the numbers _ I bought 3 apples and 5 oranges at the market. The total came to 8 dollars.\n\nThe next day I went back. This time I bought 2 bananas and 4 pears. I spent another 7 dollars. By the end of the week I had eaten all 14 pieces of fruit.',
    expected: {
      finalText: 'I bought 6 apples and 10 oranges at the market. The total came to 16 dollars.\n\nThe next day I went back. This time I bought 4 bananas and 8 pears. I spent another 14 dollars. By the end of the week I had eaten all 28 pieces of fruit.',
    },
  },

  // ============================================================
  // CONDITIONAL — instructions with exclusions / scopes
  // ============================================================
  {
    id: 'cond-1',
    category: 'conditional',
    input: 'change boy to girl but not in the second sentence _ The boy ran to the park. The boy met another boy there. They played until the boy went home.',
    expected: {
      finalText: 'The girl ran to the park. The boy met another boy there. They played until the girl went home.',
    },
  },
  {
    id: 'cond-2',
    category: 'conditional',
    input: 'capitalize names but only the first names _ john smith and sarah jones went to lunch with james taylor',
    expected: {
      finalText: 'John smith and Sarah jones went to lunch with James taylor',
    },
  },
  {
    id: 'cond-3',
    category: 'conditional',
    input: 'uppercase brands except apple _ i bought apple, samsung, and sony products',
    expected: {
      finalText: 'i bought apple, SAMSUNG, and SONY products',
    },
  },
  {
    id: 'cond-4',
    category: 'conditional',
    input: 'lowercase the days but keep weekend ones capitalized _ I work on Monday Tuesday Wednesday Thursday Friday Saturday Sunday',
    expected: {
      finalText: 'I work on monday tuesday wednesday thursday friday Saturday Sunday',
    },
  },
  {
    id: 'cond-5',
    category: 'conditional',
    input: 'pluralize except mass nouns _ the child drank water and ate one cookie at the table',
    expected: {
      finalText: 'the children drank water and ate cookies at the tables',
      finalTextAlternates: [
        'the children drank water and ate cookies at tables',
      ],
    },
  },
  {
    id: 'cond-6',
    category: 'conditional',
    input: 'make past tense except in dialogue _ He walks into the room and says, "I am happy to see you." Then he sits down.',
    expected: {
      finalText: 'He walked into the room and said, "I am happy to see you." Then he sat down.',
    },
  },
  {
    id: 'cond-7',
    category: 'conditional',
    input: 'change he to she only when referring to the doctor _ He met the doctor at the clinic. He shook the doctor\'s hand. The doctor said he was running late.',
    expected: {
      finalText: 'He met the doctor at the clinic. He shook the doctor\'s hand. The doctor said she was running late.',
    },
  },
  {
    id: 'cond-8',
    category: 'conditional',
    input: 'remove pronouns except in quoted speech _ I went home. I told my mom, "I am tired and I want to sleep." Then I went to bed.',
    expected: {
      finalText: 'went home. told mom, "I am tired and I want to sleep." Then went to bed.',
      finalTextAlternates: [
        'went home. told the mom, "I am tired and I want to sleep." Then went to bed.',
      ],
    },
  },
  {
    id: 'cond-9',
    category: 'conditional',
    input: 'capitalize only proper nouns not common nouns _ john visited paris and rome with his friend sarah and her dog',
    expected: {
      finalText: 'John visited Paris and Rome with his friend Sarah and her dog',
    },
  },
  {
    id: 'cond-10',
    category: 'conditional',
    input: 'change boy to girl but only in the first paragraph _ The boy ran to the park.\n\nThe boy met another boy there.',
    expected: {
      finalText: 'The girl ran to the park.\n\nThe boy met another boy there.',
    },
  },

  // ============================================================
  // CONTEXT-REFERRING — edits that depend on style/structure
  // observable elsewhere in the input text
  // ============================================================
  {
    id: 'ctx-1',
    category: 'context-referring',
    input: 'match the tense of the first sentence in the rest _ I walked to the store. Then I buy milk. Then I walk home.',
    expected: {
      finalText: 'I walked to the store. Then I bought milk. Then I walked home.',
    },
  },
  {
    id: 'ctx-2',
    category: 'context-referring',
    input: 'use the same person as the first sentence _ I went to the office. He sat at his desk. He checked his email.',
    expected: {
      finalText: 'I went to the office. I sat at my desk. I checked my email.',
    },
  },
  {
    id: 'ctx-3',
    category: 'context-referring',
    input: 'match the formality of the first sentence _ I would be most grateful for your assistance. yo can u help me out. thx fam.',
    expected: {
      finalText: 'I would be most grateful for your assistance. Could you please help me. Thank you very much.',
      finalTextAlternates: [
        'I would be most grateful for your assistance. May I please ask for your help. Thank you sincerely.',
        'I would be most grateful for your assistance. Would you kindly help me. I thank you very much.',
        'I would be most grateful for your assistance. Could you please help me out. Thank you very much.',
      ],
    },
  },
  {
    id: 'ctx-4',
    category: 'context-referring',
    input: 'use the same number style throughout _ I have three apples and 5 oranges and twelve pears.',
    expected: {
      finalText: 'I have three apples and five oranges and twelve pears.',
      finalTextAlternates: [
        'I have 3 apples and 5 oranges and 12 pears.',
      ],
    },
  },
  {
    id: 'ctx-5',
    category: 'context-referring',
    input: 'match the punctuation style of the first sentence _ Hey, how are you? I am fine thanks. What about you',
    expected: {
      finalText: 'Hey, how are you? I am fine, thanks? What about you?',
      finalTextAlternates: [
        'Hey, how are you? I am fine, thanks. What about you?',
      ],
      note: 'first sentence uses comma + question mark; match that pattern',
    },
  },
  {
    id: 'ctx-6',
    category: 'context-referring',
    input: 'match the british english spelling used at the start in the rest _ The colour of the sky is blue. The harbor is calm. The theater is empty.',
    expected: {
      finalText: 'The colour of the sky is blue. The harbour is calm. The theatre is empty.',
    },
  },
  {
    id: 'ctx-7',
    category: 'context-referring',
    input: 'use the same sentence length as the first sentence _ Short. The next sentence is way longer than it should be considering the context.',
    expected: {
      finalText: 'Short. Long.',
      finalTextAlternates: [
        'Short. Bad.',
        'Short. Brief.',
        'Short. Wordy.',
        'Short. Concise.',
        'Short. Lengthy.',
        'Short. Verbose.',
      ],
      note: 'first sentence is one word; match that brevity',
    },
  },
  {
    id: 'ctx-8',
    category: 'context-referring',
    input: 'use the same vocabulary level as the introduction _ The cat sat. He utilized the supplementary vestibule for ingress.',
    expected: {
      finalText: 'The cat sat. He used the side door to come in.',
      finalTextAlternates: [
        'The cat sat. He used the back door to enter.',
        'The cat sat. He used the side door to enter.',
      ],
    },
  },
  {
    id: 'ctx-9',
    category: 'context-referring',
    input: 'apply the case style of the first word to all words _ HELLO world how are you today',
    expected: {
      finalText: 'HELLO WORLD HOW ARE YOU TODAY',
    },
  },
  {
    id: 'ctx-10',
    category: 'context-referring',
    input: 'use the same tone as the opening line throughout _ Thrilled to share our wonderful news! we got the job. it was kinda hard but whatever.',
    expected: {
      finalText: 'Thrilled to share our wonderful news! Delighted to announce we got the job. It was challenging but rewarding.',
      finalTextAlternates: [
        'Thrilled to share our wonderful news! Excited to say we got the job. The journey was challenging but ultimately rewarding.',
        'Thrilled to share our wonderful news! Excited to announce we got the job. Though it was difficult, it was incredibly rewarding.',
      ],
      note: 'first sentence is upbeat/excited; match that tone in the rest',
    },
  },

  // ============================================================
  // TRAILING-INSTRUCTION — instruction at the END (right before _),
  // target text BEFORE the instruction. The natural typing flow:
  // "<text the user already wrote> <imperative> _"
  // ============================================================
  {
    id: 'trail-1',
    category: 'trailing-instruction',
    input: 'the boy ran fast change boy to girl _',
    expected: { finalText: 'the girl ran fast' },
  },
  {
    id: 'trail-2',
    category: 'trailing-instruction',
    input: 'i bought apple and samsung phones online uppercase the brands _',
    expected: { finalText: 'i bought APPLE and SAMSUNG phones online' },
  },
  {
    id: 'trail-3',
    category: 'trailing-instruction',
    input: 'I went to the store and I bought milk make past tense and remove pronouns _',
    expected: {
      finalText: 'went to the store and bought milk',
      finalTextAlternates: [
        'went to the store and bought the milk',
      ],
    },
  },
  {
    id: 'trail-4',
    category: 'trailing-instruction',
    input: 'The boy ran across the road with his big dog. He loved them lots. make all text lower case _',
    expected: { finalText: 'the boy ran across the road with his big dog. he loved them lots.' },
  },
  {
    id: 'trail-5',
    category: 'trailing-instruction',
    input: 'The boy ran across the road. full caps all words _',
    expected: { finalText: 'THE BOY RAN ACROSS THE ROAD.' },
  },
  {
    id: 'trail-6',
    category: 'trailing-instruction',
    input: 'i had lunch with james and sarah at the new restaurant capitalize the names _',
    expected: { finalText: 'i had lunch with James and Sarah at the new restaurant' },
  },
  {
    id: 'trail-7',
    category: 'trailing-instruction',
    input: 'the color of the harbor is gray make it british english _',
    expected: { finalText: 'the colour of the harbour is grey' },
  },
  {
    id: 'trail-8',
    category: 'trailing-instruction',
    input: 'I run to the store every day make past tense _',
    expected: { finalText: 'I ran to the store every day' },
  },
  {
    id: 'trail-9',
    category: 'trailing-instruction',
    input: 'he gave the book to John he/she swap _',
    expected: { finalText: 'she gave the book to John' },
  },
  {
    id: 'trail-10',
    category: 'trailing-instruction',
    input: 'the child found one mouse pluralize _',
    expected: { finalText: 'the children found mice' },
  },
];
