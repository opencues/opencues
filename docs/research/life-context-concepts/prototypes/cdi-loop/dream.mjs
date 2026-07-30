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

Extraction rules:
- Preserve polarity, modality/hedging, quantifiers, amounts, names and
  dates VERBATIM inside the claim text. "I'll try" stays hedged.
- firmness: "firm" or "hedged".
- One claim per aspect; do not merge unrelated aspects.
- If a new utterance RESTATES an existing open claim, do not duplicate it.

STATE MACHINE — when a new utterance touches an existing open claim,
classify the transition explicitly. Apply the FIRST matching transition:

1. SUPERSEDED — the user revised their own position: a new deadline, a
   changed preference, a changed opinion or stance, a changed plan.
   ANY first-person stance change is a supersession, NEVER a conflict —
   people are allowed to change their mind; the newest stance is the
   operative one. Mark the old claim "superseded", create the new claim
   with "supersedes": <old id>.
2. FULFILLED — the user reports having done a committed thing. Mark the
   commitment "closed" AND create a NEW past-tense fact claim recording
   the event (e.g. "I rebased the apple-notes PR on <date>"). Closing a
   commitment must never delete the fact that it happened.
3. WITHDRAWN — the user cancels or releases a commitment without doing
   it ("skip it", "forget the 60"). Mark it "withdrawn". Do not create
   a new claim. A withdrawal is a legitimate change of mind, not a
   contradiction to keep litigating.
4. CONFLICT — reserved for FACTUAL claims about the external world that
   cannot both be true and where neither reads as a deliberate revision
   (the user seems unaware of the earlier claim). Keep BOTH open, add
   "conflict": <other id> to the new claim. This should be RARE; if the
   utterance could be read as a first-person revision, prefer
   SUPERSEDED.

- Existing claims keep their ids and their order. New claims get ids
  continuing from the given next_id, appended at the end.

Output ONLY a JSON object: {"claims": [ ...full updated store... ]}.
Each claim: {"id": n, "claim": str, "type": "commitment|preference|opinion|fact|plan",
"firmness": "firm|hedged", "source_ts": str,
"status": "open|superseded|closed|withdrawn",
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
