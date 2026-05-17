/**
 * Test cases for sentinel-mode user context.
 *
 * Each case has a `pipeline` field marking which production surface it
 * would target so we can see if hardness clusters by pipeline:
 *
 *   - 'lookup'    — fluid-blank style. User types a short query + `_`.
 *                   Expect the LLM to emit ONE sentinel.
 *   - 'rewrite'   — transform-blank style. User asks for a rewrite of
 *                   a chunk of text. Expect ONE OR MORE sentinels in
 *                   the rewrite output.
 *   - 'compose'   — generative. User asks for content created from
 *                   scratch. Expect MULTIPLE sentinels.
 *   - 'anti'      — the model should NOT emit any sentinel. The
 *                   question is answerable without user data, or asks
 *                   about a field NOT in the catalog (hallucination
 *                   probe).
 *
 * The grader inspects:
 *   - `expectedTokens` — sentinels that MUST appear in the output
 *   - `forbiddenTokens` — sentinels that must NOT appear
 *   - `forbidAnySentinel` — anti-cases assert nothing in TOKEN_SET appears
 *   - `forbidRawValues` — raw-leak detection (catalog values appearing
 *                         in output even though tokens were on offer)
 */

export type Pipeline = 'lookup' | 'rewrite' | 'compose' | 'anti';

export interface UserContextCase {
  id: string;
  pipeline: Pipeline;
  /** What the user typed (the `_` is the blank). */
  input: string;
  /** Sentinels we expect the LLM to emit in its answer (strict — each
   *  listed token must appear verbatim). Use for unambiguous lookups. */
  expectedTokens?: string[];
  /** Slot-style expectation: each subarray is one "required slot" and
   *  at least one of the alternatives must appear. Use for rewrite/
   *  compose cases where multiple catalog tokens are semantically
   *  equivalent (e.g. [[FIRST NAME] OR [FULL NAME]] for "name" prompts). */
  expectedTokenSets?: string[][];
  /** Sentinels we expect the LLM to NOT emit. */
  forbiddenTokens?: string[];
  /** When true: NO sentinel at all should appear in output. */
  forbidAnySentinel?: boolean;
  /** When true: scan output for the raw VALUES of all catalog entries
   *  — any hit is a leak (LLM resolved the sentinel itself instead
   *  of emitting it verbatim). */
  forbidRawValues?: boolean;
  /** When true: case-fidelity matters strictly. Catches `[First Name]`
   *  vs `[FIRST NAME]` regressions. Default true. */
  strictCase?: boolean;
}

export const CASES: UserContextCase[] = [
  // ─── 'lookup' — fluid-blank style — single sentinel expected ──────────────

  { id: 'lookup-first-name', pipeline: 'lookup',
    input: 'my first name _',
    expectedTokens: ['[FIRST NAME]'], forbidRawValues: true },

  { id: 'lookup-email', pipeline: 'lookup',
    input: 'my email _',
    expectedTokens: ['[EMAIL]'], forbidRawValues: true },

  { id: 'lookup-email-on-form', pipeline: 'lookup',
    input: 'contact email _',
    expectedTokens: ['[EMAIL]'], forbidRawValues: true },

  { id: 'lookup-phone', pipeline: 'lookup',
    input: 'my phone number _',
    expectedTokens: ['[PHONE]'], forbidRawValues: true },

  { id: 'lookup-github', pipeline: 'lookup',
    input: 'my github _',
    expectedTokens: ['[GITHUB]'], forbidRawValues: true },

  { id: 'lookup-linkedin', pipeline: 'lookup',
    input: 'linkedin url _',
    expectedTokens: ['[LINKEDIN]'], forbidRawValues: true },

  { id: 'lookup-twitter', pipeline: 'lookup',
    input: 'twitter handle _',
    expectedTokens: ['[TWITTER]'], forbidRawValues: true },

  { id: 'lookup-website', pipeline: 'lookup',
    input: 'my website _',
    expectedTokens: ['[WEBSITE]'], forbidRawValues: true },

  { id: 'lookup-job-title', pipeline: 'lookup',
    input: 'my job title _',
    expectedTokens: ['[JOB TITLE]'], forbidRawValues: true },

  { id: 'lookup-company', pipeline: 'lookup',
    input: 'i work at _',
    expectedTokens: ['[COMPANY]'], forbidRawValues: true },

  { id: 'lookup-work-city', pipeline: 'lookup',
    input: 'i work in _',
    expectedTokens: ['[WORK CITY]'], forbidRawValues: true },

  { id: 'lookup-home-city', pipeline: 'lookup',
    input: 'i live in _',
    expectedTokens: ['[HOME CITY]'], forbidRawValues: true },

  { id: 'lookup-home-country', pipeline: 'lookup',
    input: 'i live in country _',
    expectedTokens: ['[HOME COUNTRY]'], forbidRawValues: true },

  { id: 'lookup-postcode', pipeline: 'lookup',
    input: 'my postcode _',
    expectedTokens: ['[HOME POSTCODE]'], forbidRawValues: true },

  { id: 'lookup-pronouns', pipeline: 'lookup',
    input: 'my pronouns _',
    expectedTokens: ['[PRONOUNS]'], forbidRawValues: true },

  { id: 'lookup-full-name', pipeline: 'lookup',
    input: 'my full name _',
    expectedTokens: ['[FULL NAME]'], forbidRawValues: true },

  // ─── 'lookup' — indirect / inference — sentinel still required ────────────

  { id: 'lookup-indirect-contact', pipeline: 'lookup',
    input: 'best way to reach me by email _',
    expectedTokens: ['[EMAIL]'], forbidRawValues: true },

  { id: 'lookup-indirect-employer', pipeline: 'lookup',
    input: 'my current employer is _',
    expectedTokens: ['[COMPANY]'], forbidRawValues: true },

  // ─── 'rewrite' — transform-blank style — sentinels in larger output ───────
  // These use expectedTokenSets — each subarray = one required slot,
  // any one of the alternates passes. "name" is intentionally ambiguous
  // between [FIRST NAME] and [FULL NAME].

  { id: 'rewrite-email-signature', pipeline: 'rewrite',
    input: 'write a brief email signature _',
    expectedTokenSets: [
      ['[FULL NAME]', '[FIRST NAME]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
    ],
    forbidRawValues: true },

  { id: 'rewrite-intro-line', pipeline: 'rewrite',
    input: 'write a one-line professional intro _',
    expectedTokenSets: [
      ['[FIRST NAME]', '[FULL NAME]'],
      ['[JOB TITLE]'],
    ],
    forbidRawValues: true },

  { id: 'rewrite-contact-block', pipeline: 'rewrite',
    input: 'write a contact block with name email and phone _',
    expectedTokenSets: [
      ['[FULL NAME]', '[FIRST NAME]'],
      ['[EMAIL]'],
      ['[PHONE]'],
    ],
    forbidRawValues: true },

  { id: 'rewrite-greeting-name', pipeline: 'rewrite',
    input: 'write a friendly greeting using my name _',
    expectedTokenSets: [
      ['[FIRST NAME]', '[FULL NAME]'],
    ],
    forbidRawValues: true },

  // ─── 'compose' — multiple sentinels in one output ─────────────────────────

  { id: 'compose-bio-line', pipeline: 'compose',
    input: 'write a one-sentence bio with name job and city _',
    expectedTokenSets: [
      ['[FIRST NAME]', '[FULL NAME]'],
      ['[JOB TITLE]'],
      ['[WORK CITY]', '[HOME CITY]'],
    ],
    forbidRawValues: true },

  { id: 'compose-social-links', pipeline: 'compose',
    input: 'list my github linkedin and twitter on separate lines _',
    expectedTokenSets: [
      ['[GITHUB]'],
      ['[LINKEDIN]'],
      ['[TWITTER]'],
    ],
    forbidRawValues: true },

  { id: 'compose-event-rsvp', pipeline: 'compose',
    input: 'write an event rsvp with my name email and pronouns _',
    expectedTokenSets: [
      ['[FIRST NAME]', '[FULL NAME]'],
      ['[EMAIL]'],
      ['[PRONOUNS]'],
    ],
    forbidRawValues: true },

  // ─── 'anti' — no user data needed; LLM must NOT invent sentinels ──────────

  { id: 'anti-factual', pipeline: 'anti',
    input: 'capital of france _',
    forbidAnySentinel: true },

  { id: 'anti-arithmetic', pipeline: 'anti',
    input: '12 times 7 _',
    forbidAnySentinel: true },

  { id: 'anti-codepoint', pipeline: 'anti',
    input: 'unicode for em dash _',
    forbidAnySentinel: true },

  // ─── 'anti' — fields NOT in the catalog. Hallucination probe ──────────────
  // The LLM must NOT invent [DATE OF BIRTH] / [NICKNAME] / [SSN] etc.
  // Using a LISTED sentinel as a fallback (e.g. [FIRST NAME] for a
  // nickname prompt) is acceptable — the post-processor will resolve
  // it to a real value the user can edit. Inventing an unlisted token
  // is the hard fail: the post-processor would leak the literal
  // [DATE OF BIRTH] string into the user's buffer.
  //
  // These cases set `forbidAnySentinel: false` implicitly; the grader's
  // standalone hallucination check (any [TOKEN] not in TOKEN_SET) is
  // what enforces the property.

  { id: 'anti-hallucinate-dob', pipeline: 'anti',
    input: 'my date of birth _' },

  { id: 'anti-hallucinate-ssn', pipeline: 'anti',
    input: 'my social security number _' },

  { id: 'anti-hallucinate-nickname', pipeline: 'anti',
    input: 'my nickname _' },

  { id: 'anti-hallucinate-blood-type', pipeline: 'anti',
    input: 'my blood type _' },
];
