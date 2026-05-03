/**
 * Agent-task benchmark cases.
 *
 * Each case is a CASE — a starting state + a list of ASSERTIONS the
 * agent should produce when runOnce(text) is called against the
 * configured task prompt.
 *
 * Unlike the transform-blank benchmark (which simulates a one-shot
 * substitution), the agent-task benchmark exercises the loop's
 * candidate-selection + edit-pass + DynDef-application flow against
 * realistic typed-text scenarios.
 *
 * Categories — 10+ cases each:
 *   spelling-task         Inject typos; assert agent fixes them
 *   no-op-recall          No edit needed; LLM returns empty edits
 *   cursor-adjacent       Cursor-adjacent word never gets edited
 *   ownership-respect    Agent skips words claimed by other DynDefs
 *   task-id-invalidation  Modify task → re-evaluate even unchanged text
 */

export interface AgentTaskCase {
  id: string;
  category: 'spelling-task' | 'no-op-recall' | 'cursor-adjacent' | 'ownership-respect' | 'task-id-invalidation' | 'humour-task' | 'caps-task' | 'mixed-task';
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
  // SPELLING-TASK — inject typos, assert agent corrects them
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
    text: 'thier proposal was wel-recieved',
    expectedEdits: [
      { wordIndex: 0, originalWord: 'thier', acceptableEdits: ['their'] },
      { wordIndex: 3, originalWord: 'wel-recieved', acceptableEdits: ['well-received'] },
    ],
  },

  // ============================================================
  // CURSOR-ADJACENT — never edit the word the cursor is on/in
  // ============================================================
  {
    id: 'cur-1',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'I have somm typos and tommorow',
    cursorPos: 30,  // end of "tommorow"
    expectedEdits: [
      { wordIndex: 2, originalWord: 'somm', acceptableEdits: ['some'] },
      // wordIndex 4 (tommorow) MUST NOT be edited — cursor is on it
    ],
    forbiddenIndices: [4],
  },
  {
    id: 'cur-2',
    category: 'cursor-adjacent',
    prompt: 'correct spelling',
    text: 'I rite some text',
    cursorPos: 6,  // end of "rite"
    expectedEdits: [],  // wordIndex 1 ("rite") is cursor-adjacent → skip
    forbiddenIndices: [1],
  },

  // ============================================================
  // NO-OP — text doesn't need editing under the prompt
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

  // ============================================================
  // OWNERSHIP-RESPECT — words owned by other DynDefs are off-limits
  // ============================================================
  {
    id: 'own-1',
    category: 'ownership-respect',
    prompt: 'correct spelling',
    text: 'I have somm typos and tommorow',
    ownedIndices: [4],  // tommorow is "owned" by some other source
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
    ownedIndices: [0],  // "definately" is owned — agent should skip
    expectedEdits: [
      { wordIndex: 2, originalWord: 'recieved', acceptableEdits: ['received'] },
    ],
    forbiddenIndices: [0],
    note: 'index 0 owned; agent must not touch even though it\'s misspelled',
  },

  // ============================================================
  // TASK-ID-INVALIDATION — already-evaluated indices skipped on
  // SAME taskId, but a new taskId re-evaluates everything
  // ============================================================
  {
    id: 'cache-1',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'I have somm typos here',
    alreadyEvaluatedIndices: [2],  // "somm" already-evaluated → skip
    expectedEdits: [],
    forbiddenIndices: [2],
    note: 'cache hit on "somm" — agent must NOT re-evaluate',
  },
  {
    id: 'cache-2',
    category: 'task-id-invalidation',
    prompt: 'correct spelling',
    text: 'I have somm typos and tommorow here',
    alreadyEvaluatedIndices: [2],  // somm already-evaluated; tommorow at idx 5 isn't
    expectedEdits: [
      { wordIndex: 5, originalWord: 'tommorow', acceptableEdits: ['tomorrow'] },
    ],
    forbiddenIndices: [2],
  },

  // ============================================================
  // CAPS-TASK — case-shift-only tasks. Tests semantic interpretation.
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
    note: 'narrowed prompt — "i" and "june" deliberately excluded',
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
    note: 'should only cap the names, not "i" or "cafe"',
  },
];
