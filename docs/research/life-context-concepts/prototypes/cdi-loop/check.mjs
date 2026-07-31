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
import { parseWhen, overlaps, isOverdue, containsPoint, resolveWhenRef } from './temporal.mjs';

const S = (f) => new URL(`./${process.env.CDI_STORE ?? 'store'}/${f}`, import.meta.url);
const store = JSON.parse(fs.readFileSync(S('claims.json'), 'utf8'));
// An unadjudicated conflict is not stable ground truth: exclude BOTH
// sides of any conflict pair from the catalog (the both-ways nag trap).
const conflicted = new Set(store.flatMap(c => c.conflict ? [c.id, c.conflict] : []));
// Pending proposals are live context: they enter the catalog (marked),
// collide temporally, and count for typing-now — but never go overdue.
const open = store.filter(c => (c.status === 'open' || c.status === 'pending') && !conflicted.has(c.id));
const args = process.argv.slice(2);
const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const to = take('--to');
const via = take('--via');
const now = take('--ts') ?? new Date().toISOString();
const candidate = args.join(' ');
if (!candidate) { console.error('usage: check.mjs "<text>" [--to who] [--via channel] [--ts iso]'); process.exit(1); }

// ── 1. EXTRACT the candidate's time reference (small, fast call).
// The model emits a RELATIVE reference; it never computes dates.
const EXTRACT = `Identify the time reference of one utterance.
Output ONLY JSON: {"whenRef": w, "slot": s} where w uses EXACTLY this
relative vocabulary (never compute dates yourself): a day is "today" |
"tonight" | "tomorrow" | "mon".."sun" | "day <1-31>" (a stated day of
the month: "the 12th" -> "day 12") | "YYYY-MM-DD" (only if the text
states a full date); append " am" | " pm" | " eve" | " HH:MM" (24h)
when the part of day is known. A span is "<day> .. <day>",
"until <day>", "from <day>", or "this month". A recurring schedule
is "weekly <days> [part]" (e.g. "weekly mon,wed 18:00") or
"daily [part]". An all-day single-day event is "<day> .. <day>"
(same day both sides). INFER the part of day from event words when clear:
night/dinner/evening -> eve, lunch/afternoon -> pm,
breakfast/morning -> am. Use null if the utterance references no
specific time. s is true only if the utterance commits the writer
(or their family) to BE somewhere or be occupied AT that time (an
appointment, a visit, an outing, presence); s is false when the time
is merely a deadline or window to do a task within ("this week",
"by Friday"), or a report about the past.`;
// Check-side model is env-tunable for capability-ceiling experiments;
// production keeps this on the hot-path tier.
const CHECK_MODEL = process.env.CDI_CHECK_MODEL ?? 'gpt-oss-120b';
const ext = parseJson(await chat(EXTRACT, candidate, { model: CHECK_MODEL }));

// ── 2. RUNTIME temporal algebra — never the model's job.
// whenKind partitions the semantics: only SLOTS double-book; WINDOWS
// (deadlines) never collide; POLICIES (diets, bans, clearances) are
// listed as in-effect context for semantic judgement, never bookings.
const kindOf = (c) => c.whenKind ?? 'slot';
const candWhenAny = parseWhen(resolveWhenRef(ext.whenRef, now));
const candWhen = ext.slot ? candWhenAny : null;
const collisions = candWhen
  ? open.filter(c => c.when && kindOf(c) === 'slot' && overlaps(candWhen, parseWhen(c.when)))
  : [];
const policyRef = candWhenAny ?? parseWhen(now.slice(0, 10));
const policies = open.filter(c => c.when && kindOf(c) === 'policy' && overlaps(policyRef, parseWhen(c.when)));
const overdue = open.filter(c => c.status === 'open' && c.type === 'commitment' && c.when && kindOf(c) !== 'policy' && isOverdue(c.when, now));
// Slot-like commitments the user is typing DURING (focus/double-life).
// Pending excluded: an unaccepted meeting may not be happening.
const activeNow = open.filter(c => c.status === 'open' && c.when && kindOf(c) === 'slot' && containsPoint(c.when, now));
if (process.env.CDI_DEBUG) console.error(`[debug] ext=${JSON.stringify(ext)} collisions=[${collisions.map(c => '#' + c.id)}] policies=[${policies.map(c => '#' + c.id)}] activeNow=[${activeNow.map(c => '#' + c.id)}]`);

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
  revision — both SILENCE. An away-span (a trip) on the list collides
  with ANY in-person commitment elsewhere, and PROPOSING a new meeting
  inside it counts — proposing a slot you cannot hold is exactly the
  moment to flag. The list contains only BOOKED slots: deadline
  windows and policies never double-book.
- POLICIES IN EFFECT: the runtime lists policy claims (diets, bans,
  restrictions, clearances) whose period covers the candidate's time.
  They are never double-bookings; use them for semantic compatibility
  (INCOMPATIBLE-FACT applies: proposing what an in-effect policy
  forbids flags that policy). A DATED policy absent from the list is
  not in force at the candidate's time; a policy without dates may
  still apply — judge it semantically.
- ALREADY-DONE: the candidate promises to do something the catalog
  records as already done. Resolution counterpart: naturally recurring
  tasks repeat — flag only when redoing makes no sense (booking the
  same flights twice), else SILENCE. Groceries and household staples
  are ALWAYS recurring: never flag re-buying them.
- INCOMPATIBLE-FACT: the candidate proposes an action DIRECTLY
  incompatible with a stored fact about a person (e.g. buying peanut
  snacks for someone with a peanut allergy). Resolution counterpart:
  mere tension or speculative inference (a venue that MIGHT not suit
  them) is SILENCE.
- PENDING PROPOSALS: a claim marked [PENDING PROPOSAL] is the user's
  own outstanding reschedule offer, not yet accepted. Reasserting the
  arrangement it replaces — as if the proposal was never made — flags
  the pending claim. Restating, confirming, or waiting on the
  proposal is SILENCE.
- TYPING-NOW: the runtime lists slot commitments the user is typing
  DURING. If the message plainly shows the user is NOT doing the
  committed thing (idle chat, gaming plans, ordering food from the
  sofa), flag that commitment. Resolution counterpart: messages
  consistent with BEING at the activity — logistics, "on my way",
  "here now", coordinating with the person the slot is with — are
  SILENCE. An empty TYPING-NOW list means no such flag is possible.

Do NOT flag: revisions/updates ("actually make it Sunday" is a
revision, not a contradiction), fulfillments, hedged musings, unrelated
text, or anything requiring speculative inference. Re-promising or
rescheduling YOUR OWN open or overdue commitment for the same purpose
is a revision, never a collision with itself. A missed flag is cheap;
a wrong flag is expensive. When uncertain, stay silent.

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
  return `#${c.id} (${c.type}/${c.firmness}, ${c.source_ts}${ctx ? ' | ' + ctx : ''})${c.status === 'pending' ? ' [PENDING PROPOSAL]' : ''} ${c.claim}`;
}).join('\n')}`;

const userMsg = `CANDIDATE (${[to && `to ${to}`, via && `via ${via}`, `at ${now}`].filter(Boolean).join(', ')}): ${candidate}
COMPUTED TEMPORAL OVERLAPS: ${collisions.length
  ? collisions.map(c => `#${c.id} (${c.when})`).join(', ')
  : 'none'}
POLICIES IN EFFECT at the candidate's time: ${policies.length
  ? policies.map(c => `#${c.id} (${c.when})`).join(', ')
  : 'none listed (dated policies only)'}
TYPING-NOW (user is typing during these committed slots): ${activeNow.length
  ? activeNow.map(c => `#${c.id} (${c.when})`).join(', ')
  : 'none'}`;

const out = parseJson(await chat(SYSTEM, userMsg, { model: CHECK_MODEL }));
if (out.verdict === 'FLAG') {
  console.log(`FLAG  #${out.claim_id}: "${out.quote}"\n      why: ${out.why}`);
} else {
  console.log('SILENCE');
}
if (overdue.length) console.log(`      (overdue, runtime-computed: ${overdue.map(c => `#${c.id} "${c.claim}" was due ${c.when}`).join('; ')})`);
