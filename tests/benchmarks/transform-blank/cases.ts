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
  category: 'literal' | 'concept' | 'transform' | 'negative' | 'multi-span' | 'math' | 'linked-concepts' | 'long-text' | 'targeted' | 'multi-paragraph' | 'conditional' | 'context-referring' | 'trailing-instruction' | 'code-transform' | 'tone-shift' | 'format-transform' | 'creative-rewrite' | 'adversarial' | 'multilingual';
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
  {
    id: 'multi-9',
    category: 'multi-span',
    input: 'rename file to document _ open file then save file then close file then create file backup',
    expected: { finalText: 'open document then save document then close document then create document backup' },
  },
  {
    id: 'multi-10',
    category: 'multi-span',
    input: 'change red to blue _ red apples and red cars and red shirts and red roses',
    expected: { finalText: 'blue apples and blue cars and blue shirts and blue roses' },
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
  {
    id: 'long-A6',
    category: 'long-text',
    input: 'replace dog with horse _ I walked my dog through the park where my dog met another dog and the three dogs played until my dog got tired and we walked home together',
    expected: {
      finalText: 'I walked my horse through the park where my horse met another horse and the three horses played until my horse got tired and we walked home together',
    },
  },
  {
    id: 'long-A7',
    category: 'long-text',
    input: 'capitalize proper nouns _ on monday in march james flew from london to new york via heathrow and arrived at jfk where his friend sarah picked him up in her tesla',
    expected: {
      finalText: 'on Monday in March James flew from London to New York via Heathrow and arrived at JFK where his friend Sarah picked him up in her Tesla',
      finalTextAlternates: [
        'on Monday in March James flew from London to New York via Heathrow and arrived at JFK where his friend Sarah picked him up in her tesla',
      ],
    },
  },
  {
    id: 'long-A8',
    category: 'long-text',
    input: 'pluralize _ the chef cooked one dish and the waiter brought it to the customer who tasted it and asked for another bottle of wine before the meal arrived',
    expected: {
      finalText: 'the chefs cooked dishes and the waiters brought them to the customers who tasted them and asked for more bottles of wine before the meals arrived',
      finalTextAlternates: [
        'the chefs cooked dishes and the waiters brought them to the customers who tasted them and asked for another bottle of wine before the meals arrived',
        'the chefs cooked dishes and the waiters brought them to the customers who tasted them and asked for more bottles of wine before the meals arrived',
      ],
    },
  },
  {
    id: 'long-A9',
    category: 'long-text',
    input: 'make it future tense _ I walk to the office and sit at my desk where I check my email and respond to messages from my manager about the report I am writing',
    expected: {
      finalText: 'I will walk to the office and sit at my desk where I will check my email and respond to messages from my manager about the report I will be writing',
      finalTextAlternates: [
        'I will walk to the office and will sit at my desk where I will check my email and will respond to messages from my manager about the report I will be writing',
        'I will walk to the office and sit at my desk where I will check my email and respond to messages from my manager about the report I will write',
      ],
    },
  },
  {
    id: 'long-A10',
    category: 'long-text',
    input: 'change cat to dog _ my cat sat on the windowsill watching another cat in the garden while a third cat slept on the couch and my cat purred contentedly',
    expected: {
      finalText: 'my dog sat on the windowsill watching another dog in the garden while a third dog slept on the couch and my dog purred contentedly',
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
  {
    id: 'long-B6',
    category: 'long-text',
    input: 'change protagonist to wizard _ The knight rode through the forest. He carried his sword at his side.\n\nAt the edge of the woods, he saw the dragon and prepared for battle.',
    expected: {
      finalText: 'The wizard rode through the forest. He carried his staff at his side.\n\nAt the edge of the woods, he saw the dragon and prepared for battle.',
      finalTextAlternates: [
        'The wizard rode through the forest. He carried his wand at his side.\n\nAt the edge of the woods, he saw the dragon and prepared for battle.',
      ],
    },
  },
  {
    id: 'long-B7',
    category: 'long-text',
    input: 'change he to she _ He drove to work. He parked his car. He walked into the office. His coworkers greeted him warmly. He smiled and headed to his desk.',
    expected: {
      finalText: 'She drove to work. She parked her car. She walked into the office. Her coworkers greeted her warmly. She smiled and headed to her desk.',
    },
  },
  {
    id: 'long-B8',
    category: 'long-text',
    input: 'make it british english _ The color of the harbor is gray. We walked along the sidewalk past the theater. The waiter brought us fries with our meal.',
    expected: {
      finalText: 'The colour of the harbour is grey. We walked along the pavement past the theatre. The waiter brought us chips with our meal.',
    },
  },
  {
    id: 'long-B9',
    category: 'long-text',
    input: 'make past tense _ The boy walks into the kitchen. He pours himself a glass of milk. Then he sits at the table and reads his book until his mother calls him for dinner.',
    expected: {
      finalText: 'The boy walked into the kitchen. He poured himself a glass of milk. Then he sat at the table and read his book until his mother called him for dinner.',
    },
  },
  {
    id: 'long-B10',
    category: 'long-text',
    input: 'capitalize names _ john visited paris in march. james met him at the airport. they took the metro to their hotel near sarah\'s apartment.',
    expected: {
      finalText: 'John visited Paris in March. James met him at the airport. they took the metro to their hotel near Sarah\'s apartment.',
      finalTextAlternates: [
        'John visited Paris in march. James met him at the airport. they took the metro to their hotel near Sarah\'s apartment.',
        'John visited Paris in March. James met him at the airport. They took the Metro to their hotel near Sarah\'s apartment.',
      ],
      note: 'open-ended; accept any rewrite that capitalizes the proper-noun names',
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
  {
    id: 'long-C6',
    category: 'long-text',
    input: 'capitalize names and make past tense _ john runs to the store and buys milk then sarah meets him at the corner and they walk home together while it rains heavily',
    expected: {
      finalText: 'John ran to the store and bought milk then Sarah met him at the corner and they walked home together while it rained heavily',
    },
  },
  {
    id: 'long-C7',
    category: 'long-text',
    input: 'make it british english and pluralize _ the color of the harbor changes with the season and one fries on the menu costs more than the cookie at the counter',
    expected: {
      finalText: 'the colours of the harbours change with the seasons and the chips on the menus cost more than the biscuits at the counters',
      finalTextAlternates: [
        'the colour of the harbours changes with the seasons and the chips on the menus cost more than the biscuits at the counters',
      ],
      note: 'composition with multi-span spelling change + pluralization',
    },
  },
  {
    id: 'long-C8',
    category: 'long-text',
    input: 'change boy to girl and make past tense _ the boy runs to the park and finds a ball under the bench then he kicks it across the grass to his friend',
    expected: {
      finalText: 'the girl ran to the park and found a ball under the bench then she kicked it across the grass to her friend',
    },
  },
  {
    id: 'long-C9',
    category: 'long-text',
    input: 'capitalize proper nouns and remove pronouns _ i visited paris with my friend james and we walked along the seine then we took the metro back to our hotel',
    expected: {
      finalText: 'visited Paris with friend James and walked along the Seine then took the Metro back to hotel',
      finalTextAlternates: [
        'visited Paris with the friend James and walked along the Seine then took the Metro back to the hotel',
        'visited Paris with friend James and walked along the Seine then took the metro back to hotel',
      ],
      note: 'composed transforms; accept reasonable variants',
    },
  },
  {
    id: 'long-C10',
    category: 'long-text',
    input: 'make it future tense and capitalize the names _ john eats breakfast at six then james joins him at seven and sarah arrives by eight for the morning meeting',
    expected: {
      finalText: 'John will eat breakfast at six then James will join him at seven and Sarah will arrive by eight for the morning meeting',
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
  {
    id: 'long-D6',
    category: 'long-text',
    input: 'add 5% tax to all items _ Apples: $4. Bananas: $3. Cherries: $5. Subtotal: $12. Total: $12.',
    expected: {
      finalText: 'Apples: $4. Bananas: $3. Cherries: $5. Subtotal: $12. Tax (5%): $0.60. Total: $12.60.',
      finalTextAlternates: [
        'Apples: $4.20. Bananas: $3.15. Cherries: $5.25. Subtotal: $12.60. Total: $12.60.',
        'Apples: $4. Bananas: $3. Cherries: $5. Subtotal: $12. Tax: $0.60. Total: $12.60.',
      ],
    },
  },
  {
    id: 'long-D7',
    category: 'long-text',
    input: 'triple the quantities _ I have 2 apples and 4 oranges and 1 pear in my basket and 5 grapes in the fridge for a total of 12 pieces of fruit',
    expected: {
      finalText: 'I have 6 apples and 12 oranges and 3 pears in my basket and 15 grapes in the fridge for a total of 36 pieces of fruit',
    },
  },
  {
    id: 'long-D8',
    category: 'long-text',
    input: 'fix totals for hourly rate of $20 _ Monday: 8 hours = $100. Tuesday: 6 hours = $80. Wednesday: 5 hours = $60. Total: $240.',
    expected: {
      finalText: 'Monday: 8 hours = $160. Tuesday: 6 hours = $120. Wednesday: 5 hours = $100. Total: $380.',
    },
  },
  {
    id: 'long-D9',
    category: 'long-text',
    input: 'convert all temperatures to celsius _ Boiling: 212 F. Body: 98.6 F. Room: 68 F. Freezing: 32 F.',
    expected: {
      finalText: 'Boiling: 100 C. Body: 37 C. Room: 20 C. Freezing: 0 C.',
      finalTextAlternates: [
        'Boiling: 100°C. Body: 37°C. Room: 20°C. Freezing: 0°C.',
        'Boiling: 100 °C. Body: 37 °C. Room: 20 °C. Freezing: 0 °C.',
        'Boiling: 100 celsius. Body: 37 celsius. Room: 20 celsius. Freezing: 0 celsius.',
      ],
    },
  },
  {
    id: 'long-D10',
    category: 'long-text',
    input: 'recompute the budget for 50% staffing _ Engineering: 10 people at $100k = $1M. Sales: 6 people at $80k = $480k. Marketing: 4 people at $60k = $240k. Total headcount: 20. Total budget: $1.72M.',
    expected: {
      finalText: 'Engineering: 5 people at $100k = $500k. Sales: 3 people at $80k = $240k. Marketing: 2 people at $60k = $120k. Total headcount: 10. Total budget: $860k.',
      finalTextAlternates: [
        'Engineering: 5 people at $100k = $500k. Sales: 3 people at $80k = $240k. Marketing: 2 people at $60k = $120k. Total headcount: 10. Total budget: $0.86M.',
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
    // June 2026 bug: command at the BOTTOM of a letter must FILL a matching
    // placeholder at the TOP, not append a "Recipient Name: Karen" line.
    id: 'targeted-placeholder-fill-1',
    category: 'targeted',
    input: 'Dear [Recipient Name],\n\nI am writing to formally resign, effective [Date].\n\nSincerely,\nWilfred add recipient name Karen _',
    expected: {
      finalText: 'Dear Karen,\n\nI am writing to formally resign, effective [Date].\n\nSincerely,\nWilfred',
      note: 'Fill the [Recipient Name] slot in place; keep [Date] untouched; do NOT append a label line.',
    },
  },
  {
    // Generic placeholder label ([Name], not [Recipient Name]) — keyword
    // overlap ("name") must still target it.
    id: 'targeted-placeholder-fill-2',
    category: 'targeted',
    input: 'Hi [Name],\n\nThanks for your interest. set name Karen _',
    expected: {
      finalText: 'Hi Karen,\n\nThanks for your interest.',
      finalTextAlternates: ['Hi Karen,\n\nThanks for your interest. '],
      note: 'Generic [Name] slot filled via keyword overlap; command stripped.',
    },
  },
  {
    // The genuine APPEND case must NOT regress into a fill attempt:
    // "add a paragraph about X" over a body with no matching placeholder
    // still appends.
    id: 'targeted-placeholder-fill-3-append-regression',
    category: 'targeted',
    input: 'Build a responsive website with HTML and CSS, with a homepage and a contact form. add a paragraph about security _',
    expected: {
      finalText: 'Build a responsive website with HTML and CSS, with a homepage and a contact form.\n\nSecurity is a priority: serve the site over HTTPS, validate and sanitize all form inputs, and guard against SQL injection and XSS.',
      note: 'No placeholder present → ADD/APPEND still applies. Generated wording open-ended; judge grades on body-preservation + a relevant security paragraph appended.',
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
  {
    // Append-over-body: a CREATE/ADD instruction trailing a real body must
    // PRESERVE the body and append the new content — not wipe the buffer.
    // Regression: this routed to FluidBlank WIPE (whole-buffer replace)
    // because EXTRACT ceded instead of treating the body as the TARGET.
    id: 'trail-11',
    category: 'trailing-instruction',
    input: 'Build a responsive website with HTML, CSS, and JavaScript, with a homepage and a contact form. add a paragraph about security _',
    expected: {
      finalText: 'Build a responsive website with HTML, CSS, and JavaScript, with a homepage and a contact form.\n\nSecurity is a priority: the site uses HTTPS, validates and sanitizes all form inputs, guards against SQL injection and XSS, and stores passwords using strong hashing.',
      note: 'add-over-body must keep the original prompt and APPEND the new paragraph; judge passes if the body is preserved and a relevant security paragraph is appended.',
    },
  },
  {
    id: 'trail-12',
    category: 'trailing-instruction',
    input: 'Quarterly report. Revenue grew 12% this period. add a conclusion _',
    expected: {
      // Generated conclusion wording is open-ended — the load-bearing
      // assertion is "body preserved + a relevant concluding paragraph
      // appended", not exact phrasing. Alternates cover the common shapes.
      finalText: 'Quarterly report. Revenue grew 12% this period.\n\nIn conclusion, the quarter delivered solid revenue growth and a strong foundation to build on.',
      finalTextAlternates: [
        'Quarterly report. Revenue grew 12% this period.\n\nThe period showed solid growth; looking ahead, continued expansion is expected.',
        'Quarterly report. Revenue grew 12% this period.\n\nOverall, the quarter was strong and positions the company well for the period ahead.',
      ],
      note: 'generative add trailing a body → preserve body, append generated conclusion (not whole-buffer wipe). Judge grades on body-preservation + relevance, not exact wording.',
    },
  },

  // ============================================================
  // CODE-TRANSFORM — programming-specific edits. Tests whether
  // the pipeline handles syntactic structure (functions, vars,
  // brackets) without mangling it.
  // ============================================================
  {
    id: 'code-1',
    category: 'code-transform',
    input: 'rename variable x to userId _ const x = getUser(); return x.name',
    expected: { finalText: 'const userId = getUser(); return userId.name' },
  },
  {
    id: 'code-2',
    category: 'code-transform',
    input: 'convert var to const _ var name = "alice"; var age = 30;',
    expected: { finalText: 'const name = "alice"; const age = 30;' },
  },
  {
    id: 'code-3',
    category: 'code-transform',
    input: 'rename function hello to greet _ function hello() { return "hi" }',
    expected: { finalText: 'function greet() { return "hi" }' },
  },
  {
    id: 'code-4',
    category: 'code-transform',
    input: 'remove all comments _ // setup\nconst x = 5; // initial value\nreturn x;',
    expected: {
      finalText: 'const x = 5;\nreturn x;',
      finalTextAlternates: [
        'const x = 5; \nreturn x;',
        '\nconst x = 5; \nreturn x;',
        'const x = 5;\n return x;',
      ],
    },
  },
  {
    id: 'code-5',
    category: 'code-transform',
    input: 'convert to arrow function _ function add(a, b) { return a + b }',
    expected: {
      finalText: 'const add = (a, b) => a + b',
      finalTextAlternates: [
        'const add = (a, b) => { return a + b }',
        'const add = (a, b) => a + b;',
      ],
    },
  },
  {
    id: 'code-6',
    category: 'code-transform',
    input: 'extract magic number to const MAX _ if (count > 100) { warn() }',
    expected: {
      finalText: 'const MAX = 100; if (count > MAX) { warn() }',
      finalTextAlternates: [
        'const MAX = 100;\nif (count > MAX) { warn() }',
        'const MAX = 100;\n\nif (count > MAX) { warn() }',
      ],
    },
  },
  {
    id: 'code-7',
    category: 'code-transform',
    input: 'add error handling _ const data = JSON.parse(input); return data.value',
    expected: {
      finalText: 'try { const data = JSON.parse(input); return data.value } catch (e) { return null }',
      finalTextAlternates: [
        'try {\n  const data = JSON.parse(input);\n  return data.value;\n} catch (e) {\n  return null;\n}',
        'let data; try { data = JSON.parse(input); } catch (e) { return null; } return data.value;',
      ],
      note: 'open-ended; accept any reasonable error-handling wrapper',
    },
  },
  {
    id: 'code-8',
    category: 'code-transform',
    input: 'convert tabs to spaces _ if (x) {\n\treturn true\n}',
    expected: {
      finalText: 'if (x) {\n  return true\n}',
      finalTextAlternates: [
        'if (x) {\n    return true\n}',
      ],
    },
  },
  {
    id: 'code-9',
    category: 'code-transform',
    input: 'add JSDoc _ function multiply(a, b) { return a * b }',
    expected: {
      finalText: '/**\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nfunction multiply(a, b) { return a * b }',
      finalTextAlternates: [
        '/** @param {number} a @param {number} b @returns {number} */\nfunction multiply(a, b) { return a * b }',
        '/**\n * Multiply two numbers.\n * @param {number} a\n * @param {number} b\n * @returns {number}\n */\nfunction multiply(a, b) { return a * b }',
      ],
      note: 'open-ended; accept any reasonable JSDoc block',
    },
  },
  {
    id: 'code-10',
    category: 'code-transform',
    input: 'convert callback to async/await _ getData((err, result) => { if (err) throw err; console.log(result) })',
    expected: {
      finalText: 'const result = await getData(); console.log(result)',
      finalTextAlternates: [
        'try { const result = await getData(); console.log(result) } catch (err) { throw err }',
        'const result = await getData();\nconsole.log(result);',
      ],
      note: 'open-ended; accept any reasonable async/await rewrite',
    },
  },

  // ============================================================
  // TONE-SHIFT — change register / emotion / confidence. Tests
  // whether the model can do stylistic rewriting beyond simple
  // formal/casual.
  // ============================================================
  {
    id: 'tone-1',
    category: 'tone-shift',
    input: 'make it more confident _ I think maybe we should perhaps consider this option',
    expected: {
      finalText: 'We should choose this option',
      finalTextAlternates: [
        'We must consider this option',
        'This is the right option',
        'We should take this option',
      ],
      note: 'open-ended; accept any rewrite that removes hedging',
    },
  },
  {
    id: 'tone-2',
    category: 'tone-shift',
    input: 'remove all hedging _ It seems possibly the data might suggest we could try a new approach',
    expected: {
      finalText: 'The data shows we should try a new approach',
      finalTextAlternates: [
        'The data suggests we should try a new approach',
        'The data shows we need a new approach',
        'The data indicates a new approach is needed',
      ],
    },
  },
  {
    id: 'tone-3',
    category: 'tone-shift',
    input: 'make it more polite _ Send me the report now',
    expected: {
      finalText: 'Could you please send me the report?',
      finalTextAlternates: [
        'Please send me the report when you can.',
        'Would you mind sending me the report?',
        'I would appreciate it if you could send me the report.',
      ],
    },
  },
  {
    id: 'tone-4',
    category: 'tone-shift',
    input: 'make it more direct _ I was wondering if perhaps you might consider helping me with this thing',
    expected: {
      finalText: 'Help me with this',
      finalTextAlternates: [
        'Please help me with this',
        'Can you help me with this?',
        'I need help with this',
      ],
    },
  },
  {
    id: 'tone-5',
    category: 'tone-shift',
    input: 'remove all adverbs _ He quickly ran to the conveniently located store and happily bought milk',
    expected: {
      finalText: 'He ran to the located store and bought milk',
      finalTextAlternates: [
        'He ran to the store and bought milk',
        'He ran to the convenient store and bought milk',
      ],
      note: 'adverbs: quickly, conveniently, happily — all should go',
    },
  },
  {
    id: 'tone-6',
    category: 'tone-shift',
    input: 'add hedging language _ The medication will cure your symptoms',
    expected: {
      finalText: 'The medication may help relieve your symptoms',
      finalTextAlternates: [
        'The medication might cure your symptoms',
        'The medication could potentially help with your symptoms',
        'The medication may help your symptoms',
      ],
    },
  },
  {
    id: 'tone-7',
    category: 'tone-shift',
    input: 'make it sarcastic _ Great work on finishing the project on time',
    expected: {
      finalText: 'Wow, what a shock — you actually finished on time',
      finalTextAlternates: [
        'Oh great, you finished on time, what a miracle',
        'Stunning — finished on time for once',
        'Amazing how you managed to finish on time',
      ],
      note: 'open-ended; accept any clearly sarcastic rewrite',
    },
  },
  {
    id: 'tone-8',
    category: 'tone-shift',
    input: 'make it more dramatic _ I went to the store and bought milk',
    expected: {
      finalText: 'I journeyed to the store and acquired milk',
      finalTextAlternates: [
        'I ventured to the store and bought milk',
        'I made the long trek to the store and brought home milk',
        'I trudged to the store and bought milk',
      ],
      note: 'open-ended; accept any rewrite with elevated/dramatic vocabulary',
    },
  },
  {
    id: 'tone-9',
    category: 'tone-shift',
    input: 'add humor _ The meeting is tomorrow at 3pm in conference room B',
    expected: {
      finalText: 'The meeting is tomorrow at 3pm in conference room B (bring snacks)',
      finalTextAlternates: [
        'Brace yourselves: the meeting is tomorrow at 3pm in conference room B',
        'The meeting is tomorrow at 3pm in conference room B — pray for us',
        'Mark your calendars: tomorrow at 3pm in conference room B (yes, again)',
      ],
      note: 'open-ended; accept any rewrite with a humorous addition',
    },
  },
  {
    id: 'tone-10',
    category: 'tone-shift',
    input: 'make it sincere _ The food was, uh, fine I guess, you know',
    expected: {
      finalText: 'The food was good',
      finalTextAlternates: [
        'The food was excellent',
        'The food was delicious',
        'I really enjoyed the food',
      ],
    },
  },

  // ============================================================
  // FORMAT-TRANSFORM — structural rewrites (lists, tables, dates,
  // measurements). Tests whether the model can produce well-formed
  // structured output, not just prose.
  // ============================================================
  {
    id: 'format-1',
    category: 'format-transform',
    input: 'convert to bullet points _ I need eggs, milk, bread, and cheese from the store',
    expected: {
      finalText: '- eggs\n- milk\n- bread\n- cheese',
      finalTextAlternates: [
        '* eggs\n* milk\n* bread\n* cheese',
        'I need from the store:\n- eggs\n- milk\n- bread\n- cheese',
        '- eggs\n- milk\n- bread\n- cheese (from the store)',
      ],
    },
  },
  // (format-2 / 5 / 6 removed — out-of-scope structural markdown rewrites:
  // "convert to numbered list", "convert to markdown table", "add a markdown
  // heading". The current rendering pipeline doesn't support tables and
  // these big-structure rewrites have always been flaky. If we revisit
  // them, restore from git history.)
  {
    id: 'format-3',
    category: 'format-transform',
    input: 'combine into one sentence _ I went to the store. I bought milk. I came home.',
    expected: {
      finalText: 'I went to the store, bought milk, and came home.',
      finalTextAlternates: [
        'I went to the store, bought milk and came home.',
        'I went to the store and bought milk and came home.',
        'I went to the store, bought milk, and then came home.',
      ],
    },
  },
  {
    id: 'format-4',
    category: 'format-transform',
    input: 'split into separate sentences _ I went to the store and bought milk and came home and put it in the fridge',
    expected: {
      finalText: 'I went to the store. I bought milk. I came home. I put it in the fridge.',
      finalTextAlternates: [
        'I went to the store. I bought milk. I came home and put it in the fridge.',
        'I went to the store. I bought milk. Then I came home. I put it in the fridge.',
      ],
    },
  },
  {
    id: 'format-7',
    category: 'format-transform',
    input: 'convert to ISO date _ March 15, 2024',
    expected: { finalText: '2024-03-15' },
  },
  {
    id: 'format-8',
    category: 'format-transform',
    input: 'use 24-hour format _ The meeting is at 3:30 PM and ends at 5 PM',
    expected: {
      finalText: 'The meeting is at 15:30 and ends at 17:00',
      finalTextAlternates: [
        'The meeting is at 15:30 and ends at 17:00.',
      ],
    },
  },
  {
    id: 'format-9',
    category: 'format-transform',
    input: 'convert all measurements to metric _ I am 6 feet 2 inches tall and weigh 180 pounds',
    expected: {
      finalText: 'I am 188 cm tall and weigh 82 kg',
      finalTextAlternates: [
        'I am 188cm tall and weigh 82kg',
        'I am 1.88 m tall and weigh 81.6 kg',
        'I am 1.88 metres tall and weigh 81.6 kilograms',
        'I am 188 centimeters tall and weigh 82 kilograms',
      ],
    },
  },
  {
    id: 'format-10',
    category: 'format-transform',
    input: 'alphabetize _ banana, apple, cherry, date, elderberry',
    expected: { finalText: 'apple, banana, cherry, date, elderberry' },
  },

  // ---- inline markdown styling — anti-collapse cases ----
  // These pin the "make X bold" failure mode where the model
  // returns just the styled span ("**wilfred**") instead of the
  // full target with the span wrapped ("hi my name is **wilfred**").
  // The expected finalText is the STRIPPED form (what the runtime
  // shows in the buffer); the markdown.styled event handles styling
  // separately. See rule 11 in P2_APPLY_SYSTEM.
  {
    id: 'format-bold-1',
    category: 'format-transform',
    input: 'make wilfred bold _ hi my name is wilfred',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'rewrite must preserve the body; only the inline `**` markers around `wilfred` get added then stripped',
    },
  },
  {
    id: 'format-bold-prior-sentence',
    category: 'format-transform',
    input: 'My name is Wilfred and I work on opencues. make wilfred bold _',
    expected: {
      finalText: 'My name is Wilfred and I work on opencues.',
      note: 'styled word lives in a PRIOR sentence across a period — must TRANSFORM (bold Wilfred in place, markers stripped), not bail to NONE leaving FluidBlank to fill the _. Regression: agentic scenario 103.',
    },
  },
  {
    id: 'format-bold-2',
    category: 'format-transform',
    input: 'bold the word name _ hi my name is wilfred',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'bold a non-final word — full sentence still preserved',
    },
  },
  {
    id: 'format-italic-1',
    category: 'format-transform',
    input: 'italicize wilfred _ hi my name is wilfred',
    expected: {
      finalText: 'hi my name is wilfred',
      note: '*italic* markers around the target word; full body retained',
    },
  },
  {
    id: 'format-strike-1',
    category: 'format-transform',
    input: 'strike through the word wilfred _ hi my name is wilfred',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'strikethrough on a single word; body preserved',
    },
  },
  {
    id: 'format-bold-multiword',
    category: 'format-transform',
    input: 'make the project name bold _ The project name is OpenCues and it ships an open standard',
    expected: {
      finalText: 'The project name is OpenCues and it ships an open standard',
      note: 'multi-word span — full sentence still intact',
    },
  },
  {
    id: 'format-bold-long-target',
    category: 'format-transform',
    input: 'make the date bold _ The release is scheduled for May 15 2026 and will include three new features that we have been working on for months',
    expected: {
      finalText: 'The release is scheduled for May 15 2026 and will include three new features that we have been working on for months',
      note: 'long target with short bold span — model must not collapse to just "May 15 2026"',
    },
  },

  // ---- bold across different layouts: trigger position vs target ----
  // The same instruction tested across the common natural-writing
  // layouts: trigger after target (what users typically write in
  // chat), trigger separated by \n, trigger separated by \n\n
  // (paragraph break), trigger before a multi-line target.
  {
    id: 'format-bold-trailing',
    category: 'format-transform',
    input: 'hi my name is wilfred make wilfred bold _',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'trigger trailing on same line — most common conversational layout',
    },
  },
  {
    id: 'format-bold-newline',
    category: 'format-transform',
    input: 'hi my name is wilfred\nmake wilfred bold _',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'trigger on next line via single \\n — separator preserved by runtime splice',
    },
  },
  {
    id: 'format-bold-paragraph',
    category: 'format-transform',
    input: 'hi my name is wilfred\n\nmake wilfred bold _',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'trigger after paragraph break — the original reported failure mode',
    },
  },
  {
    id: 'format-bold-multiline-target',
    category: 'format-transform',
    input: 'make wilfred bold _ hi my name is wilfred\nand I am from london',
    expected: {
      finalText: 'hi my name is wilfred\nand I am from london',
      finalTextAlternates: [
        'hi my name is wilfred and I am from london',
      ],
      note: 'trigger precedes multi-line target — model must preserve both lines + only bold the named word',
    },
  },
  {
    id: 'format-bold-paragraph-multiline',
    category: 'format-transform',
    input: 'hi my name is wilfred\nI live in london\n\nmake wilfred bold _',
    expected: {
      finalText: 'hi my name is wilfred\nI live in london',
      note: 'multi-line target + paragraph break + trigger — full body must survive',
    },
  },
  {
    id: 'format-bold-trigger-mid',
    category: 'format-transform',
    input: 'hi my name is wilfred\nmake wilfred bold _\nand I work on opencues',
    expected: {
      finalText: 'hi my name is wilfred\nand I work on opencues',
      finalTextAlternates: [
        'hi my name is wilfred and I work on opencues',
      ],
      note: 'trigger sandwiched between two target lines — both parts preserved, trigger removed',
    },
  },

  // ---- italic / strikethrough across the same layout matrix ----
  // Same 6 layouts × 3 inline-style instructions (bold already covered
  // above; here we round out italic + strike). Pins the prompt
  // generalises across markers, not just bold.
  {
    id: 'format-italic-newline',
    category: 'format-transform',
    input: 'hi my name is wilfred\nitalicize wilfred _',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'italic + \\n separator',
    },
  },
  {
    id: 'format-italic-paragraph',
    category: 'format-transform',
    input: 'hi my name is wilfred\n\nitalicize wilfred _',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'italic + paragraph break',
    },
  },
  {
    id: 'format-italic-sandwich',
    category: 'format-transform',
    input: 'hi my name is wilfred\nitalicize wilfred _\nand I work on opencues',
    expected: {
      finalText: 'hi my name is wilfred\nand I work on opencues',
      finalTextAlternates: ['hi my name is wilfred and I work on opencues'],
      note: 'italic sandwiched between two target halves',
    },
  },
  {
    id: 'format-strike-newline',
    category: 'format-transform',
    input: 'hi my name is wilfred\nstrike through wilfred _',
    expected: {
      finalText: 'hi my name is wilfred',
      note: 'strikethrough + \\n separator',
    },
  },
  {
    id: 'format-strike-sandwich',
    category: 'format-transform',
    input: 'hi my name is wilfred\nstrike through wilfred _\nand I work on opencues',
    expected: {
      finalText: 'hi my name is wilfred\nand I work on opencues',
      finalTextAlternates: ['hi my name is wilfred and I work on opencues'],
      note: 'strikethrough sandwiched',
    },
  },

  // ---- non-formatting instructions across the same layouts ----
  // Confirm the EXTRACT sandwich rule generalises beyond markdown
  // styling — translation, case change, etc.
  {
    id: 'format-translate-newline',
    category: 'format-transform',
    input: 'the meeting is at 3pm\ntranslate to french _',
    expected: {
      finalText: 'la réunion est à 15h',
      finalTextAlternates: [
        'la réunion est à 15h00',
        "la réunion est à 15 h",
        'La réunion est à 15h.',
        'La réunion est à 15 h.',
        'La réunion est à 15h00.',
      ],
      note: 'translation + \\n separator — body translated, separator preserved',
    },
  },
  {
    id: 'format-uppercase-sandwich',
    category: 'format-transform',
    input: 'the meeting is at 3pm\nuppercase _\nand I will bring snacks',
    expected: {
      finalText: 'THE MEETING IS AT 3PM\nAND I WILL BRING SNACKS',
      finalTextAlternates: [
        'THE MEETING IS AT 3PM AND I WILL BRING SNACKS',
      ],
      note: 'uppercase across both sandwich halves',
    },
  },
  {
    id: 'format-question-paragraph',
    category: 'format-transform',
    input: 'the meeting is at 3pm\n\nmake it a question _',
    expected: {
      finalText: 'is the meeting at 3pm?',
      finalTextAlternates: [
        'Is the meeting at 3pm?',
        'Is the meeting at 3 pm?',
      ],
      note: 'structural transform + paragraph break preserved before stripped trigger',
    },
  },

  // ---- target spanning multiple lines internally ----
  // Both target halves themselves contain newlines. Tests EXTRACT's
  // ability to detect SANDWICH layout when target halves are
  // multi-line.
  {
    id: 'format-multi-line-target-pre',
    category: 'format-transform',
    input: 'line one\nline two\nline three\nmake all caps _',
    expected: {
      finalText: 'LINE ONE\nLINE TWO\nLINE THREE',
      finalTextAlternates: [
        'LINE ONE LINE TWO LINE THREE',
      ],
      note: 'multi-line target, trigger trailing',
    },
  },
  {
    id: 'format-multi-line-sandwich',
    category: 'format-transform',
    input: 'paragraph one\nparagraph two\nmake all caps _\nparagraph three\nparagraph four',
    expected: {
      finalText: 'PARAGRAPH ONE\nPARAGRAPH TWO\nPARAGRAPH THREE\nPARAGRAPH FOUR',
      finalTextAlternates: [
        'PARAGRAPH ONE PARAGRAPH TWO PARAGRAPH THREE PARAGRAPH FOUR',
      ],
      note: 'multi-line halves both sides of trigger',
    },
  },

  // ============================================================
  // CREATIVE-REWRITE — linguistic creativity. Pushes the model
  // beyond mechanical edits into stylistic territory.
  // ============================================================
  {
    id: 'creative-1',
    category: 'creative-rewrite',
    input: 'translate to pirate speak _ Hello, where is the bathroom please?',
    expected: {
      finalText: 'Ahoy matey, where be the head?',
      finalTextAlternates: [
        'Arrr, where be the head, ye scurvy dog?',
        'Ahoy, where be the privy?',
        'Yarr, where be the head?',
      ],
      note: 'open-ended pirate-speak rewrite',
    },
  },
  {
    id: 'creative-2',
    category: 'creative-rewrite',
    input: 'make it sound like shakespeare _ I love you and want to be with you',
    expected: {
      finalText: 'I love thee and yearn to be with thee',
      finalTextAlternates: [
        'My love for thee burns bright; I would have thee by my side',
        'I do love thee, and would be with thee always',
        'Thou art my love; I would never leave thy side',
      ],
      note: 'open-ended; accept any rewrite using thee/thou/thy or Shakespearean cadence',
    },
  },
  {
    id: 'creative-3',
    category: 'creative-rewrite',
    input: 'convert legalese to plain english _ The party of the first part hereby agrees to indemnify the party of the second part against all claims',
    expected: {
      finalText: 'The first party agrees to cover the second party for any claims',
      finalTextAlternates: [
        'The first party will protect the second party from any claims',
        'The first party will pay for any claims against the second party',
        'The first party promises to cover the second party for any claims',
      ],
    },
  },
  {
    id: 'creative-4',
    category: 'creative-rewrite',
    input: 'convert to gen-z slang _ This party is really exciting and fun',
    expected: {
      finalText: 'This party is fire',
      finalTextAlternates: [
        'This party slaps',
        'This party is lit',
        'This party is so vibey, no cap',
        'No cap, this party is lit',
      ],
      note: 'open-ended; accept any clearly Gen-Z slang rewrite',
    },
  },
  {
    id: 'creative-5',
    category: 'creative-rewrite',
    input: 'convert to academic prose _ The dog ran fast and looked happy when he got the ball',
    expected: {
      finalText: 'The canine demonstrated rapid locomotion and exhibited apparent satisfaction upon retrieval of the ball',
      finalTextAlternates: [
        'The dog exhibited rapid locomotion and displayed evident contentment upon ball retrieval',
        'The canine moved at considerable speed and appeared pleased upon obtaining the ball',
      ],
      note: 'open-ended; accept any rewrite with formal academic vocabulary',
    },
  },
  {
    id: 'creative-6',
    category: 'creative-rewrite',
    input: 'make it more poetic _ The sun set over the mountains and the sky turned orange',
    expected: {
      finalText: 'The sun melted into the mountains, painting the sky in shades of fire',
      finalTextAlternates: [
        'Behind the mountains the sun lay down, and the sky bloomed into orange',
        'The dying sun kissed the mountains farewell as the heavens caught fire',
        'The sun sank behind the mountains, setting the sky ablaze in orange',
      ],
      note: 'open-ended; accept any clearly poetic rewrite',
    },
  },
  {
    id: 'creative-7',
    category: 'creative-rewrite',
    input: 'make it sound urgent _ Please review the document when you have time',
    expected: {
      finalText: 'Review the document immediately',
      finalTextAlternates: [
        'Need you to review the document ASAP',
        'Please review the document right away',
        'URGENT: review the document now',
      ],
    },
  },
  {
    id: 'creative-8',
    category: 'creative-rewrite',
    input: 'make it sound like a child wrote it _ Yesterday I attended a fascinating presentation about quantum mechanics',
    expected: {
      finalText: 'yesterday i went to a really cool talk about teeny tiny things',
      finalTextAlternates: [
        'yesterday i saw a super cool talk about how tiny stuff works',
        'i went to a cool thing yesterday about really really small stuff',
      ],
      note: 'open-ended; accept any rewrite in childlike voice (lowercase, simple words)',
    },
  },
  {
    id: 'creative-9',
    category: 'creative-rewrite',
    input: 'rewrite without using the letter e _ The cat sat on the mat and looked happy',
    expected: {
      finalText: 'A cat sat on a mat and was so glad',
      finalTextAlternates: [
        'A cat sits on a rug and looks glad',
        'A puss sat on a rug and was glad',
        'My cat sat on a rug, looking jolly',
      ],
      note: 'open-ended; the rewrite must contain ZERO letter "e"',
    },
  },
  {
    id: 'creative-10',
    category: 'creative-rewrite',
    input: 'make it sound like a pirate is angry _ The meeting starts at 3pm',
    expected: {
      finalText: 'Arrr, ye scurvy dogs better be at the meetin\' by 3 bells or I\'ll have yer hides!',
      finalTextAlternates: [
        'Avast! The meetin\' starts at 3 and don\'t ye dare be late ye landlubbers!',
        'Yarr, the meetin\' kicks off at 3pm sharp — woe betide any scallywag who shows up late!',
      ],
      note: 'open-ended; angry pirate voice',
    },
  },

  // ============================================================
  // ADVERSARIAL — edge cases, ambiguity, self-reference, and
  // pathological inputs designed to break naive heuristics.
  // ============================================================
  {
    id: 'adv-1',
    category: 'adversarial',
    input: 'change the word change to modify _ I want to change my approach but the change must be quick',
    expected: {
      finalText: 'I want to modify my approach but the modify must be quick',
      finalTextAlternates: [
        'I want to modify my approach but the modification must be quick',
      ],
      note: 'self-referential — instruction targets a word that also appears in the instruction',
    },
  },
  {
    id: 'adv-2',
    category: 'adversarial',
    input: 'make past tense _ change my mind',
    expected: {
      finalText: 'changed my mind',
      finalTextAlternates: [
        'I changed my mind',
      ],
      note: 'target looks like an instruction-shaped phrase ("change") but is actually narrative prose',
    },
  },
  {
    id: 'adv-3',
    category: 'adversarial',
    input: 'negate everything _ I am happy and the day is sunny',
    expected: {
      finalText: 'I am not happy and the day is not sunny',
      finalTextAlternates: [
        'I am sad and the day is gloomy',
        'I am not happy and the day is cloudy',
      ],
    },
  },
  {
    id: 'adv-4',
    category: 'adversarial',
    input: 'add commas where needed _ Hello world how are you today my friend',
    expected: {
      finalText: 'Hello, world, how are you today, my friend',
      finalTextAlternates: [
        'Hello world, how are you today, my friend',
        'Hello, world. How are you today, my friend?',
        'Hello, world, how are you today my friend?',
      ],
    },
  },
  {
    id: 'adv-5',
    category: 'adversarial',
    input: 'reverse the order of words _ The quick brown fox jumps over the lazy dog',
    expected: { finalText: 'dog lazy the over jumps fox brown quick The' },
  },
  {
    id: 'adv-6',
    category: 'adversarial',
    input: 'pluralize but not the words in quotes _ the boy said "one apple" and ate the cookie',
    expected: {
      finalText: 'the boys said "one apple" and ate the cookies',
      finalTextAlternates: [
        'the boys said "one apple" and ate cookies',
      ],
      note: 'conditional with quote-scope exclusion',
    },
  },
  {
    id: 'adv-7',
    category: 'adversarial',
    input: 'change boy to girl _ a boy boyle boycott boyfriend boyhood',
    expected: {
      finalText: 'a girl boyle boycott boyfriend boyhood',
      finalTextAlternates: [
        'a girl girlle girlcott girlfriend girlhood',
        'a girl Boyle boycott boyfriend boyhood',
      ],
      note: 'word-boundary discipline — only the standalone word should change, not substrings',
    },
  },
  {
    id: 'adv-8',
    category: 'adversarial',
    input: 'translate to spanish _ The cat sat on the mat',
    expected: {
      finalText: 'El gato se sentó en la alfombra',
      finalTextAlternates: [
        'El gato estaba sentado en la alfombra',
        'El gato se sentó sobre la alfombra',
        'El gato estaba en la alfombra',
      ],
      note: 'cross-language translation — instruction in English, output in Spanish',
    },
  },
  {
    id: 'adv-9',
    category: 'adversarial',
    input: 'rewrite with no vowels _ The cat sat',
    expected: {
      finalText: 'Th ct st',
      finalTextAlternates: [
        'Th ct st.',
      ],
      note: 'pure constraint task — no a/e/i/o/u allowed',
    },
  },
  {
    id: 'adv-10',
    category: 'adversarial',
    input: 'make this rhyme _ The cat sat on the mat',
    expected: {
      finalText: 'The cat sat on the mat and looked at the rat',
      finalTextAlternates: [
        'The cat sat on the mat next to a rat',
        'The cat sat on the mat and chased a rat',
        'The cat sat on the mat with a rat',
      ],
      note: 'open-ended; accept any rewrite that adds a rhyme',
    },
  },

  // ============================================================
  // MULTILINGUAL — the transform class must work in any language:
  // non-English INSTRUCTIONS, non-English BODIES, non-Latin output,
  // plus emoji-add. Pins the "append/translate/emoji in any language"
  // requirement. All verified PASS on cerebras/fused.
  // ============================================================
  {
    id: 'ml-emoji-en',
    category: 'multilingual',
    input: 'add some emojis _ We just launched our new product and the whole team is thrilled',
    expected: {
      finalText: 'We just launched our new product and the whole team is thrilled 🚀🎉😊',
      finalTextAlternates: [
        'We just launched our new product and the whole team is thrilled\n\n🚀🎉😊',
        'We just launched our new product 🚀 and the whole team is thrilled 🎉',
      ],
      note: 'add emojis → body preserved, emojis added (inline or appended); not a wipe.',
    },
  },
  {
    id: 'ml-append-es',
    category: 'multilingual',
    input: 'añade un párrafo sobre seguridad _ Construye un sitio web con HTML y CSS, con una página de inicio y un formulario de contacto.',
    expected: {
      finalText: 'Construye un sitio web con HTML y CSS, con una página de inicio y un formulario de contacto.\n\nLa seguridad es fundamental: usa HTTPS, valida y sanea todas las entradas del formulario, protege contra inyección SQL y XSS, y almacena las credenciales con hashing seguro.',
      note: 'Spanish instruction AND body → body preserved verbatim, Spanish security paragraph appended.',
    },
  },
  {
    id: 'ml-translate-es-en',
    category: 'multilingual',
    input: 'traduce esto al inglés _ El gato se sentó en la alfombra',
    expected: {
      finalText: 'The cat sat on the mat',
      finalTextAlternates: ['The cat sat on the rug', 'The cat sat on the carpet'],
      note: 'Spanish instruction "translate this to English" must classify + translate.',
    },
  },
  {
    id: 'ml-translate-ja',
    category: 'multilingual',
    input: 'translate to japanese _ Good morning, how are you?',
    expected: {
      finalText: 'おはようございます。お元気ですか？',
      finalTextAlternates: ['おはよう。元気ですか？', 'おはようございます、お元気ですか？'],
      note: 'non-Latin script output.',
    },
  },
  {
    id: 'ml-append-fr',
    category: 'multilingual',
    input: 'Le rapport trimestriel montre une forte croissance. ajoute une conclusion _',
    expected: {
      finalText: 'Le rapport trimestriel montre une forte croissance.\n\nEn conclusion, cette croissance confirme la solidité de notre stratégie et ouvre des perspectives prometteuses pour le prochain trimestre.',
      finalTextAlternates: [
        'Le rapport trimestriel montre une forte croissance.\n\nCette croissance soutenue témoigne de la solidité de nos stratégies et ouvre la voie à des opportunités prometteuses pour le prochain trimestre.',
        'Le rapport trimestriel montre une forte croissance.\n\nDans l\'ensemble, ces résultats positifs nous positionnent favorablement pour la période à venir.',
      ],
      note: 'French body + French instruction → body preserved, French conclusion appended. Generated wording is open-ended; judge grades on body-preservation + a relevant French conclusion.',
    },
  },
  {
    id: 'ml-formal-de',
    category: 'multilingual',
    input: 'mach diesen Text formell _ hey was geht, wir sollten bald mal reden',
    expected: {
      finalText: 'Hallo, wie geht es Ihnen? Wir sollten uns bald einmal unterhalten.',
      finalTextAlternates: ['Guten Tag, wie geht es Ihnen? Wir sollten uns bald einmal besprechen.'],
      note: 'German instruction + German body → formalized German (in-place transform).',
    },
  },
];
