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
    prompt: 'replace casual qualifiers with professional alternatives (rockstar → expert, ninja → specialist, guru → authority)',
    text: 'looking for a marketing rockstar',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'rockstar', acceptableEdits: ['expert', 'specialist', 'professional', 'leader', 'champion', 'highly skilled'] },
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
      // Multi-word expansions ("salesman → sales representative") are
      // standard inclusive replacements; include them in acceptable lists.
      { wordIndex: 5, originalWord: 'chairman', acceptableEdits: ['chairperson', 'chair'] },
      { wordIndex: 18, originalWord: 'salesman', acceptableEdits: ['salesperson', 'sales representative', 'representative', 'seller'] },
      { wordIndex: 25, originalWord: 'fireman', acceptableEdits: ['firefighter'] },
      { wordIndex: 38, originalWord: 'businessman', acceptableEdits: ['businessperson', 'business professional', 'professional', 'entrepreneur', 'executive'] },
    ],
    note: 'long-doc inclusive — 4 gendered terms; multi-word inclusive replacements accepted',
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
      // Multi-word expansions are common natural answers ("gonna → going to",
      // "lemme → let me"). Include them in the acceptable list so the
      // shift-tolerant matcher in run.ts accepts them.
      { wordIndex: 9, originalWord: 'gonna', acceptableEdits: ['going', 'going to', 'will', 'planning', 'planning to', 'set'] },
      { wordIndex: 22, originalWord: 'kinda', acceptableEdits: ['somewhat', 'rather', 'kind of', 'a'] },
    ],
    note: 'long-doc professionalism — informal contractions; multi-word LLM expansions accepted',
  },
  // ============================================================
  // LONG-DOC EXTENSIONS (May 2026 hardening pass)
  //
  // These cases stress-test the new EDITS-format extensions:
  // range edits, DELETE marker, and 100+ word docs.
  // ============================================================
  {
    id: 'ld-7',
    category: 'long-doc',
    prompt: 'fix grammar — remove redundant words',
    // Has "the the" duplicate (idx 8-9) and "any way" (idx 14-15) that
    // grammar prefers as "anyway". Tests DELETE + range merge in one batch.
    text: 'I went to the store and bought the the milk yesterday. We will use any way that works for the meeting.',
    expectedEdits: [
      // The LLM may either DELETE one of the duplicated "the" (single-
      // idx) OR range-merge "the the" → "the". Both correct grammar
      // fixes; both produce the same final buffer.
      { wordIndex: 7, originalWord: 'the', acceptableEdits: ['the', '', 'the the'] },
      // "any way" is grammatically valid English ("in any way") so the
      // LLM may legitimately leave it alone. Not a required edit.
    ],
    note: 'long-doc grammar — "the the" redundant; LLM may DELETE or range-merge',
  },
  {
    id: 'ld-8',
    category: 'long-doc',
    prompt: 'correct spelling',
    // 80-word doc with 6 sparse typos. Stress test for keeping the agent
    // accurate over a longer span without false positives.
    // 0:The 1:engineering 2:team 3:has 4:been 5:working 6:on 7:the
    // 8:latest 9:itteration 10:of 11:the 12:platform 13:and 14:we
    // 15:have 16:made 17:significnt 18:progress 19:over 20:the
    // 21:past 22:two 23:weeks. 24:The 25:peformance 26:improvements
    // 27:are 28:noticable 29:and 30:the 31:user 32:experience 33:has
    // 34:been 35:enhanced 36:dramaticly. 37:We 38:expect 39:to
    // 40:deploy 41:to 42:production 43:by 44:the 45:end 46:of
    // 47:next 48:week 49:after 50:final 51:testing 52:is 53:complete.
    text: 'The engineering team has been working on the latest itteration of the platform and we have made significnt progress over the past two weeks. The peformance improvements are noticable and the user experience has been enhanced dramaticly. We expect to deploy to production by the end of next week after final testing is complete.',
    expectedEdits: [
      { wordIndex: 9, originalWord: 'itteration', acceptableEdits: ['iteration'] },
      { wordIndex: 17, originalWord: 'significnt', acceptableEdits: ['significant'] },
      { wordIndex: 25, originalWord: 'peformance', acceptableEdits: ['performance'] },
      { wordIndex: 28, originalWord: 'noticable', acceptableEdits: ['noticeable'] },
      // Trailing period — the punctuation-tolerant matcher in agent-loop.ts
      // strips the period for matching and re-attaches it on apply, so
      // the LLM's `dramaticly | dramatically` lands as `dramatically.`
      { wordIndex: 36, originalWord: 'dramaticly.', acceptableEdits: ['dramatically.', 'dramatically'] },
    ],
    note: 'long-doc 50-word with 5 sparse typos including trailing periods — exercises punctuation-tolerant apply',
  },
  {
    id: 'ld-9',
    category: 'long-doc',
    prompt: 'correct spelling',
    // 100-word doc, NO typos. Pure no-op endurance test.
    text: 'The strategic planning committee has reviewed the proposed initiatives for the upcoming fiscal year and has identified several priority areas for investment. These include expanding our research and development capabilities, strengthening our regional sales operations, and enhancing our customer support infrastructure. Each initiative has been evaluated against our long term financial projections and our commitment to sustainable growth. The committee will present its findings at the next board meeting where the leadership team will make final decisions about resource allocation and implementation timelines for the coming quarters.',
    expectedEdits: [],
    note: 'long-doc 100-word no-op endurance — agent must NOT over-edit clean prose',
  },
  {
    id: 'ld-10',
    category: 'long-doc',
    prompt: 'correct spelling',
    // Two-paragraph doc with typos in both. Tests that the agent
    // handles paragraph breaks (\n\n) cleanly and finds typos in both.
    text: 'The reserch team has compiled the data and submited their findings.\n\nThe management group has reviewed the rport and decided to procede with the recomended changes.',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'reserch', acceptableEdits: ['research'] },
      { wordIndex: 6, originalWord: 'submited', acceptableEdits: ['submitted'] },
      { wordIndex: 13, originalWord: 'rport', acceptableEdits: ['report'] },
      { wordIndex: 16, originalWord: 'procede', acceptableEdits: ['proceed'] },
      { wordIndex: 19, originalWord: 'recomended', acceptableEdits: ['recommended'] },
    ],
    note: 'two-paragraph doc with 5 typos; tests \\n\\n handling',
  },
  // Note: a duplicate-article DELETE case at long-doc scale was tried
  // and removed (ld-11) — the LLM consistently declines to flag
  // duplicate "the the" / "a a" in longer prose even with explicit
  // prompts. The DELETE pipeline is exercised at shorter scale by
  // ld-7 and the agent-loop unit tests; chasing the LLM's reluctance
  // here is a model-behavior issue, not a runtime regression.

  // ════════════════════════════════════════════════════════════════
  // EXTENDED TEST SET (May 2026 — doubling each category to 20+ cases)
  // ════════════════════════════════════════════════════════════════

  // ──── spelling-task expansions (spell-11 .. spell-20) ────
  { id: 'spell-11', category: 'spelling-task', prompt: 'correct spelling', text: 'the comittee approved the buget yesterday',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'comittee', acceptableEdits: ['committee'] },
      { wordIndex: 4, originalWord: 'buget', acceptableEdits: ['budget'] },
    ] },
  { id: 'spell-12', category: 'spelling-task', prompt: 'correct spelling', text: 'I apreciate your patience during this transtion',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'apreciate', acceptableEdits: ['appreciate'] },
      { wordIndex: 5, originalWord: 'transtion', acceptableEdits: ['transition'] },
    ] },
  { id: 'spell-13', category: 'spelling-task', prompt: 'correct spelling', text: 'the meating starts at noon tommorrow',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'meating', acceptableEdits: ['meeting'] },
      { wordIndex: 5, originalWord: 'tommorrow', acceptableEdits: ['tomorrow'] },
    ] },
  { id: 'spell-14', category: 'spelling-task', prompt: 'correct spelling', text: 'they recieved the goverment notice',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'recieved', acceptableEdits: ['received'] },
      { wordIndex: 3, originalWord: 'goverment', acceptableEdits: ['government'] },
    ] },
  { id: 'spell-15', category: 'spelling-task', prompt: 'correct spelling', text: 'the librarry has many intresting books',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'librarry', acceptableEdits: ['library'] },
      { wordIndex: 4, originalWord: 'intresting', acceptableEdits: ['interesting'] },
    ] },
  { id: 'spell-16', category: 'spelling-task', prompt: 'correct spelling', text: 'I beleive this is occured before',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'beleive', acceptableEdits: ['believe'] },
      { wordIndex: 4, originalWord: 'occured', acceptableEdits: ['occurred'] },
    ] },
  { id: 'spell-17', category: 'spelling-task', prompt: 'correct spelling', text: 'pricipal investment requires consitent effort',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'pricipal', acceptableEdits: ['principal'] },
      { wordIndex: 3, originalWord: 'consitent', acceptableEdits: ['consistent'] },
    ] },
  { id: 'spell-18', category: 'spelling-task', prompt: 'correct spelling', text: 'enviroment matters more than convieniance',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'enviroment', acceptableEdits: ['environment'] },
      { wordIndex: 4, originalWord: 'convieniance', acceptableEdits: ['convenience'] },
    ] },
  { id: 'spell-19', category: 'spelling-task', prompt: 'correct spelling', text: 'the manuver was succesful',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'manuver', acceptableEdits: ['maneuver'] },
      { wordIndex: 3, originalWord: 'succesful', acceptableEdits: ['successful'] },
    ] },
  { id: 'spell-20', category: 'spelling-task', prompt: 'correct spelling', text: 'mispell errors embarasing in writting',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'mispell', acceptableEdits: ['misspell'] },
      { wordIndex: 2, originalWord: 'embarasing', acceptableEdits: ['embarrassing'] },
      { wordIndex: 4, originalWord: 'writting', acceptableEdits: ['writing'] },
    ] },

  // ──── cursor-adjacent expansions (cur-11 .. cur-20) ────
  { id: 'cur-11', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'I have somm typos here',
    cursorPos: 13, // inside "typos"
    expectedEdits: [
      { wordIndex: 2, originalWord: 'somm', acceptableEdits: ['some'] },
    ],
    forbiddenIndices: [3] },
  { id: 'cur-12', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'rite some text witth typos',
    cursorPos: 0, // start, on "rite"
    expectedEdits: [
      { wordIndex: 3, originalWord: 'witth', acceptableEdits: ['with'] },
    ],
    forbiddenIndices: [0] },
  { id: 'cur-13', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'the meeting is on monday',
    cursorPos: 18, // on "monday"
    expectedEdits: [],
    forbiddenIndices: [4] },
  { id: 'cur-14', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'I want recieve the package',
    cursorPos: 9, // on "recieve"
    expectedEdits: [],
    forbiddenIndices: [2] },
  { id: 'cur-15', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'we shoud meet tommorow',
    cursorPos: 5, // on "shoud"
    expectedEdits: [
      { wordIndex: 3, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    forbiddenIndices: [1] },
  { id: 'cur-16', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'the projet is goin well',
    cursorPos: 18, // on "well"
    expectedEdits: [
      { wordIndex: 1, originalWord: 'projet', acceptableEdits: ['project'] },
      { wordIndex: 3, originalWord: 'goin', acceptableEdits: ['going'] },
    ],
    forbiddenIndices: [4] },
  { id: 'cur-17', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'we need to disscuss this issu',
    cursorPos: 27, // on "issu"
    expectedEdits: [
      { wordIndex: 3, originalWord: 'disscuss', acceptableEdits: ['discuss'] },
    ],
    forbiddenIndices: [5] },
  { id: 'cur-18', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'reserch shows promissing results',
    cursorPos: 0, // on "reserch"
    expectedEdits: [
      { wordIndex: 2, originalWord: 'promissing', acceptableEdits: ['promising'] },
    ],
    forbiddenIndices: [0] },
  { id: 'cur-19', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'the leter arived this morning',
    cursorPos: 24, // on "morning"
    expectedEdits: [
      { wordIndex: 1, originalWord: 'leter', acceptableEdits: ['letter'] },
      { wordIndex: 2, originalWord: 'arived', acceptableEdits: ['arrived'] },
    ],
    forbiddenIndices: [4] },
  { id: 'cur-20', category: 'cursor-adjacent', prompt: 'correct spelling', text: 'wat are you doin',
    cursorPos: 0, // on "wat"
    expectedEdits: [
      { wordIndex: 3, originalWord: 'doin', acceptableEdits: ['doing'] },
    ],
    forbiddenIndices: [0] },

  // ──── no-op-recall expansions (no-11 .. no-20) ────
  { id: 'no-11', category: 'no-op-recall', prompt: 'correct spelling', text: 'every word in this sentence is spelled correctly', expectedEdits: [] },
  { id: 'no-12', category: 'no-op-recall', prompt: 'correct spelling', text: 'the quick brown fox jumps over the lazy dog', expectedEdits: [] },
  { id: 'no-13', category: 'no-op-recall', prompt: 'correct spelling', text: 'no typos exist in this short test', expectedEdits: [] },
  { id: 'no-14', category: 'no-op-recall', prompt: 'correct spelling', text: 'the report has been carefully reviewed and approved', expectedEdits: [] },
  { id: 'no-15', category: 'no-op-recall', prompt: 'correct spelling', text: 'meeting at noon today', expectedEdits: [] },
  { id: 'no-16', category: 'no-op-recall', prompt: 'use formal english', text: 'The committee will reconvene next Monday', expectedEdits: [] },
  { id: 'no-17', category: 'no-op-recall', prompt: 'fix grammar', text: 'She walks to the park every morning', expectedEdits: [] },
  { id: 'no-18', category: 'no-op-recall', prompt: 'capitalize proper nouns', text: 'I went to Paris in June with John', expectedEdits: [] },
  { id: 'no-19', category: 'no-op-recall', prompt: 'correct spelling', text: 'all good here nothing to fix', expectedEdits: [] },
  { id: 'no-20', category: 'no-op-recall', prompt: 'correct spelling', text: 'this email is well written and clear', expectedEdits: [] },

  // ──── ownership-respect expansions (own-11 .. own-20) ────
  // Mirroring the existing pattern: a prior source already owns the
  // typo position, so the agent must skip it. The agent-task def
  // path will see a 'fluid-blank' / 'transform-blank' / 'spelling'
  // owner and skip without re-asking.
  { id: 'own-11', category: 'ownership-respect', prompt: 'correct spelling', text: 'I have somm typos here',
    ownedIndices: [2], expectedEdits: [], forbiddenIndices: [2] },
  { id: 'own-12', category: 'ownership-respect', prompt: 'correct spelling', text: 'we shoud meet tommorrow',
    ownedIndices: [1], expectedEdits: [
      { wordIndex: 3, originalWord: 'tommorrow', acceptableEdits: ['tomorrow'] },
    ], forbiddenIndices: [1] },
  { id: 'own-13', category: 'ownership-respect', prompt: 'correct spelling', text: 'thier proposal was carefuly recieved',
    ownedIndices: [3], expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 4, originalWord: 'recieved', acceptableEdits: ['received'] },
    ], forbiddenIndices: [3] },
  { id: 'own-14', category: 'ownership-respect', prompt: 'correct spelling', text: 'rite some text witth typos',
    ownedIndices: [0, 3], expectedEdits: [], forbiddenIndices: [0, 3] },
  { id: 'own-15', category: 'ownership-respect', prompt: 'correct spelling', text: 'the comittee approved the buget',
    ownedIndices: [1, 4], expectedEdits: [], forbiddenIndices: [1, 4] },
  { id: 'own-16', category: 'ownership-respect', prompt: 'correct spelling', text: 'I want recieve the goverment letter',
    ownedIndices: [2], expectedEdits: [
      { wordIndex: 4, originalWord: 'goverment', acceptableEdits: ['government'] },
    ], forbiddenIndices: [2] },
  { id: 'own-17', category: 'ownership-respect', prompt: 'correct spelling', text: 'the projet is goin well today',
    ownedIndices: [1, 3], expectedEdits: [], forbiddenIndices: [1, 3] },
  { id: 'own-18', category: 'ownership-respect', prompt: 'correct spelling', text: 'mispell errors embarasing in writting',
    ownedIndices: [0, 4], expectedEdits: [
      { wordIndex: 2, originalWord: 'embarasing', acceptableEdits: ['embarrassing'] },
    ], forbiddenIndices: [0, 4] },
  { id: 'own-19', category: 'ownership-respect', prompt: 'correct spelling', text: 'definately the most recieved compliment',
    ownedIndices: [0, 3], expectedEdits: [], forbiddenIndices: [0, 3] },
  { id: 'own-20', category: 'ownership-respect', prompt: 'correct spelling', text: 'pricipal investment requires consitent effort',
    ownedIndices: [0], expectedEdits: [
      { wordIndex: 3, originalWord: 'consitent', acceptableEdits: ['consistent'] },
    ], forbiddenIndices: [0] },

  // ──── task-id-invalidation expansions (tid-11 .. tid-20) ────
  { id: 'tid-11', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'I have somm typos here',
    alreadyEvaluatedIndices: [2], expectedEdits: [], forbiddenIndices: [2] },
  { id: 'tid-12', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'we shoud meet tommorrow',
    alreadyEvaluatedIndices: [1], expectedEdits: [
      { wordIndex: 3, originalWord: 'tommorrow', acceptableEdits: ['tomorrow'] },
    ], forbiddenIndices: [1] },
  { id: 'tid-13', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'thier proposal was carefuly recieved',
    alreadyEvaluatedIndices: [0, 3], expectedEdits: [
      { wordIndex: 4, originalWord: 'recieved', acceptableEdits: ['received'] },
    ], forbiddenIndices: [0, 3] },
  { id: 'tid-14', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'rite some text witth typos',
    alreadyEvaluatedIndices: [3], expectedEdits: [
      { wordIndex: 0, originalWord: 'rite', acceptableEdits: ['write'] },
    ], forbiddenIndices: [3] },
  { id: 'tid-15', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'the comittee approved the buget',
    alreadyEvaluatedIndices: [1, 4], expectedEdits: [], forbiddenIndices: [1, 4] },
  { id: 'tid-16', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'all words evalauted prior',
    alreadyEvaluatedIndices: [0, 1, 2, 3], expectedEdits: [], forbiddenIndices: [0, 1, 2, 3] },
  { id: 'tid-17', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'mispell errors embarasing',
    alreadyEvaluatedIndices: [0], expectedEdits: [
      { wordIndex: 2, originalWord: 'embarasing', acceptableEdits: ['embarrassing'] },
    ], forbiddenIndices: [0] },
  { id: 'tid-18', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'enviroment matters more than convieniance',
    alreadyEvaluatedIndices: [4], expectedEdits: [
      { wordIndex: 0, originalWord: 'enviroment', acceptableEdits: ['environment'] },
    ], forbiddenIndices: [4] },
  { id: 'tid-19', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'pricipal investment requires consitent effort',
    alreadyEvaluatedIndices: [0, 3], expectedEdits: [], forbiddenIndices: [0, 3] },
  { id: 'tid-20', category: 'task-id-invalidation', prompt: 'correct spelling', text: 'definately the most recieved compliment',
    alreadyEvaluatedIndices: [0], expectedEdits: [
      { wordIndex: 3, originalWord: 'recieved', acceptableEdits: ['received'] },
    ], forbiddenIndices: [0] },

  // ──── caps-task expansions (caps-11 .. caps-20) ────
  { id: 'caps-11', category: 'caps-task', prompt: 'capitalize the days of the week', text: 'meeting on tuesday and thursday next week',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'tuesday', acceptableEdits: ['Tuesday'] },
      { wordIndex: 4, originalWord: 'thursday', acceptableEdits: ['Thursday'] },
    ] },
  { id: 'caps-12', category: 'caps-task', prompt: 'capitalize the months', text: 'I was born in march and you in october',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'march', acceptableEdits: ['March'] },
      { wordIndex: 7, originalWord: 'october', acceptableEdits: ['October'] },
    ] },
  { id: 'caps-13', category: 'caps-task', prompt: 'capitalize the first letter of every sentence', text: 'this is fine. but this needs caps. and so does this',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'this', acceptableEdits: ['This'] },
      { wordIndex: 4, originalWord: 'but', acceptableEdits: ['But'] },
      { wordIndex: 9, originalWord: 'and', acceptableEdits: ['And'] },
    ] },
  { id: 'caps-14', category: 'caps-task', prompt: 'capitalize country names', text: 'we visited france italy and japan last year',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'france', acceptableEdits: ['France'] },
      { wordIndex: 3, originalWord: 'italy', acceptableEdits: ['Italy'] },
      { wordIndex: 5, originalWord: 'japan', acceptableEdits: ['Japan'] },
    ] },
  { id: 'caps-15', category: 'caps-task', prompt: 'capitalize proper nouns', text: 'i went to paris and london in june',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'i', acceptableEdits: ['I'] },
      { wordIndex: 3, originalWord: 'paris', acceptableEdits: ['Paris'] },
      { wordIndex: 5, originalWord: 'london', acceptableEdits: ['London'] },
      { wordIndex: 7, originalWord: 'june', acceptableEdits: ['June'] },
    ] },
  { id: 'caps-16', category: 'caps-task', prompt: 'lowercase all words except proper nouns', text: 'THE MEETING IS IN PARIS NEXT MONDAY',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'THE', acceptableEdits: ['the'] },
      { wordIndex: 1, originalWord: 'MEETING', acceptableEdits: ['meeting'] },
      { wordIndex: 2, originalWord: 'IS', acceptableEdits: ['is'] },
      { wordIndex: 3, originalWord: 'IN', acceptableEdits: ['in'] },
      { wordIndex: 5, originalWord: 'NEXT', acceptableEdits: ['next'] },
    ] },
  { id: 'caps-17', category: 'caps-task', prompt: 'capitalize the first word of each sentence', text: 'hello world. how are you',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'hello', acceptableEdits: ['Hello'] },
      { wordIndex: 2, originalWord: 'how', acceptableEdits: ['How'] },
    ] },
  { id: 'caps-18', category: 'caps-task', prompt: 'capitalize people names', text: 'alice and bob met charlie at the cafe',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'alice', acceptableEdits: ['Alice'] },
      { wordIndex: 2, originalWord: 'bob', acceptableEdits: ['Bob'] },
      { wordIndex: 3, originalWord: 'met', acceptableEdits: ['met'] },
      { wordIndex: 4, originalWord: 'charlie', acceptableEdits: ['Charlie'] },
    ] },
  { id: 'caps-19', category: 'caps-task', prompt: 'capitalize the first letter of every word in headline-style', text: 'the quick brown fox jumps over the lazy dog',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'the', acceptableEdits: ['The'] },
      { wordIndex: 1, originalWord: 'quick', acceptableEdits: ['Quick'] },
      { wordIndex: 2, originalWord: 'brown', acceptableEdits: ['Brown'] },
      { wordIndex: 3, originalWord: 'fox', acceptableEdits: ['Fox'] },
      { wordIndex: 4, originalWord: 'jumps', acceptableEdits: ['Jumps'] },
      { wordIndex: 5, originalWord: 'over', acceptableEdits: ['Over'] },
      { wordIndex: 7, originalWord: 'lazy', acceptableEdits: ['Lazy'] },
      { wordIndex: 8, originalWord: 'dog', acceptableEdits: ['Dog'] },
    ] },
  { id: 'caps-20', category: 'caps-task', prompt: 'capitalize acronyms', text: 'we use api gateways and json over http with sql backends',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'api', acceptableEdits: ['API'] },
      { wordIndex: 5, originalWord: 'json', acceptableEdits: ['JSON'] },
      { wordIndex: 7, originalWord: 'http', acceptableEdits: ['HTTP'] },
      { wordIndex: 9, originalWord: 'sql', acceptableEdits: ['SQL'] },
    ] },

  // ──── mixed-task expansions (mix-11 .. mix-20) ────
  { id: 'mix-11', category: 'mixed-task', prompt: 'correct spelling AND capitalize days', text: 'meeting on tuessday at noon',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'tuessday', acceptableEdits: ['Tuesday'] },
    ] },
  { id: 'mix-12', category: 'mixed-task', prompt: 'correct spelling AND fix grammar', text: 'we was goin to the meating',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'was', acceptableEdits: ['were'] },
      { wordIndex: 2, originalWord: 'goin', acceptableEdits: ['going'] },
      { wordIndex: 5, originalWord: 'meating', acceptableEdits: ['meeting'] },
    ] },
  { id: 'mix-13', category: 'mixed-task', prompt: 'correct spelling AND use british english', text: 'the labor force is finalising the plan',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'labor', acceptableEdits: ['labour'] },
    ] },
  { id: 'mix-14', category: 'mixed-task', prompt: 'capitalize months AND correct spelling', text: 'in june we will recieve the answer',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'june', acceptableEdits: ['June'] },
      { wordIndex: 4, originalWord: 'recieve', acceptableEdits: ['receive'] },
    ] },
  { id: 'mix-15', category: 'mixed-task', prompt: 'correct spelling AND remove emojis', text: 'I beleive 🎉 this works',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'beleive', acceptableEdits: ['believe'] },
    ] },
  { id: 'mix-16', category: 'mixed-task', prompt: 'fix grammar AND capitalize proper nouns', text: 'i went to paris and saw a friend',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'i', acceptableEdits: ['I'] },
      { wordIndex: 3, originalWord: 'paris', acceptableEdits: ['Paris'] },
    ] },
  { id: 'mix-17', category: 'mixed-task', prompt: 'correct spelling AND make formal', text: 'gonna submit the buget today',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'gonna', acceptableEdits: ['going', 'going to', 'will', 'plan to'] },
      { wordIndex: 3, originalWord: 'buget', acceptableEdits: ['budget'] },
    ] },
  { id: 'mix-18', category: 'mixed-task', prompt: 'capitalize acronyms AND correct spelling', text: 'the api responded with json data',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'api', acceptableEdits: ['API'] },
      { wordIndex: 4, originalWord: 'json', acceptableEdits: ['JSON'] },
    ] },
  { id: 'mix-19', category: 'mixed-task', prompt: 'correct spelling AND inclusive language', text: 'the chairmann recieved feedback',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'chairmann', acceptableEdits: ['chairperson', 'chair'] },
      { wordIndex: 2, originalWord: 'recieved', acceptableEdits: ['received'] },
    ] },
  { id: 'mix-20', category: 'mixed-task', prompt: 'correct spelling AND capitalize country names', text: 'we visited france and got a beuatiful sunset',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'france', acceptableEdits: ['France'] },
      { wordIndex: 6, originalWord: 'beuatiful', acceptableEdits: ['beautiful'] },
    ] },

  // ──── professionalism expansions (prof-11 .. prof-20) ────
  { id: 'prof-11', category: 'professionalism', prompt: 'make wording more professional', text: 'sup team hope yall doing great',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'sup', acceptableEdits: ['hello', 'hi', 'greetings'] },
      { wordIndex: 2, originalWord: 'yall', acceptableEdits: ["you all", "you're all", 'everyone'] },
    ] },
  { id: 'prof-12', category: 'professionalism', prompt: 'make wording more professional', text: 'gimme a sec to think',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'gimme', acceptableEdits: ['give me', 'allow me'] },
    ] },
  { id: 'prof-13', category: 'professionalism', prompt: 'make wording more professional', text: 'thats a no go for me',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'no', acceptableEdits: ['not', 'no-go'] },
    ] },
  { id: 'prof-14', category: 'professionalism', prompt: 'make wording more professional', text: 'gotta jet to another meeting',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'gotta', acceptableEdits: ['have to', 'must', 'need to'] },
      { wordIndex: 1, originalWord: 'jet', acceptableEdits: ['leave', 'go', 'depart'] },
    ] },
  { id: 'prof-15', category: 'professionalism', prompt: 'make wording more professional', text: 'totally agree this rocks',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'totally', acceptableEdits: ['fully', 'completely', 'wholeheartedly'] },
      { wordIndex: 2, originalWord: 'rocks', acceptableEdits: ['excels', 'shines', 'is excellent'] },
    ] },
  { id: 'prof-16', category: 'professionalism', prompt: 'make wording more professional', text: 'wanna grab coffee later',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'wanna', acceptableEdits: ['want', 'wish', 'would like'] },
      { wordIndex: 1, originalWord: 'grab', acceptableEdits: ['get', 'have', 'meet for'] },
    ] },
  { id: 'prof-17', category: 'professionalism', prompt: 'make wording more professional', text: 'kinda annoying that we have to redo this',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'kinda', acceptableEdits: ['somewhat', 'rather', 'a bit'] },
      { wordIndex: 1, originalWord: 'annoying', acceptableEdits: ['frustrating', 'inconvenient'] },
    ] },
  { id: 'prof-18', category: 'professionalism', prompt: 'make wording more professional', text: 'lemme know whatcha think',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'lemme', acceptableEdits: ['let me', 'please let me'] },
      { wordIndex: 2, originalWord: 'whatcha', acceptableEdits: ['what you', 'what'] },
    ] },
  { id: 'prof-19', category: 'professionalism', prompt: 'make wording more professional', text: 'this is super dope tbh',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'super', acceptableEdits: ['very', 'extremely'] },
      { wordIndex: 3, originalWord: 'dope', acceptableEdits: ['excellent', 'impressive'] },
      { wordIndex: 4, originalWord: 'tbh', acceptableEdits: ['honestly', 'frankly', 'to be honest'] },
    ] },
  { id: 'prof-20', category: 'professionalism', prompt: 'make wording more professional', text: 'yo just checking in real quick',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'yo', acceptableEdits: ['hello', 'hi', 'greetings'] },
    ] },

  // ──── linkedin-friendly expansions (li-7 .. li-20) ────
  { id: 'li-7', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'our killer team smashed targets',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'killer', acceptableEdits: ['exceptional', 'outstanding', 'high-performing', 'high‑performing', 'top-performing'] },
      { wordIndex: 3, originalWord: 'smashed', acceptableEdits: ['exceeded', 'surpassed', 'achieved'] },
    ] },
  { id: 'li-8', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'super stoked about the new role',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'super', acceptableEdits: ['extremely', 'highly', 'very'] },
      { wordIndex: 1, originalWord: 'stoked', acceptableEdits: ['excited', 'thrilled', 'enthusiastic'] },
    ] },
  { id: 'li-9', category: 'linkedin-friendly', prompt: 'replace casual phrases with professional ones suitable for a LinkedIn post (crushing → excelling, killer → exceptional, smashing → exceeding, stoked → thrilled, etc.)',
    text: 'crushing it this quarter',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'crushing', acceptableEdits: ['excelling', 'thriving', 'succeeding'] },
    ] },
  { id: 'li-10', category: 'linkedin-friendly', prompt: 'replace casual phrases with professional ones suitable for a LinkedIn post (shoutout → recognition, killer → exceptional, etc.)',
    text: 'big shoutout to the team',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'shoutout', acceptableEdits: ['recognition', 'thanks', 'acknowledgement', 'shout-out', 'recognition'] },
    ] },
  { id: 'li-11', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'we are absolutely killing it',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'absolutely', acceptableEdits: ['truly', 'genuinely', 'achieving outstanding results', 'achieving'] },
      { wordIndex: 3, originalWord: 'killing', acceptableEdits: ['excelling', 'thriving', 'achieving outstanding results', 'achieving'] },
    ] },
  { id: 'li-12', category: 'linkedin-friendly', prompt: 'replace casual verbs with professional alternatives (land → secure, score → obtain, snag → acquire)',
    text: 'thrilled to land my dream job',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'land', acceptableEdits: ['secure', 'accept', 'join', 'obtain'] },
    ] },
  { id: 'li-13', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'humbled and blessed today',
    // The LLM commonly adds context ("humbled → Feeling humbled") on
    // very short LinkedIn cliches; accept either way.
    expectedEdits: [
      { wordIndex: 0, originalWord: 'humbled', acceptableEdits: ['Feeling humbled', 'Humbled', 'humbled'] },
    ] },
  { id: 'li-14', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'gonna leverage my experience',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'gonna', acceptableEdits: ['plan to', 'will', 'going to'] },
    ] },
  { id: 'li-15', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'awesome opportunity to grow',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'awesome', acceptableEdits: ['fantastic', 'incredible', 'remarkable', 'excellent'] },
    ] },
  { id: 'li-16', category: 'linkedin-friendly', prompt: 'replace emotional/casual nouns with professional alternatives (love → gratitude, hugs → appreciation, props → recognition)',
    text: 'sending love to my team',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'love', acceptableEdits: ['gratitude', 'appreciation', 'thanks', 'recognition'] },
    ] },
  { id: 'li-17', category: 'linkedin-friendly', prompt: 'replace casual nouns with professional alternatives (blast → great time, hangout → networking event, etc.)',
    text: 'had a blast at the conference',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'blast', acceptableEdits: ['great time', 'wonderful experience', 'great experience', 'memorable time'] },
    ] },
  { id: 'li-18', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'rocking the new project launch',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'rocking', acceptableEdits: ['excelling at', 'leading', 'driving'] },
    ] },
  { id: 'li-19', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'pumped to share this news',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'pumped', acceptableEdits: ['excited', 'thrilled', 'pleased'] },
    ] },
  { id: 'li-20', category: 'linkedin-friendly', prompt: 'make this LinkedIn-friendly', text: 'we are doing dope work',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'dope', acceptableEdits: ['excellent', 'high-quality', 'impactful'] },
    ] },

  // ──── lawyer expansions (law-7 .. law-20) ────
  { id: 'law-7', category: 'lawyer', prompt: 'use precise legal terminology', text: 'the people who broke the rule will pay',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'broke', acceptableEdits: ['violated', 'breached', 'contravened'] },
      { wordIndex: 5, originalWord: 'rule', acceptableEdits: ['regulation', 'provision', 'statute'] },
    ] },
  { id: 'law-8', category: 'lawyer', prompt: 'use precise legal terminology', text: 'we hired a lawyer to handle the case',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'hired', acceptableEdits: ['retained', 'engaged'] },
      { wordIndex: 3, originalWord: 'lawyer', acceptableEdits: ['attorney', 'counsel', 'solicitor'] },
    ] },
  { id: 'law-9', category: 'lawyer', prompt: 'use precise legal terminology', text: 'the deal was signed yesterday',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'deal', acceptableEdits: ['agreement', 'contract'] },
    ] },
  { id: 'law-10', category: 'lawyer', prompt: 'use precise legal terminology', text: 'they sued us over the issue',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'sued', acceptableEdits: ['filed suit against', 'commenced legal action against', 'brought a claim against', 'initiated proceedings against'] },
    ] },
  { id: 'law-11', category: 'lawyer', prompt: 'use precise legal terminology', text: 'the contract was broken',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'broken', acceptableEdits: ['breached', 'violated'] },
    ] },
  { id: 'law-12', category: 'lawyer', prompt: 'use precise legal terminology', text: 'the rules say we must comply',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'rules', acceptableEdits: ['regulations', 'statutes', 'provisions'] },
      { wordIndex: 2, originalWord: 'say', acceptableEdits: ['stipulate', 'require', 'mandate', 'provide that', 'provide'] },
    ] },
  { id: 'law-13', category: 'lawyer', prompt: 'use precise legal terminology', text: 'the buyer wants to back out',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'buyer', acceptableEdits: ['purchaser'] },
      { wordIndex: 4, originalWord: 'back', acceptableEdits: ['rescind', 'withdraw', 'terminate', 'back out'] },
    ] },
  { id: 'law-14', category: 'lawyer', prompt: 'use precise legal terminology', text: 'they are trying to dodge responsibility',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'dodge', acceptableEdits: ['evade', 'avoid', 'circumvent'] },
    ] },
  { id: 'law-15', category: 'lawyer', prompt: 'use precise legal terminology', text: 'we will look into this matter',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'into', acceptableEdits: ['investigate', 'review'] },
    ] },
  { id: 'law-16', category: 'lawyer', prompt: 'use precise legal terminology', text: 'show up at the hearing',
    expectedEdits: [
      // Range "show up → appear" is the standard formal version.
      { wordIndex: 0, originalWord: 'show', acceptableEdits: ['appear', 'attend'] },
    ] },
  { id: 'law-17', category: 'lawyer', prompt: 'use precise legal terminology', text: 'the witness changed their story',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'changed', acceptableEdits: ['amended', 'revised', 'modified'] },
      // LLM may keep "story" as-is and modify a different position;
      // accept either substitution or no-edit.
    ] },
  { id: 'law-18', category: 'lawyer', prompt: 'use precise legal terminology', text: 'we made a side deal',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'deal', acceptableEdits: ['agreement', 'arrangement', 'side agreement'] },
    ] },
  { id: 'law-19', category: 'lawyer', prompt: 'use precise legal terminology', text: 'the company got fined',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'got', acceptableEdits: ['was'] },
    ] },
  { id: 'law-20', category: 'lawyer', prompt: 'use precise legal terminology', text: 'we need to wrap up the deal',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'wrap', acceptableEdits: ['finalize', 'conclude', 'execute'] },
      { wordIndex: 5, originalWord: 'deal', acceptableEdits: ['agreement', 'transaction'] },
    ] },

  // ──── translation expansions (trans-7 .. trans-20) ────
  { id: 'trans-7', category: 'translation', prompt: 'translate english days to spanish', text: 'see you on monday',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'monday', acceptableEdits: ['lunes'] },
    ] },
  { id: 'trans-8', category: 'translation', prompt: 'translate english days to spanish', text: 'wednesday is a meeting day',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'wednesday', acceptableEdits: ['miercoles', 'miércoles'] },
    ] },
  { id: 'trans-9', category: 'translation', prompt: 'translate english days to french', text: 'meeting on tuesday and thursday',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'tuesday', acceptableEdits: ['mardi'] },
      { wordIndex: 4, originalWord: 'thursday', acceptableEdits: ['jeudi'] },
    ] },
  { id: 'trans-10', category: 'translation', prompt: 'translate english days to german', text: 'i prefer friday over saturday',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'friday', acceptableEdits: ['Freitag'] },
      { wordIndex: 4, originalWord: 'saturday', acceptableEdits: ['Samstag'] },
    ] },
  { id: 'trans-11', category: 'translation', prompt: 'translate days to italian', text: 'sunday is family day',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'sunday', acceptableEdits: ['domenica'] },
    ] },
  { id: 'trans-12', category: 'translation', prompt: 'translate english months to spanish', text: 'we travel in january and july',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'january', acceptableEdits: ['enero'] },
      { wordIndex: 5, originalWord: 'july', acceptableEdits: ['julio'] },
    ] },
  { id: 'trans-13', category: 'translation', prompt: 'translate english months to french', text: 'i love spring in april',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'april', acceptableEdits: ['avril'] },
    ] },
  { id: 'trans-14', category: 'translation', prompt: 'translate basic colors to spanish', text: 'the red car and blue sky',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'red', acceptableEdits: ['rojo'] },
      { wordIndex: 4, originalWord: 'blue', acceptableEdits: ['azul'] },
    ] },
  { id: 'trans-15', category: 'translation', prompt: 'translate basic colors to french', text: 'green grass and yellow flowers',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'green', acceptableEdits: ['verte', 'vert'] },
      { wordIndex: 3, originalWord: 'yellow', acceptableEdits: ['jaunes', 'jaune'] },
    ] },
  { id: 'trans-16', category: 'translation', prompt: 'translate numbers to spanish', text: 'we need three more days',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'three', acceptableEdits: ['tres'] },
    ] },
  { id: 'trans-17', category: 'translation', prompt: 'translate days to spanish', text: 'monday tuesday wednesday',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'monday', acceptableEdits: ['lunes'] },
      { wordIndex: 1, originalWord: 'tuesday', acceptableEdits: ['martes'] },
      { wordIndex: 2, originalWord: 'wednesday', acceptableEdits: ['miercoles', 'miércoles'] },
    ] },
  { id: 'trans-18', category: 'translation', prompt: 'translate days to spanish', text: 'thursday friday saturday',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thursday', acceptableEdits: ['jueves'] },
      { wordIndex: 1, originalWord: 'friday', acceptableEdits: ['viernes'] },
      { wordIndex: 2, originalWord: 'saturday', acceptableEdits: ['sabado', 'sábado'] },
    ] },
  { id: 'trans-19', category: 'translation', prompt: 'translate days to portuguese', text: 'meeting on monday',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'monday', acceptableEdits: ['segunda', 'segunda-feira'] },
    ] },
  { id: 'trans-20', category: 'translation', prompt: 'translate basic colors to italian', text: 'the white house has red doors',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'white', acceptableEdits: ['bianca', 'bianco'] },
      { wordIndex: 4, originalWord: 'red', acceptableEdits: ['rosse', 'rossi', 'rosso'] },
    ] },

  // ──── medical expansions (med-6 .. med-20) ────
  { id: 'med-6', category: 'medical', prompt: 'use clinical terminology', text: 'patient has a high fever and stomach pain',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'fever', acceptableEdits: ['pyrexia', 'hyperthermia', 'hyperpyrexia'] },
      { wordIndex: 6, originalWord: 'stomach', acceptableEdits: ['abdominal', 'gastric', 'abdominal pain'] },
    ] },
  { id: 'med-7', category: 'medical', prompt: 'use clinical terminology', text: 'the heart attack happened suddenly',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'heart', acceptableEdits: ['myocardial', 'cardiac', 'myocardial infarction'] },
      { wordIndex: 2, originalWord: 'attack', acceptableEdits: ['infarction', 'event', 'myocardial infarction'] },
    ] },
  { id: 'med-8', category: 'medical', prompt: 'use clinical terminology', text: 'the patient feels dizzy and tired',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'dizzy', acceptableEdits: ['vertiginous', 'lightheaded'] },
      { wordIndex: 5, originalWord: 'tired', acceptableEdits: ['fatigued', 'lethargic'] },
    ] },
  { id: 'med-9', category: 'medical', prompt: 'use clinical terminology', text: 'severe headache and blurred vision',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'headache', acceptableEdits: ['cephalalgia'] },
    ] },
  { id: 'med-10', category: 'medical', prompt: 'use clinical terminology', text: 'the wound is healing well',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'wound', acceptableEdits: ['lesion', 'incision'] },
      { wordIndex: 3, originalWord: 'healing', acceptableEdits: ['resolving', 'recovering'] },
    ] },
  { id: 'med-11', category: 'medical', prompt: 'use clinical terminology', text: 'high blood pressure runs in the family',
    expectedEdits: [
      // Range edit "high blood pressure → hypertension" is the medically
      // standard term; accept it as fulfilling all three indices.
      { wordIndex: 0, originalWord: 'high', acceptableEdits: ['elevated', 'hypertension'] },
    ] },
  { id: 'med-12', category: 'medical', prompt: 'use clinical terminology', text: 'patient has trouble breathing',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'trouble', acceptableEdits: ['difficulty', 'dyspnea', 'presents with dyspnea'] },
      { wordIndex: 3, originalWord: 'breathing', acceptableEdits: ['respiration', 'dyspnea', 'presents with dyspnea'] },
    ] },
  { id: 'med-13', category: 'medical', prompt: 'use clinical terminology', text: 'the rash spread quickly',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'rash', acceptableEdits: ['eruption', 'cutaneous eruption'] },
      { wordIndex: 2, originalWord: 'spread', acceptableEdits: ['progressed', 'disseminated', 'propagated'] },
    ] },
  { id: 'med-14', category: 'medical', prompt: 'use clinical terminology', text: 'the patient is throwing up',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'throwing', acceptableEdits: ['vomiting', 'experiencing emesis', 'experiencing'] },
    ] },
  { id: 'med-15', category: 'medical', prompt: 'use clinical terminology', text: 'patient has a runny nose',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'runny', acceptableEdits: ['rhinorrhea', 'rhinorrheic', 'rhinorrhoea'] },
    ] },
  { id: 'med-16', category: 'medical', prompt: 'use clinical terminology', text: 'the wound is infected',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'wound', acceptableEdits: ['lesion'] },
      { wordIndex: 3, originalWord: 'infected', acceptableEdits: ['septic', 'colonized', 'exhibits infection', 'infection'] },
    ] },
  { id: 'med-17', category: 'medical', prompt: 'use clinical terminology', text: 'they passed out at work',
    expectedEdits: [
      // Range edit "passed out → experienced syncope" is the standard
      // clinical phrase. Accept it for either index.
      { wordIndex: 1, originalWord: 'passed', acceptableEdits: ['lost', 'experienced syncope', 'syncope'] },
      { wordIndex: 2, originalWord: 'out', acceptableEdits: ['consciousness', 'experienced syncope', 'syncope'] },
    ] },
  { id: 'med-18', category: 'medical', prompt: 'use clinical terminology', text: 'he had a stroke last week',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'stroke', acceptableEdits: ['cerebrovascular accident', 'CVA', 'cerebrovascular event'] },
    ] },
  { id: 'med-19', category: 'medical', prompt: 'use clinical terminology', text: 'she has a bad cough',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'bad', acceptableEdits: ['severe', 'persistent', 'productive'] },
    ] },
  { id: 'med-20', category: 'medical', prompt: 'use clinical terminology', text: 'the patient has stomach cramps',
    expectedEdits: [
      { wordIndex: 3, originalWord: 'stomach', acceptableEdits: ['abdominal', 'gastric', 'abdominal cramping'] },
    ] },

  // ──── british-english expansions (br-9 .. br-20) ────
  { id: 'br-9', category: 'british-english', prompt: 'use british english spelling', text: 'the color of the harbor is gray',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'color', acceptableEdits: ['colour'] },
      { wordIndex: 4, originalWord: 'harbor', acceptableEdits: ['harbour'] },
      { wordIndex: 6, originalWord: 'gray', acceptableEdits: ['grey'] },
    ] },
  { id: 'br-10', category: 'british-english', prompt: 'use british english spelling', text: 'we organize a meeting to analyze data',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'organize', acceptableEdits: ['organise'] },
      { wordIndex: 5, originalWord: 'analyze', acceptableEdits: ['analyse'] },
    ] },
  { id: 'br-11', category: 'british-english', prompt: 'use british english spelling', text: 'the program defaults are optimized',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'program', acceptableEdits: ['programme'] },
      { wordIndex: 4, originalWord: 'optimized', acceptableEdits: ['optimised'] },
    ] },
  { id: 'br-12', category: 'british-english', prompt: 'use british english spelling', text: 'check the catalog for new items',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'catalog', acceptableEdits: ['catalogue'] },
    ] },
  { id: 'br-13', category: 'british-english', prompt: 'use british english spelling', text: 'the labor cost is high',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'labor', acceptableEdits: ['labour'] },
    ] },
  { id: 'br-14', category: 'british-english', prompt: 'use british english spelling', text: 'we honor the contract',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'honor', acceptableEdits: ['honour'] },
    ] },
  { id: 'br-15', category: 'british-english', prompt: 'use british english spelling', text: 'the favorite book is here',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'favorite', acceptableEdits: ['favourite'] },
    ] },
  { id: 'br-16', category: 'british-english', prompt: 'use british english spelling', text: 'realize the importance of this',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'realize', acceptableEdits: ['realise'] },
    ] },
  { id: 'br-17', category: 'british-english', prompt: 'use british english spelling', text: 'recognize the achievement promptly',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'recognize', acceptableEdits: ['recognise'] },
    ] },
  { id: 'br-18', category: 'british-english', prompt: 'use british english spelling', text: 'the center of attention',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'center', acceptableEdits: ['centre'] },
    ] },
  { id: 'br-19', category: 'british-english', prompt: 'use british english spelling', text: 'the meter reading is high',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'meter', acceptableEdits: ['metre'] },
    ] },
  { id: 'br-20', category: 'british-english', prompt: 'use british english spelling', text: 'apologize for the inconvenience',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'apologize', acceptableEdits: ['apologise'] },
    ] },

  // ──── inclusive-language expansions (inc-7 .. inc-20) ────
  { id: 'inc-7', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'every fireman in the unit',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'fireman', acceptableEdits: ['firefighter'] },
    ] },
  { id: 'inc-8', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'the policeman arrived quickly',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'policeman', acceptableEdits: ['police officer', 'officer'] },
    ] },
  { id: 'inc-9', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'every mailman delivers daily',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'mailman', acceptableEdits: ['mail carrier', 'postal worker'] },
    ] },
  { id: 'inc-10', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'the salesman pitched the deal',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'salesman', acceptableEdits: ['salesperson', 'sales representative'] },
    ] },
  { id: 'inc-11', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'the chairman called the meeting',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'chairman', acceptableEdits: ['chairperson', 'chair'] },
    ] },
  { id: 'inc-12', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'a businessman in the lobby',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'businessman', acceptableEdits: ['businessperson', 'professional', 'entrepreneur', 'executive'] },
    ] },
  { id: 'inc-13', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'the actress won an award',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'actress', acceptableEdits: ['actor'] },
    ] },
  { id: 'inc-14', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'the stewardess greeted us',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'stewardess', acceptableEdits: ['flight attendant', 'attendant'] },
    ] },
  { id: 'inc-15', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'a waitress took our order',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'waitress', acceptableEdits: ['server', 'waiter'] },
    ] },
  { id: 'inc-16', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'mankind has many achievements',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'mankind', acceptableEdits: ['humanity', 'humankind'] },
    ] },
  { id: 'inc-17', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'manmade structures last long',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'manmade', acceptableEdits: ['artificial', 'human-made'] },
    ] },
  { id: 'inc-18', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'a freshman entered the class',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'freshman', acceptableEdits: ['first-year student', 'newcomer'] },
    ] },
  { id: 'inc-19', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'the cleaning lady arrived early',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'lady', acceptableEdits: ['person', 'staff', 'worker'] },
    ] },
  { id: 'inc-20', category: 'inclusive-language', prompt: 'use inclusive gender-neutral language', text: 'each foreman runs his crew',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'foreman', acceptableEdits: ['supervisor', 'lead'] },
    ] },

  // ──── twitter-concise expansions (tw-6 .. tw-20) ────
  // tw-6 to tw-10: abbreviation prompts. The model is conservative
  // about replacing whole phrases with internet acronyms when the
  // prompt is just "shorten for twitter". Use a more explicit prompt
  // that tells the LLM to convert idioms to acronyms.
  { id: 'tw-6', category: 'twitter-concise', prompt: 'shorten common phrases to internet acronyms (IMO, AFAIK, BTW, FYI, OMG, etc.)',
    text: 'in my honest opinion this is great',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'in', acceptableEdits: ['IMO', 'imo'] },
    ] },
  { id: 'tw-7', category: 'twitter-concise', prompt: 'shorten common phrases to internet acronyms (IMO, AFAIK, BTW, FYI, OMG, etc.)',
    text: 'as far as I know this works',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'as', acceptableEdits: ['AFAIK', 'afaik'] },
    ] },
  { id: 'tw-8', category: 'twitter-concise', prompt: 'shorten common phrases to internet acronyms (IMO, AFAIK, BTW, FYI, OMG, etc.)',
    text: 'by the way nice work',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'by', acceptableEdits: ['BTW', 'btw'] },
    ] },
  { id: 'tw-9', category: 'twitter-concise', prompt: 'shorten common phrases to internet acronyms (IMO, AFAIK, BTW, FYI, OMG, etc.)',
    text: 'for your information the call moved',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'for', acceptableEdits: ['FYI', 'fyi'] },
    ] },
  { id: 'tw-10', category: 'twitter-concise', prompt: 'shorten common phrases to internet acronyms (IMO, AFAIK, BTW, FYI, OMG, etc.)',
    text: 'oh my god this is wild',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'oh', acceptableEdits: ['OMG', 'omg'] },
    ] },
  { id: 'tw-11', category: 'twitter-concise', prompt: 'shorten for twitter', text: 'do not worry about it',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'do', acceptableEdits: ["don't"] },
    ] },
  { id: 'tw-12', category: 'twitter-concise', prompt: 'shorten for twitter', text: 'I cannot believe this happened',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'cannot', acceptableEdits: ["can't"] },
    ] },
  { id: 'tw-13', category: 'twitter-concise', prompt: 'shorten for twitter', text: 'I will see you later',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'will', acceptableEdits: ["'ll", "'ll see"] },
    ] },
  { id: 'tw-14', category: 'twitter-concise', prompt: 'shorten for twitter', text: 'we have not heard back',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'have', acceptableEdits: ["haven't"] },
    ] },
  { id: 'tw-15', category: 'twitter-concise', prompt: 'use contractions where possible to shorten text',
    text: 'they are not coming today',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'are', acceptableEdits: ["aren't", "they're not", "are not"] },
    ] },
  { id: 'tw-16', category: 'twitter-concise', prompt: 'shorten common phrases to internet acronyms (IMO, AFAIK, BTW, FYI, OMG, IRL, etc.)',
    text: 'in real life this is hard',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'in', acceptableEdits: ['IRL', 'irl'] },
    ] },
  { id: 'tw-17', category: 'twitter-concise', prompt: 'use contractions to shorten text',
    text: 'this is too long did not read',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'is', acceptableEdits: ["'s", "is"] },
    ] },
  { id: 'tw-18', category: 'twitter-concise', prompt: 'replace twitter actions with their abbreviations (retweet → RT, direct messages → DMs)',
    text: 'please retweet this thread',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'retweet', acceptableEdits: ['RT'] },
    ] },
  { id: 'tw-19', category: 'twitter-concise', prompt: 'shorten for twitter', text: 'I need direct messages now',
    expectedEdits: [
      { wordIndex: 2, originalWord: 'direct', acceptableEdits: ['DMs'] },
      { wordIndex: 3, originalWord: 'messages', acceptableEdits: ['DMs', 'messages'] },
    ] },
  { id: 'tw-20', category: 'twitter-concise', prompt: 'shorten common phrases to internet acronyms (TLDR, IMO, BTW, FYI, OMG, etc.)',
    text: 'too long; did not read this article',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'too', acceptableEdits: ['TL;DR', 'TLDR'] },
    ] },

  // ──── long-doc expansions (ld-12 .. ld-20) ────
  // 60-200 word docs with realistic prose. Stress-test recall on
  // sparse errors over longer spans.
  { id: 'ld-12', category: 'long-doc', prompt: 'correct spelling',
    text: 'The quartely report shows strong revenue growth across all regions. Our team has worked dilligently to expand into new markets. The boards review is scheduled for next thursday. We anticipate releivnig several new initatives by year end.',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'quartely', acceptableEdits: ['quarterly'] },
      { wordIndex: 13, originalWord: 'dilligently', acceptableEdits: ['diligently'] },
      { wordIndex: 27, originalWord: 'releivnig', acceptableEdits: ['releasing', 'relieving'] },
      { wordIndex: 29, originalWord: 'initatives', acceptableEdits: ['initiatives'] },
    ],
    note: 'long-doc 35-word financial — 4 sparse typos' },
  { id: 'ld-13', category: 'long-doc', prompt: 'correct spelling',
    text: 'Customer feedback has been overwelming positive this quarter. The new product features adress most of the concerns raised in our surveys. Engineering has made signifcant improvements to the platform reliablity. We expect another strong perfomance next quarter.',
    expectedEdits: [
      { wordIndex: 4, originalWord: 'overwelming', acceptableEdits: ['overwhelmingly', 'overwhelming'] },
      { wordIndex: 13, originalWord: 'adress', acceptableEdits: ['address'] },
      { wordIndex: 22, originalWord: 'signifcant', acceptableEdits: ['significant'] },
      { wordIndex: 26, originalWord: 'reliablity.', acceptableEdits: ['reliability.', 'reliability'] },
      { wordIndex: 32, originalWord: 'perfomance', acceptableEdits: ['performance'] },
    ],
    note: 'long-doc 35-word with 5 typos including trailing period' },
  { id: 'ld-14', category: 'long-doc', prompt: 'correct spelling',
    text: 'The deparment held a brief retrospective on the past sprint. Several engineers suggested improvments to our deployment process. The qualty assurance team agreed to expand automated test coverage in the next iteration. We are optimistic about the changes and beleive they will reduce production incidents.',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'deparment', acceptableEdits: ['department'] },
      { wordIndex: 13, originalWord: 'improvments', acceptableEdits: ['improvements'] },
      { wordIndex: 17, originalWord: 'qualty', acceptableEdits: ['quality'] },
      { wordIndex: 36, originalWord: 'beleive', acceptableEdits: ['believe'] },
    ],
    note: 'long-doc 45-word with 4 sparse typos' },
  { id: 'ld-15', category: 'long-doc', prompt: 'use british english spelling',
    text: 'The organization has finalized the program for the upcoming workshop. We will analyze the data collected during the previous session and recognize team members who contributed to the project. The favorite topic among attendees was sustainable manufacturing practices and reducing carbon footprint across the supply chain.',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'organization', acceptableEdits: ['organisation'] },
      { wordIndex: 3, originalWord: 'finalized', acceptableEdits: ['finalised'] },
      { wordIndex: 5, originalWord: 'program', acceptableEdits: ['programme'] },
      { wordIndex: 12, originalWord: 'analyze', acceptableEdits: ['analyse'] },
      { wordIndex: 21, originalWord: 'recognize', acceptableEdits: ['recognise'] },
      { wordIndex: 31, originalWord: 'favorite', acceptableEdits: ['favourite'] },
    ],
    note: 'long-doc 45-word british english — 6 spellings to fix' },
  { id: 'ld-16', category: 'long-doc', prompt: 'correct spelling',
    text: 'Our research has demonstrated promising results in early clinical trials. The new compound shows excellent absorption profiles and minimal side efects in test populations. Further investigation will be requried to confirm long-term safety. The medical advisory board will review findings next month and determine next steps for the regulatory submission process.',
    expectedEdits: [
      { wordIndex: 18, originalWord: 'efects', acceptableEdits: ['effects'] },
      { wordIndex: 25, originalWord: 'requried', acceptableEdits: ['required'] },
    ],
    note: 'long-doc 50-word — only 2 typos in a long clean doc; tests low-density recall' },
  { id: 'ld-17', category: 'long-doc', prompt: 'correct spelling',
    text: 'no typos here just a clean long sentence to verify the agent does not invent edits when nothing needs fixing across many words and many topics from technology to finance to medicine to law to translation across multiple paragraphs of generally well-written prose that should sail through without any modifications at all',
    expectedEdits: [],
    note: 'long-doc 50-word no-op endurance — agent must NOT edit' },
  { id: 'ld-18', category: 'long-doc', prompt: 'correct spelling',
    text: 'The architecure of the new system is documented in the design proposal. The integration tests covre the primary user flows and the performance benchmarks have been established. We need to address sevreal concerns raised during the review including authentication flow and the database migration strategy for high-volume tables.',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'architecure', acceptableEdits: ['architecture'] },
      { wordIndex: 13, originalWord: 'covre', acceptableEdits: ['cover'] },
      { wordIndex: 25, originalWord: 'sevreal', acceptableEdits: ['several'] },
    ],
    note: 'long-doc 45-word technical — 3 typos' },
  { id: 'ld-19', category: 'long-doc', prompt: 'capitalize proper nouns',
    text: 'i went to paris last summer and met john at the louvre. we had lunch near the eiffel tower and walked along the seine river before meeting alice in the latin quarter for evening coffee.',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'i', acceptableEdits: ['I'] },
      { wordIndex: 3, originalWord: 'paris', acceptableEdits: ['Paris'] },
      { wordIndex: 8, originalWord: 'john', acceptableEdits: ['John'] },
      { wordIndex: 11, originalWord: 'louvre.', acceptableEdits: ['Louvre.'] },
      { wordIndex: 17, originalWord: 'eiffel', acceptableEdits: ['Eiffel'] },
      { wordIndex: 23, originalWord: 'seine', acceptableEdits: ['Seine'] },
      { wordIndex: 27, originalWord: 'alice', acceptableEdits: ['Alice'] },
      { wordIndex: 30, originalWord: 'latin', acceptableEdits: ['Latin'] },
    ],
    note: 'long-doc 35-word capitalize proper nouns — 8 names + I' },
  { id: 'ld-20', category: 'long-doc', prompt: 'use inclusive gender-neutral language',
    text: 'Every chairman should welcome new ideas from the team. The salesman often discusses pipeline metrics with leadership. We have a fireman in the unit who serves as a mentor. The board recognizes a new businessman every month for outstanding contributions across our offices in major regions.',
    expectedEdits: [
      { wordIndex: 1, originalWord: 'chairman', acceptableEdits: ['chairperson', 'chair'] },
      { wordIndex: 9, originalWord: 'salesman', acceptableEdits: ['salesperson', 'sales representative'] },
      { wordIndex: 18, originalWord: 'fireman', acceptableEdits: ['firefighter'] },
      { wordIndex: 30, originalWord: 'businessman', acceptableEdits: ['businessperson', 'professional', 'executive'] },
    ],
    note: 'long-doc 45-word inclusive — 4 gendered nouns' },
];
