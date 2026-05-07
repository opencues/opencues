/**
 * Test cases for the agent-rewrite benchmark.
 *
 * Each case is a (doc, task, expected) triple. The runner sends `doc`
 * + `task` to the LLM via the same REWRITE prompt the runtime uses,
 * applies the three-way merge against `doc` (no user typing during
 * call), and checks whether the merged result `passes` the
 * expectation.
 *
 * Expectations come in three shapes:
 *   `equals`        — merged text must be exactly this string
 *   `contains`      — merged text must contain ALL of these substrings
 *   `notContains`   — merged text must contain NONE of these substrings
 * (cases can mix `contains` + `notContains`).
 */

export interface BenchCase {
  readonly id: string;
  readonly category: string;
  readonly task: string;
  readonly doc: string;
  readonly expected: {
    readonly equals?: string;
    readonly contains?: readonly string[];
    readonly notContains?: readonly string[];
  };
}

export const CASES: readonly BenchCase[] = [
  // ─── Spelling (mechanical) ─────────────────────────────────────────
  {
    id: 'sp-1', category: 'spelling',
    task: 'correct spelling',
    doc: 'I rite some text.',
    expected: { equals: 'I write some text.' },
  },
  {
    id: 'sp-2', category: 'spelling',
    task: 'correct spelling',
    doc: 'thier proposal was carefuly recieved.',
    expected: { contains: ['their', 'carefully', 'received'] },
  },
  {
    id: 'sp-3', category: 'spelling',
    task: 'correct spelling',
    doc: 'The team made significnt progress on the new platfrom.',
    expected: { contains: ['significant', 'platform'] },
  },
  {
    id: 'sp-4', category: 'spelling',
    task: 'correct spelling',
    doc: 'No typos here. Everything is correct.',
    expected: { equals: 'No typos here. Everything is correct.' },
  },

  // ─── Capitalisation ─────────────────────────────────────────────────
  {
    id: 'cap-1', category: 'capitalisation',
    task: 'capitalise sentence starts and proper nouns',
    doc: 'i went to london on monday with john.',
    expected: { contains: ['London', 'Monday', 'John'] },
  },
  {
    id: 'cap-2', category: 'capitalisation',
    task: 'fix capitalisation',
    doc: 'hello there. how are you doing today?',
    expected: { contains: ['Hello', 'How'] },
  },

  // ─── Translation (non-idempotent) ───────────────────────────────────
  {
    id: 'tr-1', category: 'translation',
    task: 'translate to spanish',
    doc: 'Monday Tuesday Wednesday',
    expected: { contains: ['lunes', 'martes'] },
  },
  {
    id: 'tr-2', category: 'translation',
    task: 'translate to french',
    doc: 'I want a cup of coffee.',
    expected: { contains: ['café'], notContains: ['coffee'] },
  },

  // ─── Grammar / range edits ──────────────────────────────────────────
  {
    id: 'gr-1', category: 'grammar',
    task: 'fix grammar',
    doc: 'I went to the the store yesterday.',
    expected: { equals: 'I went to the store yesterday.' },
  },
  {
    id: 'gr-2', category: 'grammar',
    task: 'fix grammar',
    doc: 'we went any way we could.',
    expected: { contains: ['anyway'] },
  },
  {
    id: 'gr-3', category: 'grammar',
    task: 'fix grammar',
    doc: 'I went store yesterday.',
    expected: { contains: ['went to', 'store'] },
  },

  // ─── Paragraph structure preservation ───────────────────────────────
  {
    id: 'ps-1', category: 'paragraph-structure',
    task: 'correct spelling',
    doc: 'first para has typoo.\n\nsecond para is fine.',
    expected: {
      contains: ['typo.', '\n\n'],
      notContains: ['typoo'],
    },
  },
  {
    id: 'ps-2', category: 'paragraph-structure',
    task: 'fix grammar and spelling',
    doc: 'Hi boi.\n\nI rite stuff here.\n\nWhat next?',
    expected: { contains: ['Hi boy', 'write stuff', '\n\n'] },
  },

  // ─── Idempotency ────────────────────────────────────────────────────
  {
    id: 'id-1', category: 'idempotent',
    task: 'correct spelling',
    doc: 'This sentence is already perfect.',
    expected: { equals: 'This sentence is already perfect.' },
  },
  {
    id: 'id-2', category: 'idempotent',
    task: 'fix grammar',
    doc: 'I went to the store yesterday.',
    expected: { equals: 'I went to the store yesterday.' },
  },

  // ─── Style / domain prompts (looser expectations — model judgement) ─
  {
    id: 'st-1', category: 'style-formal',
    task: 'make formal',
    doc: 'hey whats up?',
    expected: {
      contains: ['Hello'],
      notContains: ['whats'],
    },
  },
  {
    id: 'st-2', category: 'style-british',
    task: 'use british english spelling',
    doc: 'I love the color of this organization.',
    expected: { contains: ['colour', 'organisation'] },
  },

  // ─── Long doc — no truncation ───────────────────────────────────────
  {
    id: 'lng-1', category: 'long-doc',
    task: 'correct spelling',
    doc: [
      'The team worked on the itteration and made significnt progress',
      'over two weeks on the new platform launching next month.',
      '',
      'Everyone on the team and our customrs were definately impressed',
      'by the speed of delivery and the quality of work.',
    ].join('\n'),
    expected: {
      contains: ['iteration', 'significant', 'customers', 'definitely'],
      notContains: ['itteration', 'customrs'],
    },
  },
];
