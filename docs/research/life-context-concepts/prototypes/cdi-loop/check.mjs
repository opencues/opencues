// INJECT + CHECK: the live path. Given a candidate utterance the user is
// about to submit, inject the open claims catalog and ask the model
// whether the candidate contradicts a stored claim.
// v3: the candidate carries its thread context (--to / --via), and the
// checker knows about double-booking, already-done, and incompatible
// third-party facts — each with its resolution counterpart stated.
// Usage: node check.mjs "<candidate text>" [--to Ana] [--via whatsapp] [--ts iso]
import fs from 'node:fs';
import { chat, parseJson } from './llm.mjs';

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

// Catalog goes in the SYSTEM message (stable prefix); candidate in USER.
const SYSTEM = `You are the live contradiction checker of a personal writing
assistant. Below is the user's CLAIMS CATALOG: things they have previously
committed to, stated, or preferred — each with who it was promised to
("to"), who it concerns ("about"), and resolved dates ("when") where
known. You will receive one CANDIDATE utterance the user is about to
send, with its own thread context (who it is addressed to, and when).

Flag ONLY on a genuine collision with a specific catalog claim:
- CONTRADICTION: opposite polarity on the same matter, a broken
  commitment, an incompatible preference or fact.
- DOUBLE-BOOKING: the candidate commits a time already committed to a
  DIFFERENT person or purpose, or falls inside a period the user has
  said they will be away. Resolution counterpart: the SAME person and
  purpose is a restatement, and an explicit reschedule is a revision —
  both SILENCE.
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

const userMsg = `CANDIDATE (${[to && `to ${to}`, via && `via ${via}`, `at ${now}`].filter(Boolean).join(', ')}): ${candidate}`;
const out = parseJson(await chat(SYSTEM, userMsg));
if (out.verdict === 'FLAG') {
  console.log(`FLAG  #${out.claim_id}: "${out.quote}"\n      why: ${out.why}`);
} else {
  console.log('SILENCE');
}
