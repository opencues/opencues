// INJECT + CHECK: the live path. v4 splits temporal from semantic:
//   1. a small EXTRACT call resolves the candidate's time reference
//      (and whether it books a slot vs merely names a deadline window);
//   2. the RUNTIME computes interval overlaps against the catalog's
//      resolved "when" fields (temporal.mjs — deterministic algebra);
//   3. the JUDGE call decides only the non-temporal half, and is
//      forbidden from inferring date/time collisions itself.
// Usage: node check.mjs "<candidate text>" [--to Ana] [--via whatsapp] [--ts iso]
import fs from 'node:fs';
import { chat, parseJson } from './llm.mjs';
import { parseWhen, overlaps, isOverdue } from './temporal.mjs';

const S = (f) => new URL(`./store/${f}`, import.meta.url);
const store = JSON.parse(fs.readFileSync(S('claims.json'), 'utf8'));
// An unadjudicated conflict is not stable ground truth: exclude BOTH
// sides of any conflict pair from the catalog (the both-ways nag trap).
const conflicted = new Set(store.flatMap(c => c.conflict ? [c.id, c.conflict] : []));
const open = store.filter(c => c.status === 'open' && !conflicted.has(c.id));
const args = process.argv.slice(2);
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const to = take('--to');
const via = take('--via');
const now = take('--ts') ?? new Date().toISOString();
const candidate = args.join(' ');
if (!candidate) { console.error('usage: check.mjs "<text>" [--to who] [--via channel] [--ts iso]'); process.exit(1); }

// ── 1. EXTRACT the candidate's time reference (small, fast call).
const EXTRACT = `Resolve the time reference of one utterance. Now is ${now}.
Output ONLY JSON: {"when": w, "slot": s} where w is the utterance's
resolved time using exactly this grammar — "YYYY-MM-DD",
"YYYY-MM-DD AM" (morning), "YYYY-MM-DD PM" (afternoon),
"YYYY-MM-DD EVE" (evening), "YYYY-MM-DD HH:MM", or a span
"YYYY-MM-DD/YYYY-MM-DD" — or null if the utterance references no
specific time. s is true only if the utterance commits the writer (or
their family) to BE somewhere or be occupied AT that time (an
appointment, a visit, an outing, presence); s is false when the time
is merely a deadline or window to do a task within ("this week",
"by Friday"), or a report about the past.`;
const ext = parseJson(await chat(EXTRACT, candidate));

// ── 2. RUNTIME temporal algebra — never the model's job.
const candWhen = ext.slot ? parseWhen(ext.when) : null;
const collisions = candWhen
  ? open.filter(c => c.when && overlaps(candWhen, parseWhen(c.when)))
  : [];
const overdue = open.filter(c => c.type === 'commitment' && c.when && isOverdue(c.when, now));

// ── 3. JUDGE — catalog in the SYSTEM message (stable prefix); candidate
// + computed overlaps in USER.
const SYSTEM = `You are the live contradiction checker of a personal writing
assistant. Below is the user's CLAIMS CATALOG: things they have previously
committed to, stated, or preferred — each with who it was promised to
("to"), who it concerns ("about"), and resolved dates ("when") where
known. You will receive one CANDIDATE utterance the user is about to
send, with its thread context and a COMPUTED TEMPORAL OVERLAPS list.

Flag ONLY on a genuine collision with a specific catalog claim:
- CONTRADICTION: opposite polarity on the same matter, a broken
  commitment, an incompatible preference or fact.
- DOUBLE-BOOKING: temporal collision detection has ALREADY been done by
  deterministic date arithmetic — the result is the COMPUTED TEMPORAL
  OVERLAPS list. NEVER infer date or time collisions yourself; claims
  absent from that list do NOT collide in time, whatever their dates
  look like. For claims ON the list, you judge only the non-temporal
  half: a DIFFERENT person or purpose is a double-booking; the SAME
  person and purpose is a restatement, and an explicit reschedule is a
  revision — both SILENCE.
- ALREADY-DONE: the candidate promises to do something the catalog
  records as already done. Resolution counterpart: naturally recurring
  tasks (shopping, school runs) repeat — flag only when redoing makes
  no sense (booking the same flights twice), else SILENCE.
- INCOMPATIBLE-FACT: the candidate proposes an action DIRECTLY
  incompatible with a stored fact about a person (e.g. buying peanut
  snacks for someone with a peanut allergy). Resolution counterpart:
  mere tension or speculative inference (a venue that MIGHT not suit
  them) is SILENCE.

Do NOT flag: revisions/updates ("actually make it Sunday" is a
revision, not a contradiction), fulfillments, hedged musings, unrelated
text, or anything requiring speculative inference. A missed flag is
cheap; a wrong flag is expensive. When uncertain, stay silent.

Firmness matters. A claim marked "hedged" was a tentative statement
("I think...", "I might..."): flag it ONLY on a direct polarity flip on
the same matter, never on mere tension. DECIDING a hedged intention
either way is a RESOLUTION of the maybe, not a contradiction — "I might
do X" is never contradicted by "I've decided against X" or "I'll do X";
it is contradicted only by denying the hedged statement was made or by
asserting the past differently. When you do flag a hedged claim, the
"why" sentence MUST carry the hedge (e.g. "you said you THOUGHT the
tracker should ship first"). Firm claims flag normally.

Output ONLY JSON:
  {"verdict":"SILENCE"}  or
  {"verdict":"FLAG","claim_id":n,"quote":"<the stored claim verbatim>",
   "why":"<one short sentence>"}

CLAIMS CATALOG:
${open.map(c => {
  const ctx = [c.to && `to ${c.to}`, c.about && `about ${c.about}`, c.when && `when ${c.when}`].filter(Boolean).join(', ');
  return `#${c.id} (${c.type}/${c.firmness}, ${c.source_ts}${ctx ? ' | ' + ctx : ''}) ${c.claim}`;
}).join('\n')}`;

const userMsg = `CANDIDATE (${[to && `to ${to}`, via && `via ${via}`, `at ${now}`].filter(Boolean).join(', ')}): ${candidate}
COMPUTED TEMPORAL OVERLAPS: ${collisions.length
  ? collisions.map(c => `#${c.id} (${c.when})`).join(', ')
  : 'none'}`;

const out = parseJson(await chat(SYSTEM, userMsg));
if (out.verdict === 'FLAG') {
  console.log(`FLAG  #${out.claim_id}: "${out.quote}"\n      why: ${out.why}`);
} else {
  console.log('SILENCE');
}
if (overdue.length) console.log(`      (overdue, runtime-computed: ${overdue.map(c => `#${c.id} "${c.claim}" was due ${c.when}`).join('; ')})`);
