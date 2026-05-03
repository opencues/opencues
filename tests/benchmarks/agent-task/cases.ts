/**
 * Agent-task benchmark cases.
 *
 * Each case is a CASE — a starting state + a list of ASSERTIONS the
 * agent should produce when runOnce(text) is called against the
 * configured task prompt.
 *
 * Categories — 10+ cases each:
 *   spelling-task         Inject typos; assert agent fixes them
 *   no-op-recall          No edit needed; LLM returns empty edits
 *   cursor-adjacent       Cursor-adjacent word never gets edited
 *   ownership-respect     Agent skips words claimed by other DynDefs
 *   task-id-invalidation  Modify task → re-evaluate even unchanged text
 *   caps-task             Capitalization-style task prompts
 *   mixed-task            Composed task prompts ("X AND Y")
 */

export interface AgentTaskCase {
  id: string;
  category:
    | 'spelling-task'
    | 'no-op-recall'
    | 'cursor-adjacent'
    | 'ownership-respect'
    | 'task-id-invalidation'
    | 'caps-task'
    | 'mixed-task';
  /** The task prompt the user has armed via `agentically <X> _`. */
  prompt: string;
  /** The doc text the agent sees. */
  text: string;
  /** Cursor position in chars. -1 = end of text (most natural). */
  cursorPos?: number;
  /** Word indices that are owned by other DynDefs (simulating other
   *  source claims). Agent should skip these. */
  ownedIndices?: readonly number[];
  /** Word indices the agent has already-evaluated under the current
   *  taskId (cache hit — should be skipped). Used for cache tests. */
  alreadyEvaluatedIndices?: readonly number[];
  /** Expected edits — the agent SHOULD propose edits at these indices.
   *  Each entry can be either an exact edited word, or a list of
   *  acceptable edited words. */
  expectedEdits?: ReadonlyArray<{
    wordIndex: number;
    originalWord: string;
    acceptableEdits: readonly string[];
  }>;
  /** Word indices the agent must NOT touch (e.g. cursor-adjacent,
   *  owned, already-evaluated). */
  forbiddenIndices?: readonly number[];
  /** Free-form note for the test author. */
  note?: string;
}

export const CASES: AgentTaskCase[] = [
  // ============================================================
  // SPELLING-TASK — 10 cases. Inject typos, assert agent corrects them.
  // ============================================================
  {
    id: 'spell-1',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'I have somm typos here',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
  },
  {
    id: 'spell-2',
    category: 'spelling-task',
    prompt: 'correct spelling only — leave capitalization alone',
    text: 'The meeting is on monday at noon',
    note: 'no typos; case-related edits ruled out by prompt',
    expectedEdits: [],
  },
  {
    id: 'spell-3',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'I rite some text witth typos',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'rite', acceptableEdits: ['write'] },
      { wordIndex: 4, originalWord: 'witth', acceptableEdits: ['with'] },
    ],
  },
  {
    id: 'spell-4',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'definately the most recieved compliment',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'definately', acceptableEdits: ['definitely'] },
      { wordIndex: 3, originalWord: 'recieved', acceptableEdits: ['received'] },
    ],
  },
  {
    id: 'spell-5',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'I beleive the seperate teams will succede',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'beleive', acceptableEdits: ['believe'] },
      { wordIndex: 3, originalWord: 'seperate', acceptableEdits: ['separate'] },
      { wordIndex: 6, originalWord: 'succede', acceptableEdits: ['succeed'] },
    ],
  },
  {
    id: 'spell-6',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'this is fine',
    expectedEdits: [],
  },
  {
    id: 'spell-7',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'we shoud meet tommorow at 3pm',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'shoud', acceptableEdits: ['should'] },
      { wordIndex: 3, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
  },
  {
    id: 'spell-8',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'the resturant has a great atmosphere',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'resturant', acceptableEdits: ['restaurant'] },
    ],
  },
  {
    id: 'spell-9',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'I am looking forward to your reponse',
    expectedEdits: [
      { wordIndex: 5, originalWord: 'reponse', acceptableEdits: ['response'] },
    ],
    note: 'avoid the Im/I\'m ambiguity — write "I am" so the typo is the only edit',
  },
  {
    id: 'spell-10',
    category: 'spelling-task',
    prompt: 'correct spelling',
    text: 'thier proposal was carefuly recieved',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 3, originalWord: 'carefuly', acceptableEdits: ['carefully'] },
      { wordIndex: 4, originalWord: 'recieved', acceptableEdits: ['received'] },
    ],
  },

  // ============================================================
  // CURSOR-ADJACENT — 10 cases. Cursor-adjacent word stays untouched.
  // ============================================================
  {
    id: 'cur-1',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'I have somm typos and tommorow',
    cursorPos: 30,  // end of "tommorow"
    expectedEdits: [
      { wordIndex: 2, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
    forbiddenIndices: [4],
    note: 'cursor at end of last word — never edit it',
  },
  {
    id: 'cur-2',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'I rite some text',
    cursorPos: 6,  // end of "rite"
    expectedEdits: [],
    forbiddenIndices: [1],
    note: 'cursor on the only typo — agent skips, no edits',
  },
  {
    id: 'cur-3',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'somm extra typos to fix',
    cursorPos: 2,  // middle of "somm"
    expectedEdits: [],
    forbiddenIndices: [0],
    note: 'cursor mid-word — agent skips that word',
  },
  {
    id: 'cur-4',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'thier text and tommorow has typoss',
    cursorPos: 34,  // end of "typoss"
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 3, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    forbiddenIndices: [5],
    note: 'cursor on the last typo — agent edits the others, leaves this one',
  },
  {
    id: 'cur-5',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'thier text',
    cursorPos: 0,  // before any word — cursor IS at start of "thier" (treated as adjacent)
    expectedEdits: [],
    forbiddenIndices: [0],
    note: 'cursor at position 0 — same as inside word 0 per current findCursorWordIdx',
  },
  {
    id: 'cur-6',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'thier text needs fixing',
    cursorPos: 5,  // exactly at end of "thier"
    expectedEdits: [],
    forbiddenIndices: [0],
    note: 'cursor right after "thier" — still cursor-adjacent (no space typed)',
  },
  {
    id: 'cur-7',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'thier text needs fixing',
    cursorPos: 6,  // after the space — "thier " is complete
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
    ],
    note: 'cursor just past the space — "thier" is now complete, can be edited',
  },
  {
    id: 'cur-8',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'we shoud have somm coffe today',
    cursorPos: 30,  // end of "today" — last word, but it's correct
    expectedEdits: [
      { wordIndex: 1, originalWord: 'shoud', acceptableEdits: ['should'] },
      { wordIndex: 3, originalWord: 'somm', acceptableEdits: ['some'] },
      { wordIndex: 4, originalWord: 'coffe', acceptableEdits: ['coffee'] },
    ],
    forbiddenIndices: [5],
    note: 'cursor on a CORRECT word — agent still skips it (no eval)',
  },
  {
    id: 'cur-9',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'a',
    cursorPos: 1,
    expectedEdits: [],
    forbiddenIndices: [0],
    note: 'single-character single-word doc with cursor on it',
  },
  {
    id: 'cur-10',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'recieved a tommorow message',
    cursorPos: 7,  // mid of "received" wait no, "recieved" - cursor at index 7 is between 'e' and 'd' of "recieved" (r-e-c-i-e-v-e-d)
    expectedEdits: [
      { wordIndex: 2, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    forbiddenIndices: [0],
    note: 'cursor mid-misspelled-word — agent skips that word, edits others',
  },

  // ============================================================
  // NO-OP-RECALL — 10 cases. Agent doesn't churn when nothing to fix.
  // ============================================================
  {
    id: 'noop-1',
    category: 'no-op-recall',
    prompt: 'correct spelling',
    text: 'this text is perfectly spelled',
    expectedEdits: [],
  },
  {
    id: 'noop-2',
    category: 'no-op-recall',
    prompt: 'remove emojis',
    text: 'just plain text without any emojis',
    expectedEdits: [],
  },
  {
    id: 'noop-3',
    category: 'no-op-recall',
    prompt: 'capitalize the names',
    text: 'I had lunch with no proper nouns mentioned',
    expectedEdits: [],
    note: 'no names present',
  },
  {
    id: 'noop-4',
    category: 'no-op-recall',
    prompt: 'remove curse words',
    text: 'this is a perfectly polite sentence',
    expectedEdits: [],
  },
  {
    id: 'noop-5',
    category: 'no-op-recall',
    prompt: 'fix grammar',
    text: 'The quick brown fox jumps over the lazy dog.',
    expectedEdits: [],
    note: 'classic correct sentence',
  },
  {
    id: 'noop-6',
    category: 'no-op-recall',
    prompt: 'expand contractions',
    text: 'I will go to the store and buy some milk',
    expectedEdits: [],
    note: 'no contractions to expand',
  },
  {
    id: 'noop-7',
    category: 'no-op-recall',
    prompt: 'use british spelling',
    text: 'the colour of the harbour is grey',
    expectedEdits: [],
    note: 'already british',
  },
  {
    id: 'noop-8',
    category: 'no-op-recall',
    prompt: 'remove redundant words',
    text: 'the cat sat on the mat',
    expectedEdits: [],
    note: 'no redundancy',
  },
  {
    id: 'noop-9',
    category: 'no-op-recall',
    prompt: 'correct spelling',
    text: 'one',
    expectedEdits: [],
    note: 'single correctly-spelled word',
  },
  {
    id: 'noop-10',
    category: 'no-op-recall',
    prompt: 'fix capitalization',
    text: 'I went to Paris in March with James',
    expectedEdits: [],
    note: 'all proper nouns already capitalized',
  },

  // ============================================================
  // OWNERSHIP-RESPECT — 10 cases. Agent skips words owned elsewhere.
  // ============================================================
  {
    id: 'own-1',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'I have somm typos and tommorow',
    ownedIndices: [4],
    expectedEdits: [
      { wordIndex: 2, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
    forbiddenIndices: [4],
  },
  {
    id: 'own-2',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'definately a recieved compliment',
    ownedIndices: [0],
    expectedEdits: [
      { wordIndex: 2, originalWord: 'recieved', acceptableEdits: ['received'] },
    ],
    forbiddenIndices: [0],
  },
  {
    id: 'own-3',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'thier proposal was carefuly recieved',
    ownedIndices: [0, 3, 4],  // own all the typos!
    expectedEdits: [],
    forbiddenIndices: [0, 3, 4],
    note: 'all typos owned — agent should make zero edits',
  },
  {
    id: 'own-4',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'somm shoud be tommorow',
    ownedIndices: [0],
    expectedEdits: [
      { wordIndex: 1, originalWord: 'shoud', acceptableEdits: ['should'] },
      { wordIndex: 3, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    forbiddenIndices: [0],
    note: 'own first typo, agent fixes the others',
  },
  {
    id: 'own-5',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'somm shoud be tommorow',
    ownedIndices: [3],
    expectedEdits: [
      { wordIndex: 0, originalWord: 'somm', acceptableEdits: ['some'] },
      { wordIndex: 1, originalWord: 'shoud', acceptableEdits: ['should'] },
    ],
    forbiddenIndices: [3],
    note: 'own last typo — agent fixes the earlier ones',
  },
  {
    id: 'own-6',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'one shoud have somm coffe today',
    ownedIndices: [1, 4],
    expectedEdits: [
      { wordIndex: 3, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
    forbiddenIndices: [1, 4],
    note: 'own two non-adjacent typos — agent fixes the middle one',
  },
  {
    id: 'own-7',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'thier perfectly fine text',
    ownedIndices: [0],
    expectedEdits: [],
    forbiddenIndices: [0],
    note: 'own the only typo — agent has nothing to do',
  },
  {
    id: 'own-8',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'thier perfect text and one tommorow',
    ownedIndices: [0, 1, 2, 3],  // own first 4 — agent only sees last 3
    expectedEdits: [
      { wordIndex: 5, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    forbiddenIndices: [0, 1, 2, 3],
    note: 'large contiguous owned region — agent only edits within unowned tail',
  },
  {
    id: 'own-9',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'a recieved b',
    ownedIndices: [0, 2],
    expectedEdits: [
      { wordIndex: 1, originalWord: 'recieved', acceptableEdits: ['received'] },
    ],
    forbiddenIndices: [0, 2],
    note: 'sandwiched — owned around the typo',
  },
  {
    id: 'own-10',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'somm definately recieved tommorow',
    ownedIndices: [],
    expectedEdits: [
      { wordIndex: 0, originalWord: 'somm', acceptableEdits: ['some'] },
      { wordIndex: 1, originalWord: 'definately', acceptableEdits: ['definitely'] },
      { wordIndex: 2, originalWord: 'recieved', acceptableEdits: ['received'] },
      { wordIndex: 3, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    note: 'no ownership — agent should fix everything',
  },

  // ============================================================
  // TASK-ID-INVALIDATION — 10 cases. Cache hits + new evaluations.
  // ============================================================
  {
    id: 'cache-1',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'I have somm typos here',
    alreadyEvaluatedIndices: [2],
    expectedEdits: [],
    forbiddenIndices: [2],
    note: 'cache hit on "somm" — agent must NOT re-evaluate',
  },
  {
    id: 'cache-2',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'I have somm typos and tommorow here',
    alreadyEvaluatedIndices: [2],
    expectedEdits: [
      { wordIndex: 5, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    forbiddenIndices: [2],
  },
  {
    id: 'cache-3',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'thier carefuly recieved tommorow text',
    alreadyEvaluatedIndices: [0, 1, 2, 3, 4],  // all words cached
    expectedEdits: [],
    forbiddenIndices: [0, 1, 2, 3, 4],
    note: 'every word cached — agent sees no candidates',
  },
  {
    id: 'cache-4',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'thier text',
    alreadyEvaluatedIndices: [],
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
    ],
    note: 'empty cache — agent edits as normal',
  },
  {
    id: 'cache-5',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'somm text and tommorow',
    alreadyEvaluatedIndices: [3],
    expectedEdits: [
      { wordIndex: 0, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
    forbiddenIndices: [3],
    note: 'cache hit on tommorow — only somm fixed',
  },
  {
    id: 'cache-6',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'somm shoud have tommorow',
    alreadyEvaluatedIndices: [0, 3],
    expectedEdits: [
      { wordIndex: 1, originalWord: 'shoud', acceptableEdits: ['should'] },
    ],
    forbiddenIndices: [0, 3],
    note: 'cache hits on first + last typos; middle typo gets fixed',
  },
  {
    id: 'cache-7',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'all words are perfectly spelled',
    alreadyEvaluatedIndices: [0, 1, 2, 3, 4],
    expectedEdits: [],
    forbiddenIndices: [0, 1, 2, 3, 4],
    note: 'cache hits + nothing to fix — double-no-op',
  },
  {
    id: 'cache-8',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'thier somm coffe',
    alreadyEvaluatedIndices: [1],
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 2, originalWord: 'coffe', acceptableEdits: ['coffee'] },
    ],
    forbiddenIndices: [1],
    note: 'cache on middle word — agent fixes the bookends',
  },
  {
    id: 'cache-9',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'I had lunch with sarah',
    alreadyEvaluatedIndices: [0, 1, 2, 3, 4],
    expectedEdits: [],
    forbiddenIndices: [0, 1, 2, 3, 4],
    note: 'all words cached, none need editing anyway',
  },
  {
    id: 'cache-10',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'thier somm here',
    cursorPos: -1,  // end of doc — cursor on "here"
    alreadyEvaluatedIndices: [1],
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
    ],
    forbiddenIndices: [1, 2],
    note: 'cache hit + cursor-adjacent both protect; only thier gets fixed',
  },

  // ============================================================
  // CAPS-TASK — 10 cases. Various capitalization rules.
  // ============================================================
  {
    id: 'caps-1',
    category: 'caps-task',
    prompt: 'capitalize cities and people names',
    text: 'i went to paris with james last june',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'paris', acceptableEdits: ['Paris'] },
      { wordIndex: 5, originalWord: 'james', acceptableEdits: ['James'] },
    ],
    note: '"i" and "june" deliberately excluded by narrowed prompt',
  },
  {
    id: 'caps-2',
    category: 'caps-task',
    prompt: 'capitalize the names',
    text: 'i had lunch with sarah and james at the cafe',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'sarah', acceptableEdits: ['Sarah'] },
      { wordIndex: 6, originalWord: 'james', acceptableEdits: ['James'] },
    ],
  },
  {
    id: 'caps-3',
    category: 'caps-task',
    prompt: 'capitalize the months',
    text: 'i was born in march and graduated in june',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'march', acceptableEdits: ['March'] },
      { wordIndex: 8, originalWord: 'june', acceptableEdits: ['June'] },
    ],
  },
  {
    id: 'caps-4',
    category: 'caps-task',
    prompt: 'capitalize the days',
    text: 'i work on monday and friday but rest on sunday',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'monday', acceptableEdits: ['Monday'] },
      { wordIndex: 5, originalWord: 'friday', acceptableEdits: ['Friday'] },
      { wordIndex: 9, originalWord: 'sunday', acceptableEdits: ['Sunday'] },
    ],
  },
  {
    id: 'caps-5',
    category: 'caps-task',
    prompt: 'capitalize the cities',
    text: 'i flew from london to tokyo via paris',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'london', acceptableEdits: ['London'] },
      { wordIndex: 5, originalWord: 'tokyo', acceptableEdits: ['Tokyo'] },
      { wordIndex: 7, originalWord: 'paris', acceptableEdits: ['Paris'] },
    ],
  },
  {
    id: 'caps-6',
    category: 'caps-task',
    prompt: 'capitalize the brand names',
    text: 'i bought apple and samsung at best buy',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'apple', acceptableEdits: ['Apple'] },
      { wordIndex: 4, originalWord: 'samsung', acceptableEdits: ['Samsung'] },
    ],
    note: 'best buy is also a brand but ambiguous; allow either',
  },
  {
    id: 'caps-7',
    category: 'caps-task',
    prompt: 'capitalize country names',
    text: 'i visited france italy and germany',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'france', acceptableEdits: ['France'] },
      { wordIndex: 3, originalWord: 'italy', acceptableEdits: ['Italy'] },
      { wordIndex: 5, originalWord: 'germany', acceptableEdits: ['Germany'] },
    ],
  },
  {
    id: 'caps-8',
    category: 'caps-task',
    prompt: 'lowercase everything',
    text: 'I VISITED PARIS LAST JUNE',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'I', acceptableEdits: ['i'] },
      { wordIndex: 1, originalWord: 'VISITED', acceptableEdits: ['visited'] },
      { wordIndex: 2, originalWord: 'PARIS', acceptableEdits: ['paris'] },
      { wordIndex: 3, originalWord: 'LAST', acceptableEdits: ['last'] },
      { wordIndex: 4, originalWord: 'JUNE', acceptableEdits: ['june'] },
    ],
  },
  {
    id: 'caps-9',
    category: 'caps-task',
    prompt: 'capitalize first word of every sentence',
    text: 'hello there. how are you. i am fine.',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'hello', acceptableEdits: ['Hello'] },
      { wordIndex: 2, originalWord: 'how', acceptableEdits: ['How'] },
      { wordIndex: 5, originalWord: 'i', acceptableEdits: ['I'] },
    ],
    note: 'words "there.", "you.", "fine." are end-punct — agent should not change them',
  },
  {
    id: 'caps-10',
    category: 'caps-task',
    prompt: 'uppercase product names',
    text: 'i love my iphone and macbook',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'iphone', acceptableEdits: ['IPHONE', 'iPhone'] },
      { wordIndex: 5, originalWord: 'macbook', acceptableEdits: ['MACBOOK', 'MacBook'] },
    ],
    note: 'accept either UPPERCASE or PascalCase',
  },

  // ============================================================
  // MIXED-TASK — 10 cases. Composed task prompts ("X AND Y").
  // ============================================================
  {
    id: 'mix-1',
    category: 'mixed-task',
    prompt: 'correct spelling AND capitalize names',
    text: 'thier text and james bought somm food',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 3, originalWord: 'james', acceptableEdits: ['James'] },
      { wordIndex: 5, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
  },
  {
    id: 'mix-2',
    category: 'mixed-task',
    prompt: 'correct spelling AND capitalize the cities',
    text: 'we flew to paris and recieved a tour',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'paris', acceptableEdits: ['Paris'] },
      { wordIndex: 5, originalWord: 'recieved', acceptableEdits: ['received'] },
    ],
  },
  {
    id: 'mix-3',
    category: 'mixed-task',
    prompt: 'correct spelling AND capitalize the months',
    text: 'thier wedding is in june with somm guests',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 4, originalWord: 'june', acceptableEdits: ['June'] },
      { wordIndex: 6, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
  },
  {
    id: 'mix-4',
    category: 'mixed-task',
    prompt: 'correct spelling AND fix grammar',
    text: 'i has tommorow plans',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'has', acceptableEdits: ['have'] },
      { wordIndex: 2, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    note: '"i" might also get capped under fix grammar; allow extras',
  },
  {
    id: 'mix-5',
    category: 'mixed-task',
    prompt: 'correct spelling AND uppercase brand names',
    text: 'i bought apple and recieved samsung',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'apple', acceptableEdits: ['APPLE'] },
      { wordIndex: 3, originalWord: 'and', acceptableEdits: ['and'] },  // shouldn't change
      { wordIndex: 4, originalWord: 'recieved', acceptableEdits: ['received'] },
      { wordIndex: 5, originalWord: 'samsung', acceptableEdits: ['SAMSUNG'] },
    ],
    note: '"and" deliberately listed but acceptableEdits=["and"] catches it as no-op',
  },
  {
    id: 'mix-6',
    category: 'mixed-task',
    prompt: 'correct spelling AND remove redundant words',
    text: 'thier text has tommorow tommorow plans',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 3, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
      { wordIndex: 4, originalWord: 'tommorow', acceptableEdits: ['tomorrow', ''] },
    ],
    note: 'second "tommorow" might be removed entirely OR fixed; allow both',
  },
  {
    id: 'mix-7',
    category: 'mixed-task',
    prompt: 'correct spelling AND lowercase common nouns',
    text: 'thier Cat sat on a Mat',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 1, originalWord: 'Cat', acceptableEdits: ['cat'] },
      { wordIndex: 5, originalWord: 'Mat', acceptableEdits: ['mat'] },
    ],
  },
  {
    id: 'mix-8',
    category: 'mixed-task',
    prompt: 'correct spelling AND capitalize names AND capitalize cities',
    text: 'james flew to paris but somm flights were cancelled',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'james', acceptableEdits: ['James'] },
      { wordIndex: 3, originalWord: 'paris', acceptableEdits: ['Paris'] },
      { wordIndex: 5, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
    note: '3-task composition',
  },
  {
    id: 'mix-9',
    category: 'mixed-task',
    prompt: 'correct spelling AND fix capitalization of proper nouns',
    text: 'thier flight to london was carefuly planned by sarah',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 3, originalWord: 'london', acceptableEdits: ['London'] },
      { wordIndex: 5, originalWord: 'carefuly', acceptableEdits: ['carefully'] },
      { wordIndex: 8, originalWord: 'sarah', acceptableEdits: ['Sarah'] },
    ],
  },
  {
    id: 'mix-10',
    category: 'mixed-task',
    prompt: 'correct spelling AND remove emojis',
    text: 'thier text has no emoji here',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
    ],
    note: 'no emojis present — agent only fixes spelling',
  },
];
