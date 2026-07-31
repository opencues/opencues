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
- TIME REFERENCES: never compute dates yourself. When a claim has a
  time, emit a "whenRef" field using EXACTLY this relative vocabulary
  (the runtime resolves it against the utterance timestamp):
  a day is "today" | "tonight" | "tomorrow" | "yesterday" |
  "mon".."sun" (the COMING one) | "last <mon..sun>" (the most recent
  past one) | "day <1-31>" (a stated day of the month: "the 12th" ->
  "day 12") | "YYYY-MM-DD" (only if the text states a full date);
  append a part of day when known: " am" | " pm" | " eve" |
  " HH:MM" (24h). PAST events (reports, fulfillments, things already
  done) use "today", "yesterday" or "last <weekday>" — NEVER a bare
  weekday, which always means the coming one.
  A span is "<day> .. <day>", "until <day>", "from <day>" (open
  ended), or "this month". A RECURRING schedule is "weekly
  <days> [part]" or "daily [part]" — use it for every-week classes,
  shifts, rotas, streams, standing meetings: "classes Monday and
  Wednesday 6pm" -> "weekly mon,wed 18:00", "nights Friday and
  Saturday" -> "weekly fri,sat eve", "metformin with breakfast every
  day" -> "daily am". Examples: "Saturday morning" -> "sat am",
  "Thursday 6pm" -> "thu 18:00", "the 10th to the 17th" ->
  "day 10 .. day 17", "no X until the 14th" -> "until day 14",
  "cleared from the 10th" -> "from day 10". An ALL-DAY single-day
  event uses "<day> .. <day>" (same day both sides): "coach trip all
  day on the 19th" -> "day 19 .. day 19". INFER the part of day
  from event words when clear: night/dinner/evening events -> eve,
  lunch/afternoon -> pm, breakfast/morning -> am ("quiz night on the
  14th" -> "day 14 eve"). The claim text stays verbatim. Past-fact claims created on fulfillment use whenRef
  "today" (relative to the fulfilling utterance), never words like
  "just now". Do not emit a "when" field yourself; existing claims'
  "when" fields are kept as they are.
- WHEN KIND: whenever you emit whenRef, ALSO emit "whenKind":
  "slot" (a booked presence — an appointment, session, visit, party,
  trip: the user or their people will BE there then), "window" (a
  deadline or period to get a task done within — "by Friday", "by
  the end of the month", "this week"), or "policy" (a rule or
  restriction in force over a period — a diet, a ban,
  "no X until...", "off alcohol until...", a clearance).
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
1b. PENDING SUPERSESSION — a PROPOSED revision the other party has not
   yet accepted (question form: "can we move...?", "...instead?",
   "would Sunday work?"): create the new claim with status "pending"
   and "supersedes": <old id>, but keep the OLD claim open — a
   proposal is neither the old plan nor yet the new one. When a LATER
   utterance restates or confirms the pending arrangement, promote it:
   pending -> open, old -> superseded. When a later utterance
   reasserts the old arrangement instead, mark the pending claim
   "withdrawn".
FIELD INHERITANCE — a superseding or pending claim INHERITS whatever
   it does not restate: the recipient, the subject, and the time of
   day ("same time Friday" means the old claim's time, on Friday).
   Leave inherited fields unstated; the runtime fills them from the
   claim being superseded.
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
"status": "open|pending|superseded|closed|withdrawn",
"to"?: str, "about"?: str, "whenRef"?: str,
"whenKind"?: "slot|window|policy",
"supersedes"?: n, "conflict"?: n}.`;

const user = JSON.stringify({
  claims_store: store,
  next_id: meta.nextId,
  new_utterances: fresh,
}, null, 1);

// Dream is the offline pass — it can afford a different (stronger or
// higher-effort) model than the hot-path check. Env-tunable per run.
const out = parseJson(await chat(SYSTEM, user, {
  model: process.env.CDI_DREAM_MODEL ?? 'gpt-oss-120b',
  ...(process.env.CDI_DREAM_EFFORT && { reasoningEffort: process.env.CDI_DREAM_EFFORT }),
}));
const claims = out.claims;
// Deterministic deixis: the runtime resolves whenRef against the
// utterance timestamp; the model never does calendar arithmetic.
const { resolveWhenRef, parseWhen } = await import('./temporal.mjs');
for (const c of claims) {
  if (c.whenRef && !c.when) {
    const w = resolveWhenRef(c.whenRef, c.source_ts);
    if (w) c.when = w;
    else console.warn(`  [warn] #${c.id} unresolvable whenRef "${c.whenRef}"`);
  }
}
// Deterministic field inheritance: a superseding/pending claim carries
// forward whatever it didn't restate — recipient, subject, and the
// time of day ("same time Friday" inherits the old 10:00).
for (const c of claims) {
  if (c.supersedes == null) continue;
  const old = claims.find(o => o.id === c.supersedes);
  if (!old) continue;
  if (!c.to && old.to) c.to = old.to;
  if (!c.about && old.about) c.about = old.about;
  if (!c.whenKind && old.whenKind) c.whenKind = old.whenKind;
  if (c.when && old.when) {
    const nw = parseWhen(c.when), ow = parseWhen(old.when);
    if (nw && ow && nw.start === nw.end && nw.part === 'UNKNOWN'
        && ow.start === ow.end && ow.part !== 'UNKNOWN') {
      const suffix = old.when.match(/\s+(AM|PM|EVE|\d{2}:\d{2})$/);
      if (suffix) c.when = `${c.when} ${suffix[1]}`;
    }
  }
}
const maxId = Math.max(0, ...claims.map(c => c.id));
fs.writeFileSync(S('claims.json'), JSON.stringify(claims, null, 1));
fs.writeFileSync(S('meta.json'), JSON.stringify({ cursor: raw.length, nextId: maxId + 1 }));
console.log(`dreamed ${fresh.length} utterances -> store now ${claims.length} claims`);
for (const c of claims) {
  const ctx = [c.to && `to:${c.to}`, c.about && `about:${c.about}`, c.when && `when:${c.when}${c.whenKind ? '(' + c.whenKind + ')' : ''}`].filter(Boolean).join(' ');
  console.log(`  #${c.id} [${c.status}${c.supersedes ? ' supersedes #' + c.supersedes : ''}${c.conflict ? ' CONFLICT #' + c.conflict : ''}] (${c.type}/${c.firmness}${ctx ? ' | ' + ctx : ''}) ${c.claim}`);
}
