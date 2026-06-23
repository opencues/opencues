/**
 * Print the full FULL_REWRITE for each email-style input under OLD vs NEW
 * production prompt. Both use catalog-in-SYSTEM (current prod order),
 * seed=42, temp=0 — deterministic single trial per cell.
 */

import { chat, sysUser, MODEL } from '../fluid-blank/groq';

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

const FIELDS = [
  ['[FIRST NAME]',    "user's first name"],
  ['[LAST NAME]',     "user's last name"],
  ['[FULL NAME]',     "user's first + last name combined"],
  ['[EMAIL]',         "user's primary email address"],
  ['[PHONE]',         "user's phone number (E.164 format)"],
  ['[PRONOUNS]',      "user's preferred pronouns"],
  ['[JOB TITLE]',     "user's job title"],
  ['[COMPANY]',       "user's current employer"],
  ['[WORK CITY]',     "city where user works"],
  ['[HOME CITY]',     "city where user lives"],
  ['[HOME COUNTRY]',  "country where user lives"],
  ['[HOME POSTCODE]', "user's home postcode/ZIP"],
  ['[GITHUB]',        "user's GitHub profile URL"],
  ['[LINKEDIN]',      "user's LinkedIn profile URL"],
  ['[TWITTER]',       "user's Twitter/X handle including @"],
  ['[WEBSITE]',       "user's personal website URL"],
] as const;

const HEADER = `USER CONTEXT — tokens for the SENDER / AUTHOR / USER (the person composing this content). The runtime substitutes the real value before it reaches the user's buffer:`;
const FIELD_LINES = FIELDS.map(([t, d]) => `- ${t} — ${d}`).join('\n');

const RULES_OLD = `RULES for these tokens:
1. Emit a token EXACTLY as written above (format: [UPPERCASE WORDS]) when the generated/rewritten content refers to the SENDER and a listed token fits. Do NOT use snake_case, lowercase, or invent variants.
2. Tokens describe the SENDER ONLY. For OTHER people or entities (the recipient, a counterparty, a third party), use a natural placeholder ([Recipient Name], [Date], etc.) as you would normally — DO NOT use a sender token to fill someone else's slot.
3. The list is EXHAUSTIVE for sender data. If no listed token fits a sender slot, write a natural placeholder ([Your Position]) — DO NOT invent a new sender sentinel like [USER_NAME] or [SENDER_EMAIL].
4. When the content has no sender reference (a poem, a translation, a summary of someone else's text), do NOT pull in any tokens.
5. When the user's instruction itself names a value already (e.g. "sign as Bob"), follow the instruction — do NOT override with a catalog token.`;

const RULES_NEW = `RULES for these tokens:
1. Emit a token EXACTLY as written above (format: [UPPERCASE WORDS]) when the generated/rewritten content refers to the SENDER and a listed token fits. Do NOT use snake_case, lowercase, or invent variants.
2. Tokens describe the SENDER ONLY. For OTHER people or entities (the recipient, a counterparty, a third party), use a natural placeholder ([Recipient Name], [Date], etc.) as you would normally — DO NOT use a sender token to fill someone else's slot.
3. The list is EXHAUSTIVE for sender data. If no listed token fits a sender slot, write a natural placeholder ([Your Position]) — DO NOT invent a new sender sentinel like [USER_NAME] or [SENDER_EMAIL].
4. When the content has no sender reference (a poem, a translation, a summary of someone else's text), do NOT pull in any tokens.
5. When the user's instruction itself names a value already (e.g. "sign as Bob"), follow the instruction — do NOT override with a catalog token.
6. CONTEXT-FIT SCAN — before finishing a generative rewrite, scan the catalog above and INCLUDE every listed token that fits the document's conventional shape. Common shapes:
   - Email signature → [FULL NAME], [JOB TITLE], [COMPANY], [EMAIL], [PHONE], + [LINKEDIN]/[GITHUB]/[WEBSITE] if relevant.
   - Cover letter heading → [FULL NAME], [EMAIL], [PHONE], [HOME CITY], [HOME COUNTRY], + [LINKEDIN]/[WEBSITE].
   - Intro / outreach / "nice to meet you" email — first-time contact where the sender introduces themselves → body uses [FULL NAME], [JOB TITLE], [COMPANY], and [WORK CITY] for "based in ___"; signature uses [EMAIL], [PHONE], [LINKEDIN].
   - Personal/professional bio / "about me" → [FULL NAME] (open with "I'm [FULL NAME]"), [PRONOUNS], [JOB TITLE], [COMPANY], [WORK CITY], [WEBSITE].
   - LinkedIn about / headline → open with [FULL NAME], then [JOB TITLE], [COMPANY], [WORK CITY], [LINKEDIN], [WEBSITE].
   - GitHub README/bio → [FULL NAME], [JOB TITLE], [GITHUB], [WEBSITE].
   - Twitter/X bio → [PRONOUNS], [JOB TITLE], [COMPANY], [TWITTER], [WEBSITE].
   - Mailing address block → [FULL NAME], [HOME CITY], [HOME COUNTRY], [HOME POSTCODE].
   - Slack / Discord / "introduce yourself" channel intro → [FULL NAME], [PRONOUNS], [JOB TITLE], [COMPANY], [WORK CITY].
   Including a fitting token costs the user nothing (the runtime substitutes the real value). Omitting a token that would fit MAKES THE USER FILL IT IN MANUALLY — that's the failure mode this rule prevents.
7. Conversely, do NOT cram fields into documents that don't conventionally include them — a one-line status update doesn't need [GITHUB]; a poem doesn't need any sender token. Use the genre shape above as a positive filter only.`;

const CATALOG_OLD = `\n\n${HEADER}\n\n${FIELD_LINES}\n\n${RULES_OLD}`;
const CATALOG_NEW = `\n\n${HEADER}\n\n${FIELD_LINES}\n\n${RULES_NEW}`;

const INPUTS = [
  'draft email _',
  'draft resignation email _',
  'draft cover letter _',
  'draft intro email _',
  'draft leave request email _',
];

function parseFullRewrite(raw: string): string {
  const m = raw.match(/FULL_REWRITE:\s*([\s\S]*?)\s*$/i);
  return m ? m[1].trim() : raw.trim();
}

async function run(input: string, catalog: string): Promise<string> {
  const r = await chat(
    sysUser(`${FUSED_SYSTEM}${catalog}`, `INPUT: ${input}`),
    { temperature: 0, seed: 42, maxTokens: 900 },
  );
  return parseFullRewrite(r.text);
}

async function main() {
  console.log(`\nFull rewrites (cerebras ${MODEL}, seed=42, temp=0)\n`);
  for (const input of INPUTS) {
    const [oldOut, newOut] = await Promise.all([
      run(input, CATALOG_OLD),
      run(input, CATALOG_NEW),
    ]);
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`INPUT: ${input}`);
    console.log(`${'═'.repeat(78)}\n`);
    console.log(`── OLD PROMPT ──`);
    console.log(oldOut);
    console.log();
    console.log(`── NEW PROMPT (v2, production) ──`);
    console.log(newOut);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
