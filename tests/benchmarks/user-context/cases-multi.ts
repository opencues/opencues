/**
 * Multi-sentinel cases — stress-test how far rewrite/compose can be
 * pushed before fidelity collapses. The standard `cases.ts` tops out
 * at 3 sentinels per output; this file goes up to 8+.
 *
 * Each case declares which sentinels MUST appear (strict). The grader
 * also records HOW MANY of the expected sentinels appeared so we can
 * see the "model emits the first N then stops" failure mode the v1
 * bench surfaced.
 */

import type { UserContextCase } from './cases';

export const MULTI_CASES: UserContextCase[] = [
  // ─── 3 sentinels ──────────────────────────────────────────────────────
  { id: 'multi3-signature', pipeline: 'rewrite',
    input: 'write a 3-line email signature with name title and company on separate lines _',
    expectedTokenSets: [
      ['[FULL NAME]', '[FIRST NAME]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
    ],
    forbidRawValues: true },

  // ─── 4 sentinels ──────────────────────────────────────────────────────
  { id: 'multi4-business-card', pipeline: 'compose',
    input: 'write a digital business card — name, job title, company, email — newlines between _',
    expectedTokenSets: [
      ['[FULL NAME]', '[FIRST NAME]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
      ['[EMAIL]'],
    ],
    forbidRawValues: true },

  { id: 'multi4-social-links', pipeline: 'compose',
    input: 'list links: github, linkedin, twitter, personal website — one per line _',
    expectedTokenSets: [
      ['[GITHUB]'],
      ['[LINKEDIN]'],
      ['[TWITTER]'],
      ['[WEBSITE]'],
    ],
    forbidRawValues: true },

  // ─── 5 sentinels ──────────────────────────────────────────────────────
  { id: 'multi5-full-signature', pipeline: 'rewrite',
    input: 'write a full email signature: name, job title, company, email, phone — newline separated _',
    expectedTokenSets: [
      ['[FULL NAME]', '[FIRST NAME]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
      ['[EMAIL]'],
      ['[PHONE]'],
    ],
    forbidRawValues: true },

  { id: 'multi5-conference-badge', pipeline: 'compose',
    input: 'conference badge text: name, pronouns, job title, company, city — one per line _',
    expectedTokenSets: [
      ['[FULL NAME]', '[FIRST NAME]'],
      ['[PRONOUNS]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
      ['[WORK CITY]', '[HOME CITY]'],
    ],
    forbidRawValues: true },

  // ─── 6 sentinels ──────────────────────────────────────────────────────
  { id: 'multi6-detailed-bio', pipeline: 'compose',
    input: 'write a 6-bullet detailed bio covering: name, pronouns, job title, employer, work city, country — bullet per line _',
    expectedTokenSets: [
      ['[FULL NAME]', '[FIRST NAME]'],
      ['[PRONOUNS]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
      ['[WORK CITY]'],
      ['[HOME COUNTRY]'],
    ],
    forbidRawValues: true },

  { id: 'multi6-mailing-list-signup', pipeline: 'compose',
    input: 'fill a mailing-list signup: full name, email, phone, city, country, postcode — labelled lines _',
    expectedTokenSets: [
      ['[FULL NAME]'],
      ['[EMAIL]'],
      ['[PHONE]'],
      ['[HOME CITY]', '[WORK CITY]'],
      ['[HOME COUNTRY]'],
      ['[HOME POSTCODE]'],
    ],
    forbidRawValues: true },

  // ─── 7 sentinels ──────────────────────────────────────────────────────
  { id: 'multi7-vcard', pipeline: 'compose',
    input: 'write a vCard-style block with: full name, pronouns, job title, company, email, phone, website — one per line, label each _',
    expectedTokenSets: [
      ['[FULL NAME]'],
      ['[PRONOUNS]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
      ['[EMAIL]'],
      ['[PHONE]'],
      ['[WEBSITE]'],
    ],
    forbidRawValues: true },

  // ─── 8 sentinels — pushing the upper bound ────────────────────────────
  { id: 'multi8-application-form', pipeline: 'compose',
    input: 'fill an application form: full name, pronouns, email, phone, job title, company, work city, country — labelled lines _',
    expectedTokenSets: [
      ['[FULL NAME]'],
      ['[PRONOUNS]'],
      ['[EMAIL]'],
      ['[PHONE]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
      ['[WORK CITY]'],
      ['[HOME COUNTRY]'],
    ],
    forbidRawValues: true },

  // ─── ALL 16 sentinels — the absolute ceiling ──────────────────────────
  { id: 'multi16-full-profile', pipeline: 'compose',
    input: 'fill out a complete profile with every field i have: first name, last name, full name, email, phone, pronouns, job title, company, work city, home city, home country, home postcode, github, linkedin, twitter, website — labelled lines, one per line _',
    expectedTokenSets: [
      ['[FIRST NAME]'],
      ['[LAST NAME]'],
      ['[FULL NAME]'],
      ['[EMAIL]'],
      ['[PHONE]'],
      ['[PRONOUNS]'],
      ['[JOB TITLE]'],
      ['[COMPANY]'],
      ['[WORK CITY]'],
      ['[HOME CITY]'],
      ['[HOME COUNTRY]'],
      ['[HOME POSTCODE]'],
      ['[GITHUB]'],
      ['[LINKEDIN]'],
      ['[TWITTER]'],
      ['[WEBSITE]'],
    ],
    forbidRawValues: true },
];
