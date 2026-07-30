// INJECT + CHECK: the live path. Given a candidate utterance the user is
// about to submit, inject the open claims catalog and ask the model
// whether the candidate contradicts a stored claim.
// Usage: node check.mjs "<candidate text>"
import fs from 'node:fs';
import { chat, parseJson } from './llm.mjs';

const S = (f) => new URL(`./store/${f}`, import.meta.url);
const store = JSON.parse(fs.readFileSync(S('claims.json'), 'utf8'));
const open = store.filter(c => c.status === 'open');
const candidate = process.argv.slice(2).join(' ');
if (!candidate) { console.error('usage: check.mjs "<text>"'); process.exit(1); }

// Catalog goes in the SYSTEM message (stable prefix); candidate in USER.
const SYSTEM = `You are the live contradiction checker of a personal writing
assistant. Below is the user's CLAIMS CATALOG: things they have previously
committed to, stated, or preferred. You will receive one CANDIDATE utterance
the user is about to send.

Flag ONLY if the candidate genuinely contradicts a specific catalog claim:
opposite polarity on the same matter, a broken commitment, an incompatible
preference or fact. Do NOT flag: revisions/updates ("actually make it
Sunday" is a revision, not a contradiction), fulfillments, hedged musings,
unrelated text, or anything requiring speculative inference. A missed flag
is cheap; a wrong flag is expensive. When uncertain, stay silent.

Output ONLY JSON:
  {"verdict":"SILENCE"}  or
  {"verdict":"FLAG","claim_id":n,"quote":"<the stored claim verbatim>",
   "why":"<one short sentence>"}

CLAIMS CATALOG:
${open.map(c => `#${c.id} (${c.type}/${c.firmness}, ${c.source_ts}) ${c.claim}`).join('\n')}`;

const out = parseJson(await chat(SYSTEM, `CANDIDATE: ${candidate}`));
if (out.verdict === 'FLAG') {
  console.log(`FLAG  #${out.claim_id}: "${out.quote}"\n      why: ${out.why}`);
} else {
  console.log('SILENCE');
}
