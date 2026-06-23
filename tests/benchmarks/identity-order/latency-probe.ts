/**
 * Latency probe — measure TTFT cost of the v8 prompt (sections + covers
 * + blank-context rules) vs the pre-PR baseline (rules 1-5 only).
 *
 * Both run on cerebras gpt-oss-120b with identical inputs, seeds, and
 * the same catalog data. Only the RULES block differs.
 *
 * 10 runs each per cell to smooth noise. Each call is independent —
 * prefix-cache still warms across runs of the same prompt so we report
 * both cold (first run) and warm (mean of runs 2-10).
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
FULL_REWRITE: Waves whisper to the shore, / endless rhythm, salt-bright air, / the sea holds every story.`;

const FIELDS = [
  ['[FIRST NAME]', "user's first name", 'given name, forename'],
  ['[LAST NAME]', "user's last name", 'surname, family name'],
  ['[FULL NAME]', "user's first + last name combined", 'my name, the sender, the author, signed by, sign as me'],
  ['[EMAIL]', "user's primary email address", 'my email, contact email, reach me at, email address'],
  ['[PHONE]', "user's phone number (E.164 format)", 'my phone, call me at, mobile, cell, telephone'],
  ['[PRONOUNS]', "user's preferred pronouns", 'my pronouns, they/them, she/her'],
  ['[JOB TITLE]', "user's job title", 'my role, my position, what I do, what I work as, my title'],
  ['[COMPANY]', "user's current employer", 'where I work, my employer, my team, my organisation, my org'],
  ['[WORK CITY]', "city where user works", 'based in (for work), where I work from, my office city'],
  ['[HOME CITY]', "city where user lives", 'where I live, my home town, my city'],
  ['[HOME COUNTRY]', "country where user lives", 'my country, country of residence, where I am'],
  ['[HOME POSTCODE]', "user's home postcode/ZIP", 'my postcode, my ZIP, postal code'],
  ['[GITHUB]', "user's GitHub profile URL", 'my github, github profile, code, repos'],
  ['[LINKEDIN]', "user's LinkedIn profile URL", 'my linkedin, professional profile, connect with me, find me on LI'],
  ['[TWITTER]', "user's Twitter/X handle including @", 'my twitter, my X, my handle, follow me, DM me'],
  ['[WEBSITE]', "user's personal website URL", 'my site, my homepage, my blog, my portfolio, more at'],
] as const;

const HEADER = `USER CONTEXT — tokens for the SENDER / AUTHOR / USER (the person composing this content). The runtime substitutes the real value before it reaches the user's buffer:`;

// Baseline: rules 1-5 only, no `covers:` synonyms.
const BASELINE_FIELD_LINES = FIELDS.map(([t, d]) => `- ${t} — ${d}`).join('\n');
const BASELINE_RULES = `RULES for these tokens:
1. Emit a token EXACTLY as written above (format: [UPPERCASE WORDS]) when the generated/rewritten content refers to the SENDER and a listed token fits. Do NOT use snake_case, lowercase, or invent variants.
2. Tokens describe the SENDER ONLY. For OTHER people or entities (the recipient, a counterparty, a third party), use a natural placeholder ([Recipient Name], [Date], etc.) as you would normally — DO NOT use a sender token to fill someone else's slot.
3. The list is EXHAUSTIVE for sender data. If no listed token fits a sender slot, write a natural placeholder ([Your Position]) — DO NOT invent a new sender sentinel like [USER_NAME] or [SENDER_EMAIL].
4. When the content has no sender reference (a poem, a translation, a summary of someone else's text), do NOT pull in any tokens.
5. When the user's instruction itself names a value already (e.g. "sign as Bob"), follow the instruction — do NOT override with a catalog token.`;
const BASELINE_CATALOG = `\n\n${HEADER}\n\n${BASELINE_FIELD_LINES}\n\n${BASELINE_RULES}`;

// v8: covers: hints + section-type rule 6 + rule 7 (anti-cram).
const V8_FIELD_LINES = FIELDS.map(([t, d, c]) => `- ${t} — ${d} (covers: ${c})`).join('\n');
const V8_RULES = `${BASELINE_RULES}
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
const V8_CATALOG = `\n\n${HEADER}\n\n${V8_FIELD_LINES}\n\n${V8_RULES}`;

const INPUTS = [
  'draft email _',
  'draft resignation email _',
  'draft cover letter _',
  'draft intro email _',
  'write my CV header block _',
];

const RUNS_PER_CELL = 10;

async function runCell(catalog: string, label: string) {
  const latencies: number[] = [];
  const t0 = Date.now();
  for (const input of INPUTS) {
    for (let i = 0; i < RUNS_PER_CELL; i++) {
      const r = await chat(
        sysUser(`${FUSED_SYSTEM}${catalog}`, `INPUT: ${input}`),
        { temperature: 0, seed: 42 + i, maxTokens: 800 },
      );
      latencies.push(r.latencyMs);
    }
  }
  const wallMs = Date.now() - t0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`${label.padEnd(12)}  catalog bytes=${catalog.length}  n=${latencies.length}  median=${median}ms  mean=${Math.round(mean)}ms  p95=${p95}ms  wall=${(wallMs/1000).toFixed(1)}s`);
  return { median, mean, p95 };
}

async function main() {
  console.log(`Latency probe — cerebras ${MODEL}, identity-catalog rules\n`);
  const baseline = await runCell(BASELINE_CATALOG, 'baseline');
  const v8 = await runCell(V8_CATALOG, 'v8 (prod)');
  const dMed = v8.median - baseline.median;
  const dMean = Math.round(v8.mean - baseline.mean);
  const dP95 = v8.p95 - baseline.p95;
  const pct = (n: number, b: number) => ((n / b) * 100).toFixed(1) + '%';
  console.log(`\nΔ (v8 − baseline): median=${dMed >= 0 ? '+' : ''}${dMed}ms (${pct(dMed, baseline.median)})  mean=${dMean >= 0 ? '+' : ''}${dMean}ms  p95=${dP95 >= 0 ? '+' : ''}${dP95}ms`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
