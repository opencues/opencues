/**
 * Cases for the sentence-cues `more-formal` classifier bench.
 *
 * Each case is a buffer (one or more sentences) and the expectation
 * for each sentence: should the cue produce a MORE_FORMAL rewrite, or
 * should it cede (SAME / no-op)?
 *
 * Six buckets:
 *
 *  - clean-informal       — colloquial source; clear formal-up is possible
 *  - fuzzy-informal       — mildly casual; subtle formality lift expected
 *  - already-formal       — input is already formal; cue should ideally
 *                           emit "no useful rewrite" verdict (SAME)
 *  - multi-sentence       — buffers with ≥2 sentences; each indexed
 *                           independently
 *  - edge-short           — one-word "sentences" / fragments; should
 *                           cede gracefully
 *  - edge-technical       — code-shaped text / commands; cede (not prose)
 *
 * Each hit case lists a non-exhaustive set of acceptable formal
 * rewrites (`acceptableAlts`). The judge will accept any output that
 * matches one of them OR independently scores MORE_FORMAL on the LLM
 * judge (so we don't over-penalise creative-but-valid rewrites).
 */

export interface SentenceExpectation {
  /** The sentence as it appears in the buffer, including trailing punctuation. */
  originalSentence: string;
  /**
   * Verdict the judge should produce on the cue's output for this sentence.
   *  - MORE_FORMAL: cue should produce ≥1 alt that reads as more formal.
   *  - SAME: input is already formal / no useful rewrite expected; cue
   *    should emit the original or an equivalent-formality alt.
   *  - CEDE: cue should not produce any alt for this sentence
   *    (fragment, code, etc.).
   */
  expect: 'MORE_FORMAL' | 'SAME' | 'CEDE';
  /**
   * Non-exhaustive examples of acceptable formal rewrites. The judge
   * uses these as fast-path matches; novel rewrites are then scored
   * by the LLM judge. Optional for SAME/CEDE buckets.
   */
  acceptableAlts?: string[];
}

export interface SentenceCueCase {
  id: string;
  category: 'clean-informal' | 'fuzzy-informal' | 'already-formal' | 'multi-sentence' | 'edge-short' | 'edge-technical';
  /** Full buffer text — what the user has typed so far. */
  input: string;
  /** Per-sentence expectations, indexed left-to-right in the buffer. */
  expectations: SentenceExpectation[];
}

export const CASES: SentenceCueCase[] = [
  // ── CLEAN INFORMAL — colloquial source, formal-up clearly possible ──

  {
    id: 'ci-thanks',
    category: 'clean-informal',
    input: 'thanks a bunch for the help.',
    expectations: [
      {
        originalSentence: 'thanks a bunch for the help.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'Thank you very much for your assistance.',
          'I am grateful for your help.',
          'Many thanks for your assistance.',
        ],
      },
    ],
  },
  {
    id: 'ci-gonna',
    category: 'clean-informal',
    input: "I'm gonna look into that tomorrow.",
    expectations: [
      {
        originalSentence: "I'm gonna look into that tomorrow.",
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'I will look into that tomorrow.',
          'I will investigate that tomorrow.',
          'I will examine that matter tomorrow.',
        ],
      },
    ],
  },
  {
    id: 'ci-wanna',
    category: 'clean-informal',
    input: 'I wanna talk about the budget.',
    expectations: [
      {
        originalSentence: 'I wanna talk about the budget.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'I would like to discuss the budget.',
          'I wish to discuss the budget.',
        ],
      },
    ],
  },
  {
    id: 'ci-stuff',
    category: 'clean-informal',
    input: 'we got a bunch of stuff to do.',
    expectations: [
      {
        originalSentence: 'we got a bunch of stuff to do.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'We have a number of tasks to complete.',
          'We have many tasks to address.',
        ],
      },
    ],
  },
  {
    id: 'ci-kinda',
    category: 'clean-informal',
    input: "this proposal is kinda weak.",
    expectations: [
      {
        originalSentence: 'this proposal is kinda weak.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'This proposal is somewhat weak.',
          'This proposal lacks rigour.',
          'This proposal is rather weak.',
        ],
      },
    ],
  },
  {
    id: 'ci-cant-wait',
    category: 'clean-informal',
    input: "can't wait to hear back from you.",
    expectations: [
      {
        originalSentence: "can't wait to hear back from you.",
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'I look forward to your reply.',
          'I look forward to hearing from you.',
        ],
      },
    ],
  },
  {
    id: 'ci-yeah',
    category: 'clean-informal',
    input: "yeah that works for me.",
    expectations: [
      {
        originalSentence: 'yeah that works for me.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'Yes, that works for me.',
          'That is acceptable.',
          'That arrangement suits me.',
        ],
      },
    ],
  },
  {
    id: 'ci-pretty-much',
    category: 'clean-informal',
    input: "pretty much everyone agreed.",
    expectations: [
      {
        originalSentence: 'pretty much everyone agreed.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'Nearly everyone agreed.',
          'Almost all participants agreed.',
        ],
      },
    ],
  },
  {
    id: 'ci-no-biggie',
    category: 'clean-informal',
    input: "no biggie if you're late.",
    expectations: [
      {
        originalSentence: "no biggie if you're late.",
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'It is not an issue if you are late.',
          'A late arrival is acceptable.',
        ],
      },
    ],
  },
  {
    id: 'ci-fyi',
    category: 'clean-informal',
    input: 'fyi the deadline moved.',
    expectations: [
      {
        originalSentence: 'fyi the deadline moved.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'For your information, the deadline has been moved.',
          'Please note that the deadline has changed.',
        ],
      },
    ],
  },

  // ── FUZZY INFORMAL — subtle casualness; formal lift expected ────────

  {
    id: 'fi-need-to-talk',
    category: 'fuzzy-informal',
    input: 'we need to talk about the proposal.',
    expectations: [
      {
        originalSentence: 'we need to talk about the proposal.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'We should discuss the proposal.',
          'A discussion regarding the proposal is required.',
        ],
      },
    ],
  },
  {
    id: 'fi-help-with',
    category: 'fuzzy-informal',
    input: 'I could use some help with this part.',
    expectations: [
      {
        originalSentence: 'I could use some help with this part.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'I would appreciate assistance with this section.',
          'Some assistance with this section would be welcome.',
        ],
      },
    ],
  },
  {
    id: 'fi-let-me-know',
    category: 'fuzzy-informal',
    input: 'let me know what you think.',
    expectations: [
      {
        originalSentence: 'let me know what you think.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'Please share your thoughts.',
          'I welcome your feedback.',
          'Your opinion would be appreciated.',
        ],
      },
    ],
  },
  {
    id: 'fi-touch-base',
    category: 'fuzzy-informal',
    input: "let's touch base on Friday.",
    expectations: [
      {
        originalSentence: "let's touch base on Friday.",
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'Let us reconnect on Friday.',
          'We can confer on Friday.',
        ],
      },
    ],
  },
  {
    id: 'fi-circle-back',
    category: 'fuzzy-informal',
    input: "I'll circle back next week.",
    expectations: [
      {
        originalSentence: "I'll circle back next week.",
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'I will follow up next week.',
          'I will revisit this matter next week.',
        ],
      },
    ],
  },
  {
    id: 'fi-ping-me',
    category: 'fuzzy-informal',
    input: 'ping me when ready.',
    expectations: [
      {
        originalSentence: 'ping me when ready.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'Please notify me when ready.',
          'Kindly contact me when ready.',
        ],
      },
    ],
  },
  {
    id: 'fi-on-my-plate',
    category: 'fuzzy-informal',
    input: "got a lot on my plate this week.",
    expectations: [
      {
        originalSentence: 'got a lot on my plate this week.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'My workload is heavy this week.',
          'I have many commitments this week.',
        ],
      },
    ],
  },

  // ── ALREADY FORMAL — should cede or output equivalent-formality alts ─

  {
    id: 'af-respectfully',
    category: 'already-formal',
    input: 'I respectfully request your review of the attached document.',
    expectations: [
      {
        originalSentence: 'I respectfully request your review of the attached document.',
        expect: 'SAME',
      },
    ],
  },
  {
    id: 'af-pursuant',
    category: 'already-formal',
    input: 'Pursuant to our agreement, the deliverables are enclosed.',
    expectations: [
      {
        originalSentence: 'Pursuant to our agreement, the deliverables are enclosed.',
        expect: 'SAME',
      },
    ],
  },
  {
    id: 'af-yours-sincerely',
    category: 'already-formal',
    input: 'Yours sincerely, James.',
    expectations: [
      {
        originalSentence: 'Yours sincerely, James.',
        expect: 'SAME',
      },
    ],
  },
  {
    id: 'af-board',
    category: 'already-formal',
    input: 'The board has approved the proposal unanimously.',
    expectations: [
      {
        originalSentence: 'The board has approved the proposal unanimously.',
        expect: 'SAME',
      },
    ],
  },

  // ── MULTI-SENTENCE — buffers with several sentences, each indexed ──

  {
    id: 'ms-thanks-deadline',
    category: 'multi-sentence',
    input: 'thanks a bunch for the help. fyi the deadline moved.',
    expectations: [
      {
        originalSentence: 'thanks a bunch for the help.',
        expect: 'MORE_FORMAL',
        acceptableAlts: ['Thank you very much for your assistance.'],
      },
      {
        originalSentence: 'fyi the deadline moved.',
        expect: 'MORE_FORMAL',
        acceptableAlts: ['For your information, the deadline has been moved.'],
      },
    ],
  },
  {
    id: 'ms-mixed',
    category: 'multi-sentence',
    input: 'gonna head out early today. The presentation went well.',
    expectations: [
      {
        originalSentence: 'gonna head out early today.',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'I will be leaving early today.',
          'I plan to leave early today.',
        ],
      },
      {
        originalSentence: 'The presentation went well.',
        expect: 'SAME',
      },
    ],
  },
  {
    id: 'ms-three',
    category: 'multi-sentence',
    input: "let me know what you think. I'll wait for your reply. cheers!",
    expectations: [
      {
        originalSentence: 'let me know what you think.',
        expect: 'MORE_FORMAL',
        acceptableAlts: ['Please share your thoughts.'],
      },
      {
        originalSentence: "I'll wait for your reply.",
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'I will await your reply.',
          'I look forward to your response.',
        ],
      },
      {
        originalSentence: 'cheers!',
        expect: 'MORE_FORMAL',
        acceptableAlts: [
          'Best regards.',
          'Kind regards.',
        ],
      },
    ],
  },

  // ── EDGE: SHORT — fragments / one-word "sentences" — cede ────────────

  {
    id: 'es-ok',
    category: 'edge-short',
    input: 'ok.',
    expectations: [
      { originalSentence: 'ok.', expect: 'CEDE' },
    ],
  },
  {
    id: 'es-hi',
    category: 'edge-short',
    input: 'hi.',
    expectations: [
      { originalSentence: 'hi.', expect: 'CEDE' },
    ],
  },
  {
    id: 'es-yes',
    category: 'edge-short',
    input: 'yes.',
    expectations: [
      { originalSentence: 'yes.', expect: 'CEDE' },
    ],
  },

  // ── EDGE: TECHNICAL — code, commands, identifiers — cede ────────────

  {
    id: 'et-code',
    category: 'edge-technical',
    input: 'const x = 42;',
    expectations: [
      { originalSentence: 'const x = 42;', expect: 'CEDE' },
    ],
  },
  {
    id: 'et-cmd',
    category: 'edge-technical',
    input: 'npm install --save-dev typescript.',
    expectations: [
      { originalSentence: 'npm install --save-dev typescript.', expect: 'CEDE' },
    ],
  },
  {
    id: 'et-url',
    category: 'edge-technical',
    input: 'see https://example.com/docs.',
    expectations: [
      { originalSentence: 'see https://example.com/docs.', expect: 'CEDE' },
    ],
  },
];
