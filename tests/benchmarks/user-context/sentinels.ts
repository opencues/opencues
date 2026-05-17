/**
 * The 16 sentinel tokens the benchmark exercises.
 *
 * Each sentinel has:
 *   - `token`     : how the LLM should emit it (case-sensitive target)
 *   - `description`: the catalog hint the LLM sees in the system prompt
 *   - `value`     : the "real" value the post-processor would substitute
 *                    (kept here so the bench can sanity-check that no
 *                    raw value leaked into the LLM output when sentinel
 *                    mode is supposed to be active)
 *
 * Field set chosen to cover the realistic surface a user might put in
 * `~/.cues/User.md`: identity (name/pronouns/title), contact (email/
 * phone), location (city/country/postcode), online presence (github/
 * linkedin/twitter/website), employer (company/job title), plus one
 * "fun" field (favourite colour) as a low-stakes default-on test.
 *
 * 16 is enough to surface "the LLM only remembers the first 8" or
 * "uppercase tokens with hyphens get mangled" effects.
 */

export interface Sentinel {
  /** Verbatim token the LLM should emit. */
  token: string;
  /** Catalog description shown to the LLM in the system prompt. */
  description: string;
  /** Synthetic plausible value for substitution + raw-leak detection. */
  value: string;
}

export const SENTINELS: Sentinel[] = [
  { token: '[FIRST NAME]',    description: "user's first name",                    value: 'Wilfred' },
  { token: '[LAST NAME]',     description: "user's last name",                     value: 'Kasekende' },
  { token: '[FULL NAME]',     description: "user's first + last name combined",    value: 'Wilfred Kasekende' },
  { token: '[EMAIL]',         description: "user's primary email address",         value: 'wilfred@example.com' },
  { token: '[PHONE]',         description: "user's phone number (E.164 format)",   value: '+44 7700 900123' },
  { token: '[PRONOUNS]',      description: "user's preferred pronouns",            value: 'he/him' },
  { token: '[JOB TITLE]',     description: "user's job title",                     value: 'Software Engineer' },
  { token: '[COMPANY]',       description: "user's current employer",              value: 'Acme Corp' },
  { token: '[WORK CITY]',     description: "city where user works",                value: 'London' },
  { token: '[HOME CITY]',     description: "city where user lives",                value: 'London' },
  { token: '[HOME COUNTRY]',  description: "country where user lives",             value: 'United Kingdom' },
  { token: '[HOME POSTCODE]', description: "user's home postcode/ZIP",             value: 'SW1A 1AA' },
  { token: '[GITHUB]',        description: "user's GitHub profile URL",            value: 'https://github.com/wkasekende' },
  { token: '[LINKEDIN]',      description: "user's LinkedIn profile URL",          value: 'https://linkedin.com/in/wkasekende' },
  { token: '[TWITTER]',       description: "user's Twitter/X handle including @",  value: '@wkasekende' },
  { token: '[WEBSITE]',       description: "user's personal website URL",          value: 'https://wkasekende.com' },
];

/** Catalog block injected into the system prompt. Format matches what a
 *  production User.md adapter would emit. */
export function renderCatalog(): string {
  const lines = SENTINELS.map(s => `- ${s.token} — ${s.description}`);
  return `USER CONTEXT — available tokens (emit verbatim; the runtime substitutes the real value before it reaches the user's buffer):

${lines.join('\n')}

RULES for these tokens (strict):
1. Emit the token EXACTLY as written above. The format is [UPPERCASE WORDS SEPARATED BY ONE SPACE]. Do NOT change spaces to underscores. Do NOT use snake_case or camelCase. Do NOT translate.
2. ONLY use tokens from the list above. The list is EXHAUSTIVE. If you find yourself wanting to write [SOMETHING_NEW] or [SOMETHING NEW] not on the list — STOP. Either pick the closest listed token, or answer in plain words without any bracket-token at all.
3. WRONG examples (never do these):
   - [WORK_CITY] — the list has [WORK CITY] (space, not underscore).
   - [DATE OF BIRTH], [BLOOD TYPE], [NICKNAME] — these are not in the list; do not invent them.
   - [first name], [First Name] — wrong case.
4. If the question is answerable with a listed token, USE the token. Don't paraphrase or guess values.
5. If no listed token matches, answer in plain words without inventing a bracket-token.`;
}

/** Map of token → expected verbatim string. Used by the bench grader. */
export const TOKEN_SET = new Set(SENTINELS.map(s => s.token));

/** Map of token → value. For raw-leak detection. */
export const VALUE_BY_TOKEN: ReadonlyMap<string, string> = new Map(
  SENTINELS.map(s => [s.token, s.value]),
);

/** All raw values that should NEVER appear in an LLM response when
 *  sentinel mode is "working" (since the LLM was told to use tokens). */
export const ALL_VALUES: readonly string[] = SENTINELS.map(s => s.value);
