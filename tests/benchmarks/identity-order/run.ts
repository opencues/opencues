/**
 * Identity-catalog prompt-order + rules regression bench.
 *
 * Two questions:
 *   1. Did PR `2a79fdf` (Jun 14 2026) — which moved the IDENTITY.md
 *      catalog block from USER → SYSTEM in TransformBlank's FUSED path
 *      to grow the cerebras prefix-cache — change how reliably the LLM
 *      emits sender-data sentinels on compose-style inputs?
 *   2. Does adding anti-duplication + check-existing-representative
 *      rules to the catalog block reduce double-emission AND missed
 *      slots (generic placeholders like [Your Name] / [Sender Email]
 *      where a catalog token was on offer)?
 *
 * Axes:
 *   - order  ∈ {system, user}    — catalog message-position
 *   - prompt ∈ {old, new}        — catalog RULES block
 *   - input  ∈ {5 compose cases} — short generative prompts that
 *                                  legitimately reference many sender
 *                                  fields
 *
 * Per cell N trials at distinct seeds (temperature stays at 0; cerebras
 * gpt-oss-120b has seed-driven nondeterminism we want to average over).
 *
 * Metrics (per output):
 *   - listedHits       — count of catalog tokens emitted
 *   - distinctListed   — count of *distinct* catalog tokens
 *   - dups             — listedHits − distinctListed (the regression
 *                        signal for "model double-states the same
 *                        sender field")
 *   - missedSlots      — bracket-shaped sender placeholders that should
 *                        have been catalog tokens (e.g. [Your Name],
 *                        [Sender Email], [Your Title])
 *   - rawLeaks         — catalog VALUES appearing verbatim (should
 *                        always be 0 — the catalog is in 'safe' mode)
 *
 * Run:
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
 *     npx tsx tests/benchmarks/identity-order/run.ts [--trials 5]
 */

import { chat, sysUser, MODEL } from '../fluid-blank/groq';

// ── Production FUSED_SYSTEM (mirror of
// packages/opencues-core/src/sources/transform-blank-source.ts:779) ────
const FUSED_SYSTEM = `Read the input and produce a structured edit result.

The input is a sentence with an underscore (_) signalling either an IMPERATIVE INSTRUCTION the user wants applied to surrounding text, OR a command to manage a continuously-running agent task, OR a lookup placeholder (none of those).

Output exactly four labelled lines (FULL_REWRITE may span multiple lines):
VERDICT: TRANSFORM | NONE | TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW
INSTRUCTION: <the imperative phrase OR task prompt, _ removed; or empty>
TARGET: <the rest of the input after removing instruction + _; or empty>
FULL_REWRITE: <the ENTIRE final buffer with the instruction applied AND the instruction phrase + _ removed. Contains ONLY what the user should see. Empty when VERDICT is NONE / TASK_*>

GENERATIVE — when the imperative asks to CREATE/GENERATE ("write a poem", "compose an email", "give me 5 startup ideas"), VERDICT=TRANSFORM, TARGET is empty, FULL_REWRITE contains the generated content.

EXAMPLES:

INPUT: write a poem about the sea _
VERDICT: TRANSFORM
INSTRUCTION: write a poem about the sea
TARGET:
FULL_REWRITE: Waves whisper to the shore, / endless rhythm, salt-bright air, / the sea holds every story.

INPUT: capital of france _
VERDICT: NONE
INSTRUCTION:
TARGET:
FULL_REWRITE:`;

// ── Sender catalog ────────────────────────────────────────────────────
const FIELDS = [
  { token: '[FIRST NAME]',    description: "user's first name",                    value: 'Wilfred',                              covers: 'given name, forename' },
  { token: '[LAST NAME]',     description: "user's last name",                     value: 'Kasekende',                            covers: 'surname, family name' },
  { token: '[FULL NAME]',     description: "user's first + last name combined",    value: 'Wilfred Kasekende',                    covers: 'my name, the sender, the author, signed by, sign as me' },
  { token: '[EMAIL]',         description: "user's primary email address",         value: 'wilfred@example.com',                  covers: 'my email, contact email, reach me at, email address' },
  { token: '[PHONE]',         description: "user's phone number (E.164 format)",   value: '+44 7700 900123',                      covers: 'my phone, call me at, mobile, cell, telephone' },
  { token: '[PRONOUNS]',      description: "user's preferred pronouns",            value: 'he/him',                               covers: 'my pronouns, they/them, she/her' },
  { token: '[JOB TITLE]',     description: "user's job title",                     value: 'Software Engineer',                    covers: 'my role, my position, what I do, what I work as, my title' },
  { token: '[COMPANY]',       description: "user's current employer",              value: 'Acme Corp',                            covers: 'where I work, my employer, my team, my organisation, my org' },
  { token: '[WORK CITY]',     description: "city where user works",                value: 'London',                               covers: 'based in (for work), where I work from, my office city' },
  { token: '[HOME CITY]',     description: "city where user lives",                value: 'London',                               covers: 'where I live, my home town, my city' },
  { token: '[HOME COUNTRY]',  description: "country where user lives",             value: 'United Kingdom',                       covers: 'my country, country of residence, where I am' },
  { token: '[HOME POSTCODE]', description: "user's home postcode/ZIP",             value: 'SW1A 1AA',                             covers: 'my postcode, my ZIP, postal code' },
  { token: '[GITHUB]',        description: "user's GitHub profile URL",            value: 'https://github.com/wkasekende',        covers: 'my github, github profile, code, repos' },
  { token: '[LINKEDIN]',      description: "user's LinkedIn profile URL",          value: 'https://linkedin.com/in/wkasekende',   covers: 'my linkedin, professional profile, connect with me, find me on LI' },
  { token: '[TWITTER]',       description: "user's Twitter/X handle including @",  value: '@wkasekende',                          covers: 'my twitter, my X, my handle, follow me, DM me' },
  { token: '[WEBSITE]',       description: "user's personal website URL",          value: 'https://wkasekende.com',               covers: 'my site, my homepage, my blog, my portfolio, more at' },
];

const TOKEN_SET = new Set(FIELDS.map(f => f.token));
const ALL_VALUES = FIELDS.map(f => f.value);
const FIELD_LINES = FIELDS.map(f => `- ${f.token} — ${f.description} (covers: ${f.covers})`).join('\n');

// ── Two RULES bodies: OLD (current production) vs NEW (anti-dup +
// check-existing-representative) ──────────────────────────────────────
const RULES_OLD = `RULES for these tokens:
1. Emit a token EXACTLY as written above (format: [UPPERCASE WORDS]) when the generated/rewritten content refers to the SENDER and a listed token fits. Do NOT use snake_case, lowercase, or invent variants.
2. Tokens describe the SENDER ONLY. For OTHER people or entities (the recipient, a counterparty, a third party), use a natural placeholder ([Recipient Name], [Date], etc.) as you would normally — DO NOT use a sender token to fill someone else's slot.
3. The list is EXHAUSTIVE for sender data. If no listed token fits a sender slot, write a natural placeholder ([Your Position]) — DO NOT invent a new sender sentinel like [USER_NAME] or [SENDER_EMAIL].
4. When the content has no sender reference (a poem, a translation, a summary of someone else's text), do NOT pull in any tokens.
5. When the user's instruction itself names a value already (e.g. "sign as Bob"), follow the instruction — do NOT override with a catalog token.`;

// Iteration target — same shape as RULES_OLD plus a CONTEXT-FIT SCAN
// rule that nudges the LLM to actively look at the catalog and pull in
// every field that fits the genre being composed. Designed to raise
// utilization of low-frequency fields ([LINKEDIN] / [GITHUB] /
// [WEBSITE] / [WORK CITY] / [PRONOUNS] / address parts) WITHOUT making
// the LLM cram unrelated fields into generic compose tasks.
//
// Iteration v1 (this body) — first attempt; iterate by editing in place
// and re-running. Each iteration kept here in a comment block above the
// active body so the prior version is one git-checkout away.
const RULES_NEW = `RULES for these tokens:
1. Emit a token EXACTLY as written above (format: [UPPERCASE WORDS]) when the generated/rewritten content refers to the SENDER and a listed token fits. Do NOT use snake_case, lowercase, or invent variants.
2. Tokens describe the SENDER ONLY. For OTHER people or entities (the recipient, a counterparty, a third party), use a natural placeholder ([Recipient Name], [Date], etc.) as you would normally — DO NOT use a sender token to fill someone else's slot.
3. The list is EXHAUSTIVE for sender data. If no listed token fits a sender slot, write a natural placeholder ([Your Position]) — DO NOT invent a new sender sentinel like [USER_NAME] or [SENDER_EMAIL].
4. When the content has no sender reference (a poem, a translation, a summary of someone else's text), do NOT pull in any tokens.
5. When the user's instruction itself names a value already (e.g. "sign as Bob"), follow the instruction — do NOT override with a catalog token.
6. SECTION-FIT SCAN — when a generative rewrite contains any of the following SECTION TYPES, fill it from the catalog. A document may contain ZERO, ONE, or MANY of these — apply each rule independently. Sections are compositional: a cover letter has a HEADER + a BYLINE + a SIGNATURE; a tweet bio has only a ROLE-LINE; an invoice has a HEADER only.

   • BYLINE / OPENER ("I'm <name>, a <role> at <company> based in <city>") → [FULL NAME], [JOB TITLE], [COMPANY], [WORK CITY], [PRONOUNS] when natural.
   • SIGNATURE / SIGN-OFF (block under "Best regards,") → [FULL NAME], [JOB TITLE], [COMPANY], [EMAIL], [PHONE], + [LINKEDIN]/[GITHUB]/[WEBSITE] when relevant.
   • CONTACT HEADER (top-of-CV / top-of-cover-letter / invoice-from block) → [FULL NAME], [EMAIL], [PHONE], [HOME CITY], [HOME COUNTRY], [HOME POSTCODE], + [LINKEDIN]/[GITHUB]/[WEBSITE].
   • ADDRESS BLOCK (postal address, "where to mail") → [FULL NAME], [HOME CITY], [HOME COUNTRY], [HOME POSTCODE].
   • PROFILE-LINK STRIP (social-handle line, often pipe- or bullet-separated) → all relevant of [LINKEDIN], [GITHUB], [TWITTER], [WEBSITE].
   • ROLE-LINE (one-line "what I do" — bio header, twitter bio, slack title) → [JOB TITLE], [COMPANY], + [PRONOUNS] when bio-shaped, + one PROFILE-LINK STRIP token when room allows.
   • SUBJECT TITLE (email subject naming the sender — "Resignation – ___", "Introduction – ___") → [FULL NAME].

   For each section the document contains, include EVERY listed catalog token from that section's list that has a corresponding catalog entry. Omitting a token that fits a section MAKES THE USER FILL IT IN MANUALLY — that's the failure mode this rule prevents.

   Common DOCUMENT SHAPES decompose as follows — use this if the input matches:
   - Email (most kinds) → SUBJECT TITLE? + body prose + SIGNATURE.
   - Cover letter → CONTACT HEADER + body prose + SIGNATURE.
   - Bio / "about me" / LinkedIn about / portfolio about → BYLINE + value-prop prose + PROFILE-LINK STRIP.
   - CV / resume header → CONTACT HEADER + PROFILE-LINK STRIP.
   - Invoice header → CONTACT HEADER.
   - Twitter / X bio → ROLE-LINE (single line, ends with one [TWITTER] or [WEBSITE]).
   - GitHub README header → BYLINE + PROFILE-LINK STRIP ([GITHUB], [WEBSITE]).
   - Slack standup / status post → optional ROLE-LINE then bullet content.
   - Conference talk abstract → BYLINE (opening sentence) + abstract prose + PROFILE-LINK STRIP at end ("Reach me at [TWITTER] / [WEBSITE]").
   - Podcast guest intro → BYLINE + value-prop sentence + PROFILE-LINK STRIP.
   - Mailing address → ADDRESS BLOCK.
   - Daily briefing / news roundup email → SUBJECT TITLE + sections of content + SIGNATURE.

7. Conversely, do NOT cram fields into documents that don't conventionally include any of the above sections — a one-line status update has no SIGNATURE; a poem has no BYLINE; a single-line slack reply has no ROLE-LINE.`;

function buildCatalogBlock(rules: string): string {
  const header = `USER CONTEXT — tokens for the SENDER / AUTHOR / USER (the person composing this content). The runtime substitutes the real value before it reaches the user's buffer:`;
  return `\n\n${header}\n\n${FIELD_LINES}\n\n${rules}`;
}

const CATALOG_BLOCK_OLD = buildCatalogBlock(RULES_OLD);
const CATALOG_BLOCK_NEW = buildCatalogBlock(RULES_NEW);

// ── Blank-context catalog (mirror of
// renderBlankContextCatalogForTransform in
// packages/opencues-core/src/blank-context.ts:346) ────────────────────
//
// Synthetic snapshot — what the runtime would render if a user had
// stocks/weather/crypto/hackernews blanks with as-context: true.
// Values picked to look real so the LLM treats them as live data.
const BLANK_CONTEXT_FIELDS = [
  { token: '[STOCK AAPL]',      description: 'current Apple Inc. price',                     value: '$214.32' },
  { token: '[STOCK TSLA]',      description: 'current Tesla Inc. price',                     value: '$246.10' },
  { token: '[STOCK NVDA]',      description: 'current NVIDIA Corporation price',             value: '$1284.55' },
  { token: '[STOCK MSFT]',      description: 'current Microsoft Corp. price',                value: '$429.88' },
  { token: '[WEATHER LONDON]',  description: 'current weather conditions in London',          value: '14°C, overcast' },
  { token: '[WEATHER NYC]',     description: 'current weather conditions in New York City',   value: '22°C, sunny' },
  { token: '[CRYPTO BTC]',      description: 'current Bitcoin price (USD)',                  value: '$98,420' },
  { token: '[CRYPTO ETH]',      description: 'current Ethereum price (USD)',                 value: '$3,612' },
  { token: '[HACKERNEWS TOP]',  description: 'current top story on Hacker News',             value: 'Show HN: I built a thing in Rust (412 points)' },
] as const;

const BLANK_TOKEN_SET = new Set(BLANK_CONTEXT_FIELDS.map(f => f.token));
const BLANK_ALL_VALUES = BLANK_CONTEXT_FIELDS.map(f => f.value);

const BLANK_CONTEXT_BLOCK = (() => {
  const header = `BLANK CONTEXT — ambient live-data tokens (stocks/weather/crypto/… snapshots). When the rewritten content REFERENCES this ambient data, emit the matching token VERBATIM; the runtime substitutes the live value before the result reaches the user's buffer:`;
  const lines = BLANK_CONTEXT_FIELDS.map(f => `- ${f.token} — ${f.description}`);
  const rules = `RULES for these tokens:
1. Emit each token EXACTLY as written above (format: [UPPERCASE WORDS SEPARATED BY ONE SPACE]). Case + spacing matter; do not invent variants.
2. Match LIBERALLY — "the weather" / "outside" / "umbrella" route to [WEATHER ...]; "BTC" / "bitcoin" / "crypto" route to [CRYPTO BTC]; "my portfolio" / "stocks" / "holdings" route to [STOCK ...].
3. NEVER invent bracket-tokens. Do NOT emit [PORTFOLIO], [HOLDINGS], [BITCOIN] when the listed token is [STOCK NVDA] / [CRYPTO BTC] / etc.
4. When multiple slot tokens share a prefix and the rewrite refers to the topic generally (e.g. "my stocks", "my portfolio"), emit ALL of them in natural prose order.
5. If the rewrite does not reference any of the ambient data, do NOT pull in any token.
6. The list is EXHAUSTIVE for live-data tokens. If no listed token fits a slot the rewrite needs, write a natural placeholder ([Current Price]) rather than inventing a bracket-token.
7. SPECIFIC-ENTITY CHECK — before writing prose ABOUT a named entity (Apple, Bitcoin, the London weather, NVIDIA, etc.), SCAN the catalog above for that exact entity. If a matching token exists, USE IT instead of paraphrasing or omitting the value. The user typed about that entity because they want the live value visible — do not bury it.
   Example: input "draft an email about exiting our Apple position" → the rewrite says "Apple (AAPL) is trading at [STOCK AAPL]" (uses the token). WRONG: writing about AAPL without ever citing [STOCK AAPL].
8. EACH TOKEN IS ONE ENTITY'S VALUE — never substitute a token where the prose refers to a DIFFERENT entity than the token's name. [STOCK AAPL] is Apple's share price ONLY — do not use it for an index level (S&P 500, Dow, Nasdaq composite), an unrelated stock, or as a generic numeric placeholder. If the rewrite needs a value that ISN'T in the catalog, write prose ("approximately X" / "[Current Index Level]") — DO NOT borrow another token to fill the slot.
   WRONG: "The S&P 500 closed at [STOCK AAPL] points" (AAPL is a single stock, not the index).
   WRONG: "Oil prices settled at [STOCK MSFT] per barrel" (MSFT is a stock, not oil).
   RIGHT: "The S&P 500 closed at [Current Index Level], with [STOCK AAPL] and [STOCK NVDA] leading the gainers".`;
  return `\n\n${header}\n\n${lines.join('\n')}\n\n${rules}`;
})();

// ── Inputs (compose-style) + the per-input EXPECTED sender-field set ──
//
// For each input, EXPECTED is the set of catalog fields a competent
// human writer would conventionally include in the canonical version of
// that document. The intersection of EXPECTED with what the LLM emitted
// is the "utilization" rate — how much of the available sender data
// the model actually pulled in. Fields in EXPECTED that the model NEVER
// emits across N trials are "data on the shelf, never used".
//
// Inputs deliberately chosen so that EVERY catalog field maps to at
// least one input's EXPECTED set — that way utilization gaps surface
// per-field, not just per-input.
//
// Per-field coverage map (catalog → inputs that expect it):
//   [FIRST NAME]    → form-shaped inputs only — generic compose uses [FULL NAME]
//   [LAST NAME]     → form-shaped inputs only
//   [FULL NAME]     → email, resignation, intro, leave, cover-letter, bio, sig, linkedin, github, twitter, mailing-address
//   [EMAIL]         → email, resignation, intro, leave, cover-letter, sig
//   [PHONE]         → email, resignation, intro, leave, cover-letter, sig
//   [PRONOUNS]      → bio, slack-intro, twitter-bio, dating-profile
//   [JOB TITLE]     → cover-letter, resignation, intro, sig, bio, linkedin, github, twitter
//   [COMPANY]       → cover-letter, resignation, intro, sig, bio, linkedin
//   [WORK CITY]     → intro, bio, linkedin, slack-intro
//   [HOME CITY]     → cover-letter, mailing-address, dating-profile
//   [HOME COUNTRY]  → cover-letter, mailing-address
//   [HOME POSTCODE] → mailing-address
//   [GITHUB]        → github-bio, sig (tech)
//   [LINKEDIN]      → cover-letter, intro, sig, linkedin
//   [TWITTER]       → twitter-bio, sig (creative)
//   [WEBSITE]       → cover-letter, sig, bio, linkedin, github, twitter
const INPUTS: Array<{ text: string; expected: ReadonlyArray<string> }> = [
  // ── Original 5 compose-email inputs ──────────────────────────────────
  {
    text: 'draft email _',
    expected: ['[FULL NAME]', '[JOB TITLE]', '[COMPANY]', '[EMAIL]', '[PHONE]'],
  },
  {
    text: 'draft resignation email _',
    expected: ['[FULL NAME]', '[JOB TITLE]', '[COMPANY]', '[EMAIL]', '[PHONE]'],
  },
  {
    text: 'draft cover letter _',
    expected: [
      '[FULL NAME]', '[EMAIL]', '[PHONE]',
      '[HOME CITY]', '[HOME COUNTRY]',
      '[JOB TITLE]', '[COMPANY]',
      '[LINKEDIN]', '[WEBSITE]',
    ],
  },
  {
    text: 'draft intro email _',
    expected: [
      '[FULL NAME]', '[JOB TITLE]', '[COMPANY]',
      '[WORK CITY]',
      '[EMAIL]', '[PHONE]',
      '[LINKEDIN]',
    ],
  },
  {
    text: 'draft leave request email _',
    expected: ['[FULL NAME]', '[JOB TITLE]', '[COMPANY]', '[EMAIL]', '[PHONE]'],
  },

  // ── Profile / bio / signature — exercises social + work-city fields ──
  {
    text: 'write my email signature _',
    expected: [
      '[FULL NAME]', '[JOB TITLE]', '[COMPANY]',
      '[EMAIL]', '[PHONE]',
      '[LINKEDIN]', '[WEBSITE]',
    ],
  },
  {
    text: 'write my professional bio _',
    expected: [
      '[FULL NAME]', '[PRONOUNS]',
      '[JOB TITLE]', '[COMPANY]', '[WORK CITY]',
      '[WEBSITE]',
    ],
  },
  {
    text: 'write my linkedin about section _',
    expected: [
      '[FULL NAME]', '[JOB TITLE]', '[COMPANY]', '[WORK CITY]',
      '[LINKEDIN]', '[WEBSITE]',
    ],
  },
  {
    text: 'write my github profile readme _',
    expected: [
      '[FULL NAME]', '[JOB TITLE]',
      '[GITHUB]', '[WEBSITE]',
    ],
  },
  {
    text: 'write a short twitter bio _',
    expected: [
      '[PRONOUNS]', '[JOB TITLE]', '[COMPANY]',
      '[TWITTER]', '[WEBSITE]',
    ],
  },

  // ── Address-shaped — exercises home-city/country/postcode ────────────
  {
    text: 'fill out my mailing address _',
    expected: [
      '[FULL NAME]',
      '[HOME CITY]', '[HOME COUNTRY]', '[HOME POSTCODE]',
    ],
  },

  // ── Non-email identity cases ────────────────────────────────────────
  // These exercise compose contexts where identity matters but the
  // genre isn't an email — slack post, talk abstract, CV, invoice, etc.
  {
    text: 'draft a slack standup message _',
    expected: ['[FIRST NAME]', '[JOB TITLE]'],   // forgiving — most users just say "I" in standup
  },
  {
    text: 'write a conference talk abstract about my work _',
    expected: [
      '[FULL NAME]', '[JOB TITLE]', '[COMPANY]',
      '[TWITTER]', '[WEBSITE]',                   // speaker handles often surface
    ],
  },
  {
    text: 'write my CV header block _',
    expected: [
      '[FULL NAME]', '[EMAIL]', '[PHONE]',
      '[HOME CITY]', '[HOME COUNTRY]',
      '[LINKEDIN]', '[GITHUB]', '[WEBSITE]',
    ],
  },
  {
    text: 'draft my podcast guest introduction _',
    expected: [
      '[FULL NAME]', '[PRONOUNS]',
      '[JOB TITLE]', '[COMPANY]',
      '[TWITTER]', '[WEBSITE]',
    ],
  },
  {
    text: 'draft my freelance invoice header _',
    expected: [
      '[FULL NAME]', '[EMAIL]', '[PHONE]',
      '[HOME CITY]', '[HOME COUNTRY]', '[HOME POSTCODE]',
      '[WEBSITE]',
    ],
  },
  {
    text: 'write my portfolio about page header _',
    expected: [
      '[FULL NAME]', '[PRONOUNS]',
      '[JOB TITLE]', '[COMPANY]', '[WORK CITY]',
      '[GITHUB]', '[LINKEDIN]', '[TWITTER]', '[WEBSITE]',
    ],
  },

  // ── Blank-context (ambient live-data) compose cases ──────────────────
  // Inputs that should pull AMBIENT live-data tokens ([STOCK ...] /
  // [WEATHER ...] / [CRYPTO ...] / [HACKERNEWS ...]) AND the identity
  // signature. Each declares `blankCtx: true` so the bench injects the
  // blank-context catalog into the prompt alongside identity.
];

interface BlankCtxInput { text: string; expected: ReadonlyArray<string>; expectedBlanks: ReadonlyArray<string>; }
const BLANK_CTX_INPUTS: ReadonlyArray<BlankCtxInput> = [
  {
    text: "draft today's market summary email _",
    expected: ['[FULL NAME]', '[JOB TITLE]', '[COMPANY]', '[EMAIL]', '[PHONE]'],
    expectedBlanks: ['[STOCK AAPL]', '[STOCK TSLA]', '[STOCK NVDA]'],
  },
  {
    text: 'tweet about the weather today _',
    expected: [],                                              // tweets usually skip identity
    expectedBlanks: ['[WEATHER LONDON]'],
  },
  {
    text: 'write a daily briefing email _',
    expected: ['[FULL NAME]', '[JOB TITLE]', '[COMPANY]'],
    expectedBlanks: ['[STOCK AAPL]', '[WEATHER LONDON]', '[HACKERNEWS TOP]'],
  },
  {
    text: 'post a crypto market update for my team _',
    expected: ['[FULL NAME]', '[JOB TITLE]', '[COMPANY]'],
    expectedBlanks: ['[CRYPTO BTC]', '[CRYPTO ETH]'],
  },
  {
    text: 'draft an email recommending we move on the apple position _',
    expected: ['[FULL NAME]', '[JOB TITLE]', '[COMPANY]', '[EMAIL]', '[PHONE]'],
    expectedBlanks: ['[STOCK AAPL]'],
  },
];

type Order = 'system' | 'user';
type Prompt = 'old' | 'new';
const ORDERS: Order[] = ['system', 'user'];
const PROMPTS: Prompt[] = ['old', 'new'];

function buildPrompt(order: Order, prompt: Prompt, input: string, withBlankCtx: boolean = false): { system: string; user: string } {
  const idCatalog = prompt === 'old' ? CATALOG_BLOCK_OLD : CATALOG_BLOCK_NEW;
  const blankCatalog = withBlankCtx ? BLANK_CONTEXT_BLOCK : '';
  if (order === 'system') {
    return { system: `${FUSED_SYSTEM}${idCatalog}${blankCatalog}`, user: `INPUT: ${input}` };
  }
  return { system: FUSED_SYSTEM, user: `${idCatalog}${blankCatalog}\n\nINPUT: ${input}` };
}

function parseFullRewrite(raw: string): string {
  const m = raw.match(/FULL_REWRITE:\s*([\s\S]*?)\s*$/i);
  return m ? m[1].trim() : raw.trim();
}

// Bracket-token scanner (canonical catalog shape: [UPPERCASE WORDS]).
const BRACKET_CAP_RE = /\[[A-Z][A-Z0-9 _-]*\]/g;
function findCanonicalBrackets(s: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = BRACKET_CAP_RE.exec(s)) !== null) out.push(m[0]);
  return out;
}

// Generic-sender-placeholder detector — bracket tokens (any case) that
// describe the SENDER but were emitted as natural placeholders instead
// of catalog tokens. Each pattern is a regex matched case-insensitively
// against the *content* of the bracket (so [Your Name], [your name],
// [YOUR NAME], [My Name], [Sender Name] all hit).
const MISSED_SLOT_PATTERNS: Array<{ rx: RegExp; field: string }> = [
  { rx: /^\s*(your|my|sender|author|user)\s*(full\s*)?name\s*$/i,                  field: '[FULL NAME] or [FIRST NAME]' },
  { rx: /^\s*(your|my|sender|author|user)\s*first\s*name\s*$/i,                    field: '[FIRST NAME]' },
  { rx: /^\s*(your|my|sender|author|user)\s*last\s*name\s*$/i,                     field: '[LAST NAME]' },
  { rx: /^\s*name\s*$/i,                                                           field: '[FULL NAME] or [FIRST NAME]' },
  { rx: /^\s*(your|my|sender)\s*email(\s*address)?\s*$/i,                          field: '[EMAIL]' },
  { rx: /^\s*email(\s*address)?\s*$/i,                                             field: '[EMAIL]' },
  { rx: /^\s*(your|my|sender)\s*phone(\s*(number|no))?\s*$/i,                      field: '[PHONE]' },
  { rx: /^\s*phone(\s*(number|no))?\s*$/i,                                         field: '[PHONE]' },
  { rx: /^\s*(your|my|sender)\s*(position|title|role|job\s*title)\s*$/i,           field: '[JOB TITLE]' },
  { rx: /^\s*(position|title|role|job\s*title)\s*$/i,                              field: '[JOB TITLE]' },
  { rx: /^\s*(your|my|sender)\s*(company|employer|organi[sz]ation)\s*$/i,          field: '[COMPANY]' },
  { rx: /^\s*(company|employer|organi[sz]ation)\s*$/i,                             field: '[COMPANY]' },
  { rx: /^\s*(your|my|sender)\s*(pronouns)\s*$/i,                                  field: '[PRONOUNS]' },
  { rx: /^\s*(your|my|sender)\s*(work\s*)?city\s*$/i,                              field: '[WORK CITY] or [HOME CITY]' },
  { rx: /^\s*(your|my|sender)\s*(github|linkedin|twitter|website)\s*(url|handle|profile)?\s*$/i, field: '[GITHUB]/[LINKEDIN]/[TWITTER]/[WEBSITE]' },
];

// Match any bracket-shaped thing (mixed case allowed) so we can run the
// missed-slot patterns over the inner text.
const BRACKET_ANY_RE = /\[([^\[\]]+)\]/g;

interface MissedSlot { written: string; suggested: string; }
function findMissedSlots(s: string): MissedSlot[] {
  const out: MissedSlot[] = [];
  let m: RegExpExecArray | null;
  while ((m = BRACKET_ANY_RE.exec(s)) !== null) {
    const full = m[0];
    if (TOKEN_SET.has(full)) continue;  // canonical catalog hit — not a miss
    const inner = m[1];
    for (const p of MISSED_SLOT_PATTERNS) {
      if (p.rx.test(inner)) { out.push({ written: full, suggested: p.field }); break; }
    }
  }
  return out;
}

interface Outcome {
  order: Order;
  prompt: Prompt;
  input: string;
  seed: number;
  latencyMs: number;
  raw: string;
  rewrite: string;
  listedHits: string[];        // every emission of a catalog token (with dups)
  distinctListed: string[];    // de-duplicated catalog hits
  dupTokens: string[];         // tokens that appeared >1×
  missedSlots: MissedSlot[];   // generic-sender placeholders
  rawLeaks: string[];          // catalog VALUES appearing verbatim
  expectedHit: string[];       // expected fields the LLM did emit
  expectedMiss: string[];      // expected fields the LLM did NOT emit
}

async function runOne(order: Order, prompt: Prompt, input: { text: string; expected: ReadonlyArray<string> }, seed: number): Promise<Outcome> {
  const { system, user } = buildPrompt(order, prompt, input.text);
  const t0 = Date.now();
  const r = await chat(sysUser(system, user), { temperature: 0, seed, maxTokens: 900 });
  const latencyMs = Date.now() - t0;
  const rewrite = parseFullRewrite(r.text);
  const allBrackets = findCanonicalBrackets(rewrite);
  const listedHits = allBrackets.filter(t => TOKEN_SET.has(t));
  const counts = new Map<string, number>();
  for (const t of listedHits) counts.set(t, (counts.get(t) ?? 0) + 1);
  const distinctListed = Array.from(counts.keys());
  const dupTokens: string[] = [];
  for (const [t, n] of counts) if (n > 1) for (let i = 1; i < n; i++) dupTokens.push(t);
  const missedSlots = findMissedSlots(rewrite);
  const rawLeaks: string[] = [];
  for (const v of ALL_VALUES) {
    if (v.length < 3) continue;
    if (rewrite.includes(v)) rawLeaks.push(v);
  }
  // Treat [FULL NAME] and [FIRST NAME] [LAST NAME] (adjacent) as
  // interchangeable for utilization purposes — both represent the
  // sender's name. If the model emits FIRST+LAST, count it as
  // satisfying [FULL NAME].
  const distinctSet = new Set(distinctListed);
  if (distinctSet.has('[FIRST NAME]') && distinctSet.has('[LAST NAME]')) {
    distinctSet.add('[FULL NAME]');
  }
  const expectedHit = input.expected.filter(t => distinctSet.has(t));
  const expectedMiss = input.expected.filter(t => !distinctSet.has(t));
  return { order, prompt, input: input.text, seed, latencyMs, raw: r.text, rewrite, listedHits, distinctListed, dupTokens, missedSlots, rawLeaks, expectedHit, expectedMiss };
}

interface CellAgg {
  meanHits: number;
  meanDistinct: number;
  meanDups: number;
  meanMissed: number;
  anyLeakPct: number;
  trials: number;
}

function aggregate(outcomes: Outcome[]): CellAgg {
  const n = outcomes.length;
  const sum = (arr: Outcome[], f: (o: Outcome) => number) => arr.reduce((a, o) => a + f(o), 0);
  return {
    meanHits:     sum(outcomes, o => o.listedHits.length) / n,
    meanDistinct: sum(outcomes, o => o.distinctListed.length) / n,
    meanDups:     sum(outcomes, o => o.dupTokens.length) / n,
    meanMissed:   sum(outcomes, o => o.missedSlots.length) / n,
    anyLeakPct:   outcomes.filter(o => o.rawLeaks.length > 0).length / n * 100,
    trials: n,
  };
}

async function main(): Promise<void> {
  const TRIALS = parseInt(process.argv.find(a => a.startsWith('--trials='))?.split('=')[1] ?? '5', 10);
  const SEEDS = Array.from({ length: TRIALS }, (_, i) => 42 + i);

  console.log(`\nidentity-catalog prompt-order + rules bench`);
  console.log(`Model: ${MODEL}   inputs: ${INPUTS.length}   orders: ${ORDERS.length}   prompts: ${PROMPTS.length}   trials/cell: ${TRIALS}\n`);

  const outcomes: Outcome[] = [];
  const jobs: Array<() => Promise<void>> = [];
  for (const order of ORDERS) {
    for (const prompt of PROMPTS) {
      for (const input of INPUTS) {
        for (const seed of SEEDS) {
          jobs.push(async () => { outcomes.push(await runOne(order, prompt, input, seed)); });
        }
      }
    }
  }
  const CONC = 4;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (true) { const idx = i++; if (idx >= jobs.length) return; await jobs[idx](); }
  }));

  // Per-cell verbose (one representative trial per cell — the rest sum
  // into the aggregate). Cells of >5 trials produce too much output.
  console.log(`═══ SAMPLE OUTPUTS (seed=42) ═══`);
  for (const order of ORDERS) {
    for (const prompt of PROMPTS) {
      for (const input of INPUTS) {
        const o = outcomes.find(x => x.order === order && x.prompt === prompt && x.input === input.text && x.seed === 42);
        if (!o) continue;
        console.log(`\n── ORDER=${order.toUpperCase().padEnd(6)} PROMPT=${prompt.toUpperCase().padEnd(3)} INPUT="${input.text}"`);
        console.log(`   listed=[${o.listedHits.join(', ')}]`);
        console.log(`   dups=[${o.dupTokens.join(', ')}]  missedSlots=${o.missedSlots.map(m => m.written).join(', ') || '(none)'}  rawLeaks=${o.rawLeaks.length}`);
        console.log(`   utilization: ${o.expectedHit.length}/${input.expected.length} expected fields used; MISSED=[${o.expectedMiss.join(', ') || '(none)'}]`);
        const preview = o.rewrite.replace(/\n/g, '⏎').slice(0, 240);
        console.log(`   rewrite: ${preview}${o.rewrite.length > 240 ? '…' : ''}`);
      }
    }
  }

  // ── Aggregate per (order, prompt) — collapsed across inputs ─────────
  console.log(`\n\n═══ AGGREGATE per (order, prompt) — collapsed across ${INPUTS.length} inputs × ${TRIALS} trials ═══`);
  console.log(`order   prompt   trials   meanHits   meanDistinct   meanDups   meanMissed   rawLeak%`);
  console.log('─'.repeat(94));
  for (const order of ORDERS) {
    for (const prompt of PROMPTS) {
      const cell = outcomes.filter(o => o.order === order && o.prompt === prompt);
      const a = aggregate(cell);
      console.log(
        `${order.padEnd(8)}${prompt.padEnd(9)}${String(a.trials).padEnd(9)}` +
        `${a.meanHits.toFixed(2).padEnd(11)}${a.meanDistinct.toFixed(2).padEnd(15)}` +
        `${a.meanDups.toFixed(2).padEnd(11)}${a.meanMissed.toFixed(2).padEnd(13)}` +
        `${a.anyLeakPct.toFixed(0)}%`,
      );
    }
  }

  // ── Per-input × prompt — the most actionable view ───────────────────
  console.log(`\n\n═══ PER-INPUT × PROMPT (collapsed across both orderings × ${TRIALS} trials = ${ORDERS.length * TRIALS} samples) ═══`);
  console.log(`input                          prompt   meanHits   meanDistinct   meanDups   meanMissed`);
  console.log('─'.repeat(88));
  for (const input of INPUTS) {
    for (const prompt of PROMPTS) {
      const cell = outcomes.filter(o => o.input === input.text && o.prompt === prompt);
      const a = aggregate(cell);
      console.log(
        `${input.text.padEnd(32)}${prompt.padEnd(9)}${a.meanHits.toFixed(2).padEnd(11)}` +
        `${a.meanDistinct.toFixed(2).padEnd(15)}${a.meanDups.toFixed(2).padEnd(11)}${a.meanMissed.toFixed(2)}`,
      );
    }
  }

  // ── Δ summary: new − old ────────────────────────────────────────────
  console.log(`\n\n═══ Δ (NEW prompt − OLD prompt), collapsed across orderings + trials ═══`);
  console.log(`input                          ΔmeanHits   ΔmeanDistinct   ΔmeanDups   ΔmeanMissed`);
  console.log('─'.repeat(88));
  for (const input of INPUTS) {
    const oldCell = outcomes.filter(o => o.input === input.text && o.prompt === 'old');
    const newCell = outcomes.filter(o => o.input === input.text && o.prompt === 'new');
    const a = aggregate(oldCell), b = aggregate(newCell);
    const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
    console.log(
      `${input.text.padEnd(32)}${fmt(b.meanHits - a.meanHits).padEnd(12)}` +
      `${fmt(b.meanDistinct - a.meanDistinct).padEnd(16)}` +
      `${fmt(b.meanDups - a.meanDups).padEnd(12)}` +
      `${fmt(b.meanMissed - a.meanMissed)}`,
    );
  }

  // ── UTILIZATION report — does data on the shelf actually get used? ──
  // SYSTEM-ORDER ONLY because that's today's production order. USER-order
  // numbers exist in `outcomes` for the cross-order delta but aren't the
  // shipping-relevant signal — keeping the prod view here.
  console.log(`\n\n═══ UTILIZATION per (input, prompt) — SYSTEM-order only (today's prod) ═══`);
  console.log(`Higher = the LLM is pulling more of the available sender data into the rewrite.`);
  console.log(`Per-input "always-missed" lists fields in EXPECTED that the LLM NEVER emitted across all ${TRIALS} samples — data on the shelf, never used.`);
  console.log();
  console.log(`input                          prompt   |expected|   meanHit/Exp   util%      always-missed (never emitted)`);
  console.log('─'.repeat(120));
  for (const input of INPUTS) {
    for (const prompt of PROMPTS) {
      const cell = outcomes.filter(o => o.input === input.text && o.prompt === prompt && o.order === 'system');
      const meanHit = cell.reduce((a, o) => a + o.expectedHit.length, 0) / cell.length;
      const util = (meanHit / input.expected.length * 100).toFixed(1);
      const everEmitted = new Set<string>();
      for (const o of cell) for (const t of o.expectedHit) everEmitted.add(t);
      const alwaysMissed = input.expected.filter(t => !everEmitted.has(t));
      console.log(
        `${input.text.padEnd(32)}${prompt.padEnd(9)}${String(input.expected.length).padEnd(13)}` +
        `${meanHit.toFixed(2).padEnd(15)}${(util + '%').padEnd(11)}${alwaysMissed.join(', ') || '(none)'}`,
      );
    }
  }

  // Cross-input "fields the LLM rarely or never reaches for" — what
  // catalog data sits unused most often.
  console.log(`\n═══ CROSS-INPUT field-usage frequency (across all ${outcomes.length} trials, NEW prompt only) ═══`);
  const newOutcomes = outcomes.filter(o => o.prompt === 'new');
  const useCounts = new Map<string, number>();
  for (const f of FIELDS) useCounts.set(f.token, 0);
  for (const o of newOutcomes) for (const t of o.distinctListed) useCounts.set(t, (useCounts.get(t) ?? 0) + 1);
  const sorted = Array.from(useCounts.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`field             trials emitted in / ${newOutcomes.length}   pct`);
  for (const [token, n] of sorted) {
    const pct = (n / newOutcomes.length * 100).toFixed(0);
    console.log(`  ${token.padEnd(18)}${String(n).padEnd(28)}${pct}%`);
  }

  // Raw-leak audit — must stay 0 in safe mode.
  const totalLeak = outcomes.filter(o => o.rawLeaks.length > 0).length;
  console.log(`\nRaw-value leak audit: ${totalLeak}/${outcomes.length} outputs contained a verbatim catalog value (must be 0 in safe mode).`);
  if (totalLeak > 0) {
    for (const o of outcomes.filter(x => x.rawLeaks.length > 0)) {
      console.log(`  LEAK in (${o.order}/${o.prompt}/${o.input}/seed=${o.seed}): ${o.rawLeaks.join(', ')}`);
    }
  }

  // ── BLANK-CONTEXT sweep: a separate single-axis test for inputs that
  // should pull AMBIENT live-data tokens AS WELL AS identity. The
  // identity catalog uses the NEW (production) prompt; both catalogs go
  // in the system message (order=system, today's production order). ──
  console.log(`\n\n${'═'.repeat(78)}`);
  console.log(`BLANK-CONTEXT SWEEP — does the model use ambient live-data tokens?`);
  console.log(`Setup: identity catalog (NEW prompt) + blank-context catalog, both in system msg.`);
  console.log(`${'═'.repeat(78)}\n`);

  for (const input of BLANK_CTX_INPUTS) {
    console.log(`\n── INPUT: ${input.text}`);
    console.log(`   identity-expected: [${input.expected.join(', ') || '(none)'}]`);
    console.log(`   blank-expected:    [${input.expectedBlanks.join(', ') || '(none)'}]`);
    const { system, user } = buildPrompt('system', 'new', input.text, true);
    // Single-trial seed=42 (deterministic at temp=0).
    const r = await chat(sysUser(system, user), { temperature: 0, seed: 42, maxTokens: 1000 });
    const rewrite = parseFullRewrite(r.text);
    const brackets = findCanonicalBrackets(rewrite);
    const idHits = Array.from(new Set(brackets.filter(t => TOKEN_SET.has(t))));
    const blankHits = Array.from(new Set(brackets.filter(t => BLANK_TOKEN_SET.has(t))));
    const otherBrackets = Array.from(new Set(brackets.filter(t => !TOKEN_SET.has(t) && !BLANK_TOKEN_SET.has(t))));
    const idHitMap = new Set(idHits);
    if (idHitMap.has('[FIRST NAME]') && idHitMap.has('[LAST NAME]')) idHitMap.add('[FULL NAME]');
    const idMissed = input.expected.filter(t => !idHitMap.has(t));
    const blankMissed = input.expectedBlanks.filter(t => !blankHits.includes(t));
    const idRawLeaks = ALL_VALUES.filter(v => v.length >= 3 && rewrite.includes(v));
    const blankRawLeaks = BLANK_ALL_VALUES.filter(v => v.length >= 3 && rewrite.includes(v));
    console.log(`   identity-hits:     [${idHits.join(', ') || '(none)'}]   missed=${idMissed.join(', ') || '(none)'}`);
    console.log(`   blank-hits:        [${blankHits.join(', ') || '(none)'}]   missed=${blankMissed.join(', ') || '(none)'}`);
    if (otherBrackets.length > 0) console.log(`   other brackets:    [${otherBrackets.join(', ')}]`);
    if (idRawLeaks.length > 0 || blankRawLeaks.length > 0) {
      console.log(`   ⚠️ RAW LEAKS — identity=${idRawLeaks.join(', ') || '-'}  blank=${blankRawLeaks.join(', ') || '-'}`);
    }
    console.log(`   rewrite:\n${rewrite.split('\n').map(l => '     ' + l).join('\n')}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
