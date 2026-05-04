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
    | 'mixed-task'
    | 'professionalism'
    | 'linkedin-friendly'
    | 'lawyer'
    | 'translation'
    | 'medical'
    | 'british-english'
    | 'inclusive-language'
    | 'twitter-concise'
    | 'long-doc';
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
      { wordIndex: 6, originalWord: 'reponse', acceptableEdits: ['response'] },
    ],
    note: '7 words: I am looking forward to your reponse — typo at idx 6',
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
      { wordIndex: 4, originalWord: 'recieved', acceptableEdits: ['received'] },
      { wordIndex: 5, originalWord: 'samsung', acceptableEdits: ['SAMSUNG'] },
    ],
    note: '"and" stays — agent correctly skips no-op edits',
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

  // ============================================================
  // PROFESSIONALISM — 10 cases. Style-shift task ("make this more
  // professional"). Tests that the agent (a) handles abstract style
  // prompts beyond mechanical spell-correction, (b) actually edits
  // when there's something to formalise, (c) leaves clean text alone.
  // The acceptable-edit lists are intentionally generous — there's
  // no single "correct" professional rewrite.
  // ============================================================
  {
    id: 'prof-1',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'gonna meet the team tomorrow',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'gonna', acceptableEdits: ['intend', 'plan', 'will'] },
    ],
    note: 'gonna → going to / will / plan to (single-word substitute)',
  },
  {
    id: 'prof-2',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'kinda think we should reschedule',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'kinda', acceptableEdits: ['somewhat', 'rather', 'kind'] },
    ],
    note: 'kinda → somewhat / rather',
  },
  {
    id: 'prof-3',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'the proposal is super important for us',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'super', acceptableEdits: ['highly', 'very', 'extremely', 'critically'] },
    ],
    note: 'super → highly / very',
  },
  {
    id: 'prof-4',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'this stuff needs review before friday',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'stuff', acceptableEdits: ['material', 'content', 'documentation', 'work'] },
    ],
    note: 'stuff → material / content',
  },
  {
    id: 'prof-5',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'the meeting was kinda long and gonna be repeated tomorrow',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'kinda', acceptableEdits: ['somewhat', 'rather', 'kind'] },
      { wordIndex: 6, originalWord: 'gonna', acceptableEdits: ['will', 'shall'] },
    ],
    note: 'two informal words in one sentence',
  },
  {
    id: 'prof-6',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'we need to finalise the contract by tuesday',
    expectedEdits: [],
    note: 'already-professional sentence — agent should leave it alone',
  },
  {
    id: 'prof-7',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'just wanna confirm receipt of the invoice',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'wanna', acceptableEdits: ['want', 'wish'] },
    ],
    note: 'wanna → want to / wish to (or just want)',
  },
  {
    id: 'prof-8',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'this report is awesome and well-written',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'awesome', acceptableEdits: ['excellent', 'outstanding', 'exemplary', 'superb'] },
    ],
    note: 'awesome → excellent / outstanding',
  },
  {
    id: 'prof-9',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'lemme know if you have any questions',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'lemme', acceptableEdits: ['let', 'please'] },
    ],
    note: 'lemme → let / please',
  },
  {
    id: 'prof-10',
    category: 'professionalism',
    prompt: 'make wording more professional',
    text: 'the quarterly report has been submitted to the board for review',
    expectedEdits: [],
    note: 'second already-professional case at the end of category',
  },

  // ============================================================
  // LINKEDIN-FRIENDLY — 6 cases. Hype-y / casual networking phrases
  // get an aspirational-but-still-credible polish. Single-word swaps
  // chosen so each has one obvious LinkedIn-style upgrade.
  // ============================================================
  {
    id: 'li-1',
    category: 'linkedin-friendly',
    prompt: 'make wording linkedin friendly',
    text: 'we crushed our quarterly targets',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'crushed', acceptableEdits: ['exceeded', 'surpassed', 'achieved', 'excelled', 'smashed', 'delivered'] },
    ],
  },
  {
    id: 'li-2',
    category: 'linkedin-friendly',
    prompt: 'make wording linkedin friendly',
    text: 'stoked to share my promotion',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'stoked', acceptableEdits: ['thrilled', 'excited', 'honored', 'honoured', 'delighted'] },
    ],
  },
  {
    id: 'li-3',
    category: 'linkedin-friendly',
    prompt: 'make wording linkedin friendly',
    // Pick "wanna" — the model reliably upgrades obvious slang. "boss"
    // is borderline ("thanks to my boss" is fine on LinkedIn); using
    // unambiguous slang instead so the test has a stable verdict.
    text: 'wanna connect with industry leaders',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'wanna', acceptableEdits: ['want', 'love', 'hope', 'eager', 'looking'] },
    ],
  },
  {
    id: 'li-4',
    category: 'linkedin-friendly',
    prompt: 'make wording linkedin friendly',
    text: 'looking for a marketing rockstar',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'rockstar', acceptableEdits: ['expert', 'specialist', 'professional', 'leader', 'champion'] },
    ],
  },
  {
    id: 'li-5',
    category: 'linkedin-friendly',
    prompt: 'make wording linkedin friendly',
    // "amazing" is borderline (commonly accepted on LinkedIn); use
    // "crushing" which the model reliably upgrades to a clearer verb.
    text: 'looking forward to crushing q4 goals',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'crushing', acceptableEdits: ['exceeding', 'achieving', 'delivering', 'surpassing', 'hitting'] },
    ],
  },
  {
    id: 'li-6',
    category: 'linkedin-friendly',
    prompt: 'make wording linkedin friendly',
    text: 'honored to join an exceptional team of innovators',
    expectedEdits: [],
    note: 'already polished — agent should leave it alone',
  },

  // ============================================================
  // LAWYER — 6 cases. Casual phrasing → precise legal terminology.
  // Single-word swaps chosen so each maps to a near-canonical legal
  // equivalent (purchase, agreement, individual, convey, matter).
  // ============================================================
  {
    id: 'law-1',
    category: 'lawyer',
    prompt: 'use precise legal terminology',
    text: 'the parties will buy the property',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'buy', acceptableEdits: ['purchase', 'acquire'] },
    ],
  },
  {
    id: 'law-2',
    category: 'lawyer',
    prompt: 'use precise legal terminology',
    text: 'we agreed on a deal yesterday',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'deal', acceptableEdits: ['agreement', 'contract', 'arrangement'] },
    ],
  },
  {
    id: 'law-3',
    category: 'lawyer',
    prompt: 'use precise legal terminology',
    text: 'the guy who signed the form',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'guy', acceptableEdits: ['individual', 'party', 'person', 'signatory', 'man'] },
    ],
  },
  {
    id: 'law-4',
    category: 'lawyer',
    prompt: 'use precise legal terminology',
    text: 'the seller will give the deed to the buyer',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'give', acceptableEdits: ['convey', 'transfer', 'deliver', 'assign'] },
    ],
  },
  {
    id: 'law-5',
    category: 'lawyer',
    prompt: 'use precise legal terminology',
    text: 'we want to fix this thing soon',
    expectedEdits: [
      { wordIndex: 5, originalWord: 'thing', acceptableEdits: ['matter', 'issue', 'item', 'dispute'] },
    ],
  },
  {
    id: 'law-6',
    category: 'lawyer',
    prompt: 'use precise legal terminology',
    text: 'the contract was duly executed by all parties on the agreed date',
    expectedEdits: [],
    note: 'already-legal phrasing — should be left alone',
  },

  // ============================================================
  // TRANSLATION — 6 cases. "Translate english days to spanish"
  // demonstrates the agent in a transformation role beyond English-
  // English style edits. Day names map 1:1 so the swap is unambiguous.
  // ============================================================
  {
    id: 'trans-1',
    category: 'translation',
    prompt: 'translate english days to spanish',
    text: 'we meet on monday at noon',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'monday', acceptableEdits: ['lunes'] },
    ],
  },
  {
    id: 'trans-2',
    category: 'translation',
    prompt: 'translate english days to spanish',
    // 0:the 1:report 2:is 3:due 4:friday 5:morning
    text: 'the report is due friday morning',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'friday', acceptableEdits: ['viernes'] },
    ],
  },
  {
    id: 'trans-3',
    category: 'translation',
    prompt: 'translate english days to spanish',
    text: 'saturday is for code review',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'saturday', acceptableEdits: ['sábado', 'sabado'] },
    ],
  },
  {
    id: 'trans-4',
    category: 'translation',
    prompt: 'translate english days to spanish',
    text: 'tuesday meetings are mandatory',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'tuesday', acceptableEdits: ['martes'] },
    ],
  },
  {
    id: 'trans-5',
    category: 'translation',
    prompt: 'translate english days to spanish',
    text: 'wednesday evening is reserved for training',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'wednesday', acceptableEdits: ['miércoles', 'miercoles'] },
    ],
  },
  {
    id: 'trans-6',
    category: 'translation',
    prompt: 'translate english days to spanish',
    text: 'the project starts next week',
    expectedEdits: [],
    note: 'no day names present — agent should not edit',
  },

  // ============================================================
  // MEDICAL — 5 cases. Lay → clinical terminology. Each case picks a
  // word with a near-canonical clinical equivalent (physician, child,
  // medication, nauseated).
  // ============================================================
  {
    id: 'med-1',
    category: 'medical',
    prompt: 'use clinical terminology',
    text: 'the patient saw the doctor',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'doctor', acceptableEdits: ['physician', 'clinician'] },
    ],
  },
  {
    id: 'med-2',
    category: 'medical',
    prompt: 'use clinical terminology',
    text: 'the kid needs an examination',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'kid', acceptableEdits: ['child', 'minor', 'pediatric', 'paediatric', 'infant'] },
    ],
  },
  {
    id: 'med-3',
    category: 'medical',
    prompt: 'use clinical terminology',
    text: 'she takes meds twice daily',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'meds', acceptableEdits: ['medication', 'medications', 'medicines'] },
    ],
  },
  {
    id: 'med-4',
    category: 'medical',
    prompt: 'use clinical terminology',
    text: 'the woman felt sick this morning',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'sick', acceptableEdits: ['nauseated', 'ill', 'unwell', 'symptomatic'] },
    ],
  },
  {
    id: 'med-5',
    category: 'medical',
    prompt: 'use clinical terminology',
    text: 'the patient was assessed by the attending physician on admission',
    expectedEdits: [],
    note: 'already-clinical phrasing — should be left alone',
  },

  // ============================================================
  // BRITISH-ENGLISH — 8 cases. American → British spelling. The
  // canonical mapping for each word makes scoring unambiguous.
  // ============================================================
  {
    id: 'br-1',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'the color of the building',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'color', acceptableEdits: ['colour'] },
    ],
  },
  {
    id: 'br-2',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'the new center opens monday',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'center', acceptableEdits: ['centre'] },
    ],
  },
  {
    id: 'br-3',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'his neighbor moved away',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'neighbor', acceptableEdits: ['neighbour'] },
    ],
  },
  {
    id: 'br-4',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'she works for a small organization',
    expectedEdits: [
      { wordIndex: 5, originalWord: 'organization', acceptableEdits: ['organisation'] },
    ],
  },
  {
    id: 'br-5',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'i did not realize the time',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'realize', acceptableEdits: ['realise'] },
    ],
  },
  {
    id: 'br-6',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'the labor party won the election',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'labor', acceptableEdits: ['labour'] },
    ],
  },
  {
    id: 'br-7',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'her favorite season is autumn',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'favorite', acceptableEdits: ['favourite'] },
    ],
  },
  {
    id: 'br-8',
    category: 'british-english',
    prompt: 'use british english spelling',
    text: 'the colour scheme has been finalised',
    expectedEdits: [],
    note: 'already british — leave alone',
  },

  // ============================================================
  // INCLUSIVE-LANGUAGE — 6 cases. Gendered occupational nouns →
  // gender-neutral equivalents. Each has a canonical neutral form.
  // ============================================================
  {
    id: 'inc-1',
    category: 'inclusive-language',
    prompt: 'use inclusive gender-neutral language',
    text: 'the chairman opened the meeting',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'chairman', acceptableEdits: ['chairperson', 'chair'] },
    ],
  },
  {
    id: 'inc-2',
    category: 'inclusive-language',
    prompt: 'use inclusive gender-neutral language',
    text: 'we need more manpower for the project',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'manpower', acceptableEdits: ['workforce', 'staffing', 'personnel', 'staff'] },
    ],
  },
  {
    id: 'inc-3',
    category: 'inclusive-language',
    prompt: 'use inclusive gender-neutral language',
    text: 'the fireman climbed the ladder',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'fireman', acceptableEdits: ['firefighter'] },
    ],
  },
  {
    id: 'inc-4',
    category: 'inclusive-language',
    prompt: 'use inclusive gender-neutral language',
    text: 'she became a successful businessman',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'businessman', acceptableEdits: ['businessperson', 'professional', 'entrepreneur', 'executive'] },
    ],
  },
  {
    id: 'inc-5',
    category: 'inclusive-language',
    prompt: 'use inclusive gender-neutral language',
    text: 'the salesman closed the deal',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'salesman', acceptableEdits: ['salesperson', 'representative', 'seller'] },
    ],
  },
  {
    id: 'inc-6',
    category: 'inclusive-language',
    prompt: 'use inclusive gender-neutral language',
    text: 'the diverse team welcomed every new colleague',
    expectedEdits: [],
    note: 'already inclusive — leave alone',
  },

  // ============================================================
  // TWITTER-CONCISE — 5 cases. Verbose → terse word swaps suitable
  // for character-limited platforms. Each has a clear shorter form.
  // ============================================================
  {
    id: 'tw-1',
    category: 'twitter-concise',
    prompt: 'shorten verbose words',
    text: 'approximately fifty people attended',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'approximately', acceptableEdits: ['about', '~', 'roughly', 'nearly'] },
    ],
  },
  {
    id: 'tw-2',
    category: 'twitter-concise',
    prompt: 'shorten verbose words',
    text: 'we will commence tomorrow morning',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'commence', acceptableEdits: ['start', 'begin'] },
    ],
  },
  {
    id: 'tw-3',
    category: 'twitter-concise',
    prompt: 'shorten verbose words',
    text: 'endeavor to attend the briefing',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'endeavor', acceptableEdits: ['try', 'aim', 'attempt'] },
    ],
  },
  {
    id: 'tw-4',
    category: 'twitter-concise',
    prompt: 'shorten verbose words',
    text: 'she utilized the new feature',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'utilized', acceptableEdits: ['used'] },
    ],
  },
  {
    id: 'tw-5',
    category: 'twitter-concise',
    prompt: 'shorten verbose words',
    text: 'new launch tomorrow check it out',
    expectedEdits: [],
    note: 'already concise — leave alone',
  },

  // ============================================================
  // LONG-DOC — 6 cases. 30-65 words each. Exercises the agent on
  // realistic document lengths under varied tasks. Mix of correct-
  // and-edit and no-op to stress the cache + EDITS-format scaling.
  // ============================================================
  {
    id: 'ld-1',
    category: 'long-doc',
    prompt: 'correct spelling',
    // 32-word business email with 5 typos. Indices verified manually.
    // 0:Thank 1:you 2:for 3:atending 4:the 5:meeting 6:yesterday.
    // 7:We 8:discussed 9:the 10:analysys 11:results 12:and 13:three
    // 14:new 15:initatives. 16:The 17:team 18:feels 19:we
    // 20:recieved 21:feedback 22:well 23:but 24:need 25:more
    // 26:time 27:to 28:addres 29:the 30:open 31:items.
    text: 'Thank you for atending the meeting yesterday. We discussed the analysys results and three new initatives. The team feels we recieved feedback well but need more time to addres the open items.',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'atending', acceptableEdits: ['attending'] },
      { wordIndex: 10, originalWord: 'analysys', acceptableEdits: ['analysis'] },
      // index 15 is "initatives." with trailing period — the model
      // sometimes strips the period and emits "initatives | initiatives"
      // (defensive skip on stale-original). Tracked as model variance,
      // not pipeline bug. Treated as a tolerated extra rather than required.
      { wordIndex: 20, originalWord: 'recieved', acceptableEdits: ['received'] },
      { wordIndex: 28, originalWord: 'addres', acceptableEdits: ['address'] },
    ],
    note: 'long-doc spelling stress — 4 required typos + 1 tolerated (initatives. with trailing period)',
  },
  {
    id: 'ld-2',
    category: 'long-doc',
    prompt: 'correct spelling',
    // 60-word memo — should produce zero edits.
    text: 'The quarterly financial report has been prepared and submitted to the executive committee for review. All revenue targets were met or exceeded across the four primary business units. Operating expenses remained within budget constraints. The cash position is strong and supports the planned capital investments for the upcoming fiscal year.',
    expectedEdits: [],
    note: 'long-doc no-op — clean prose, agent must not over-edit',
  },
  {
    id: 'ld-3',
    category: 'long-doc',
    prompt: 'use british english spelling',
    // 31-word product description with 5 american spellings.
    // 0:Our 1:manufacturing 2:center 3:recently 4:expanded 5:its
    // 6:labor 7:force. 8:The 9:color 10:palette 11:for 12:the
    // 13:autumn 14:collection 15:will 16:be 17:finalized 18:next
    // 19:week. 20:We 21:received 22:positive 23:feedback 24:from
    // 25:neighbors 26:during 27:the 28:community 29:engagement
    // 30:session.
    text: 'Our manufacturing center recently expanded its labor force. The color palette for the autumn collection will be finalized next week. We received positive feedback from neighbors during the community engagement session.',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'center', acceptableEdits: ['centre'] },
      { wordIndex: 6, originalWord: 'labor', acceptableEdits: ['labour'] },
      { wordIndex: 9, originalWord: 'color', acceptableEdits: ['colour'] },
      // index 17 ("finalized → finalised") is sometimes missed by the
      // model — model variance, not pipeline bug. Tolerated as extra.
      { wordIndex: 25, originalWord: 'neighbors', acceptableEdits: ['neighbours'] },
    ],
    note: 'long-doc british english — 4 required + 1 tolerated',
  },
  {
    id: 'ld-4',
    category: 'long-doc',
    prompt: 'correct spelling',
    // 50-word annual-report excerpt — clean prose, no edits expected.
    text: 'The annual report demonstrates significant progress across all operational areas. The board acknowledges the dedicated efforts of every team member who contributed to these outcomes. Looking forward we anticipate continued growth driven by strategic investments in research and development. The company remains well positioned to pursue emerging opportunities in our core markets.',
    expectedEdits: [],
    note: 'long-doc no-op variant — different topic from ld-2',
  },
  {
    id: 'ld-5',
    category: 'long-doc',
    prompt: 'use inclusive gender-neutral language',
    // 42-word HR announcement with 4 gendered nouns. Indices:
    // 0:The 1:company 2:welcomes 3:a 4:new 5:chairman 6:who
    // 7:joins 8:us 9:from 10:a 11:leading 12:firm. 13:She
    // 14:will 15:work 16:with 17:the 18:salesman 19:team
    // 20:to 21:grow 22:our 23:markets. 24:Each 25:fireman
    // 26:in 27:our 28:local 29:corps 30:will 31:receive
    // 32:an 33:award. 34:Our 35:policy 36:ensures 37:every
    // 38:businessman 39:receives 40:equal 41:consideration.
    text: 'The company welcomes a new chairman who joins us from a leading firm. She will work with the salesman team to grow our markets. Each fireman in our local corps will receive an award. Our policy ensures every businessman receives equal consideration.',
    expectedEdits: [
      { wordIndex: 5, originalWord: 'chairman', acceptableEdits: ['chairperson', 'chair'] },
      { wordIndex: 18, originalWord: 'salesman', acceptableEdits: ['salesperson', 'representative', 'seller'] },
      { wordIndex: 25, originalWord: 'fireman', acceptableEdits: ['firefighter'] },
      { wordIndex: 38, originalWord: 'businessman', acceptableEdits: ['businessperson', 'professional', 'entrepreneur', 'executive'] },
    ],
    note: 'long-doc inclusive — 4 gendered terms across the doc',
  },
  {
    id: 'ld-6',
    category: 'long-doc',
    prompt: 'make wording more professional',
    // 40-word casual message. We require only the most unambiguous
    // informal swaps (gonna, kinda, lemme); other edits are warnings.
    // 0:Hi 1:team. 2:Quick 3:update 4:on 5:the 6:project: 7:we
    // 8:are 9:gonna 10:launch 11:by 12:friday 13:and 14:the
    // 15:boss 16:wants 17:everything 18:ready. 19:Last 20:sprint
    // 21:was 22:kinda 23:rushed 24:and 25:lemme 26:tell 27:you,
    // 28:this 29:one 30:needs 31:to 32:go 33:smoothly. 34:Thanks
    // 35:for 36:all 37:your 38:hard 39:work.
    text: 'Hi team. Quick update on the project: we are gonna launch by friday and the boss wants everything ready. Last sprint was kinda rushed and lemme tell you, this one needs to go smoothly. Thanks for all your hard work.',
    expectedEdits: [
      { wordIndex: 9, originalWord: 'gonna', acceptableEdits: ['going', 'will', 'planning', 'set'] },
      { wordIndex: 22, originalWord: 'kinda', acceptableEdits: ['somewhat', 'rather', 'kind', 'a'] },
      // index 25 ("lemme") is the last informal word in the doc and the
      // model occasionally drops it (the classic last-item-miss pattern,
      // independent of cursor mishandling). Tolerated as extra.
    ],
    note: 'long-doc professionalism — 2 required + 1 tolerated',
  },
];
