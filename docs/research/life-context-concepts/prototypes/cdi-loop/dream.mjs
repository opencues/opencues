// DREAM: consolidate new raw utterances into the claims store.
// Incremental: only utterances past the cursor are fed in, plus the
// existing store. Usage: node dream.mjs
import fs from 'node:fs';
import { chat, parseJson } from './llm.mjs';

const S = (f) => new URL(`./store/${f}`, import.meta.url);
const raw = fs.existsSync(S('raw.jsonl'))
  ? fs.readFileSync(S('raw.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
const meta = fs.existsSync(S('meta.json')) ? JSON.parse(fs.readFileSync(S('meta.json'), 'utf8')) : { cursor: 0, nextId: 1 };
const store = fs.existsSync(S('claims.json')) ? JSON.parse(fs.readFileSync(S('claims.json'), 'utf8')) : [];

const fresh = raw.slice(meta.cursor);
if (!fresh.length) { console.log('nothing to dream'); process.exit(0); }

const SYSTEM = `You are the DREAM pass of a personal contradiction tracker.
You receive (a) the user's existing CLAIMS STORE and (b) NEW utterances
the user has submitted since the last pass. Consolidate.

Extract only CONTRADICTABLE aspects from the new utterances: commitments
(promises, plans with intent), preferences, opinions, self-facts, and
factual claims. Skip questions, smalltalk, and anything with no future
contradiction potential.

Rules:
- Preserve polarity, modality/hedging, quantifiers, amounts, names and
  dates VERBATIM inside the claim text. "I'll try" stays hedged.
- firmness: "firm" or "hedged".
- One claim per aspect; do not merge unrelated aspects.
- If a new utterance RESTATES an existing open claim, do not duplicate it.
- If a new utterance REVISES an existing open claim (new deadline, changed
  preference), mark the old claim status "superseded" and create a new one
  with "supersedes": <old id>.
- If a new utterance reports FULFILLING or WITHDRAWING an existing claim,
  mark it status "closed" (do not create a claim for the report itself).
- If a new utterance FLATLY CONTRADICTS an existing open claim without
  revising it, keep BOTH open and add "conflict": <other id> to the new
  claim. The dream pass records conflicts; it never adjudicates them.
- Existing claims keep their ids and their order. New claims get ids
  continuing from the given next_id, appended at the end.

Output ONLY a JSON object: {"claims": [ ...full updated store... ]}.
Each claim: {"id": n, "claim": str, "type": "commitment|preference|opinion|fact|plan",
"firmness": "firm|hedged", "source_ts": str, "status": "open|superseded|closed",
"supersedes"?: n, "conflict"?: n}.`;

const user = JSON.stringify({
  claims_store: store,
  next_id: meta.nextId,
  new_utterances: fresh,
}, null, 1);

const out = parseJson(await chat(SYSTEM, user));
const claims = out.claims;
const maxId = Math.max(0, ...claims.map(c => c.id));
fs.writeFileSync(S('claims.json'), JSON.stringify(claims, null, 1));
fs.writeFileSync(S('meta.json'), JSON.stringify({ cursor: raw.length, nextId: maxId + 1 }));
console.log(`dreamed ${fresh.length} utterances -> store now ${claims.length} claims`);
for (const c of claims) console.log(`  #${c.id} [${c.status}${c.supersedes ? ' supersedes #' + c.supersedes : ''}${c.conflict ? ' CONFLICT #' + c.conflict : ''}] (${c.type}/${c.firmness}) ${c.claim}`);
