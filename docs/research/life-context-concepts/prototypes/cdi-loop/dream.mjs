// DREAM: consolidate new raw utterances into the claims store.
// Incremental: only utterances past the cursor are fed in, plus the
// existing store. Usage: node dream.mjs
import fs from 'node:fs';
import { chat, parseJson } from './llm.mjs';

const S = (f) => new URL(`./${process.env.CDI_STORE ?? 'store'}/${f}`, import.meta.url);
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

CONTEXT — utterances may carry a recorded thread context ("to": the
recipient, "via": the channel). Use it; never guess it.
- A promise made in a thread is a promise TO that recipient: set the
  claim's "to" field from the thread context (or from an explicit name
  in the text, e.g. "I'll tell Dave...").
- A fact ABOUT a person (an allergy, a diet, a preference of theirs)
  gets "about": <person>. Facts about family members are contradictable
  claims and matter as much as the user's own.
- RESOLVE DEICTIC TIME: using the utterance timestamp, resolve relative
  time words to concrete dates in a "when" field. Grammar (exact):
  a single day is "YYYY-MM-DD"; when the part of day is known, append
  it — "YYYY-MM-DD AM" (morning), "YYYY-MM-DD PM" (afternoon),
  "YYYY-MM-DD EVE" (evening), or an exact time "YYYY-MM-DD HH:MM";
  a span is "YYYY-MM-DD/YYYY-MM-DD". So "Saturday morning" ->
  "2026-08-01 AM", "Saturday 10am" -> "2026-08-01 10:00", "tomorrow"
  -> the actual date, a holiday -> "2026-08-10/2026-08-17". The claim
  text stays verbatim; "when" carries the resolution. Past-fact claims
  created on fulfillment use the resolved date, never words like
  "just now".
- Recipients on different channels are DIFFERENT people unless the
  store already links them; never merge identities on a name match
  alone.

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
"to"?: str, "about"?: str, "when"?: str,
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
for (const c of claims) {
  const ctx = [c.to && `to:${c.to}`, c.about && `about:${c.about}`, c.when && `when:${c.when}`].filter(Boolean).join(' ');
  console.log(`  #${c.id} [${c.status}${c.supersedes ? ' supersedes #' + c.supersedes : ''}${c.conflict ? ' CONFLICT #' + c.conflict : ''}] (${c.type}/${c.firmness}${ctx ? ' | ' + ctx : ''}) ${c.claim}`);
}
