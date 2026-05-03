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
  category: 'literal' | 'concept' | 'transform' | 'negative' | 'multi-span' | 'math' | 'linked-concepts';
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
];
