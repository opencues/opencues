// DETECT stage-1 hardening — the one lead the exploration matrix left alive.
//
// The matrix (explore-bench.mjs) showed: quality tracks ON-FORK, not option
// applies; and the two-stage arm's failures were all STAGE 1 — it invented
// forks on clean drafts (flagging a decision the draft itself settles) and
// missed the cross-sentence one. Where stage 1 was right, stage 2 produced the
// only q2 in the document family. So this bench attacks stage-1 accuracy with
// the two standard tools:
//
//   GROUNDING   the named sentence must appear VERBATIM in the draft, or the
//               verdict degrades to NONE (runtime-checkable — the invariant
//               class that makes session-contradiction reliable)
//   CONSENSUS   3 samples at temperature; proceed only if >=2 agree there is a
//               fork AND anchor it to the same sentence. Disagreement = NONE,
//               which implements the literature's tie-break-toward-silence.
//
// Compared against the naive single-shot detector from explore-bench on the
// same six drafts.
//
// Run: CEREBRAS_API_KEY=… node tests/benchmarks/ask-cues/detect2-bench.mjs

import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });
const GEN = { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY };

const DOCS = [
  { id: 'store-choice', fork: 'Postgres vs SQLite for the store',
    text: "I've started on the persistence layer for the sync service. We'll use Postgres for the store. Though SQLite might honestly be enough at this size, and it would drop a container from the compose file. I'll wire the migrations next and get the first table in." },
  { id: 'launch-scope', fork: 'ship the whole redesign Friday vs split it',
    text: "The dashboard redesign is basically done. We're shipping the whole thing Friday. Although the settings pages have not had a design review yet and nobody has tested the mobile layout. Marketing is expecting the announcement to go out the same morning." },
  { id: 'answered-draft', fork: null,
    text: "The new sync API is way faster than the old one. p50 dropped from 240ms to 38ms across the load test, measured over 10k requests. I'll deal with the retry logic later; until then every failure crashes loudly and pages on-call, which is what we want while it is behind the flag. Launch is the 14th, straight after the audit signs off." },
  { id: 'clean-draft', fork: null,
    text: "The cache module exports a single get/set pair. Entries expire after 60 seconds. It uses an LRU eviction policy with a 512-entry ceiling. Tests cover the eviction path and the expiry boundary. I ran the suite and all 47 tests passed." },
  { id: 'hardcoded-key', fork: 'what happens to the hardcoded key before launch',
    text: "Auth is the last piece before the beta. Just hardcode the API key for now so the demo works. Then we can get it in front of the design partners next week and see whether the flow lands at all." },
  { id: 'vague-perf', fork: 'which path to optimise / what target',
    text: "The importer is too slow on big files. We should make it a lot faster before the next release. I have not profiled it yet but the parsing loop looks suspicious. Ideally this lands in the same release as the new schema." },
];

const V1_SYSTEM = `You read a developer's draft. Name the SINGLE most load-bearing decision the draft leaves GENUINELY OPEN — raised (or implied) by the draft and not settled anywhere in it. Most drafts settle their own decisions; then the answer is NONE. A decision is NOT open if any sentence of the draft resolves it.
Output ONLY: {"decision":"<short name of the open decision>","sentence":"<the EXACT draft sentence most tied to it, verbatim>"}
Or exactly {"decision":null}.`;

const V2_SYSTEM = `You read a developer's draft and decide whether it leaves ONE decision genuinely open. Most drafts do not — reporting settled work, or settling their own loose ends, is the normal case, and then the answer is NONE.

A decision is OPEN only if BOTH hold:
(a) the draft itself raises it — a choice stated then hedged ("We'll use X. Though Y might honestly be enough.") or a plan whose obvious next fork the draft points at but never picks;
(b) NO sentence of the draft settles it. "I'll deal with X later; until then Y happens" SETTLES the interim — that is a plan, not an open fork. A number given two sentences later settles the claim above it. Settled-later is the mistake to avoid most.

Do NOT invent forks the draft never raises (error handling it doesn't mention, edge cases it doesn't touch). Absence of a topic is not an open decision.

Output ONLY: {"decision":"<short name>","sentence":"<the EXACT draft sentence the decision hangs on, copied verbatim>"}
Or exactly {"decision":null}.
If you cannot quote a verbatim sentence for it, the answer is NONE.`;

async function detect(sys, doc, temperature) {
  try {
    const raw = await core.dispatchChat(GEN.provider, http,
      { model: GEN.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: `DRAFT:\n${doc.text}` }], maxTokens: 250, temperature },
      { apiKey: GEN.key });
    const m = String(raw).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// GROUNDING: a detection whose sentence is not verbatim in the draft is NONE.
function grounded(doc, d) {
  if (!d?.decision) return null;
  if (typeof d.sentence !== 'string' || !doc.text.includes(d.sentence.trim())) return null;
  return d;
}

// CONSENSUS: >=2 of 3 grounded samples name a fork on the SAME sentence.
async function detectConsensus(doc) {
  const samples = await Promise.all([0.7, 0.7, 0.7].map((t) => detect(V2_SYSTEM, doc, t)));
  const good = samples.map((d) => grounded(doc, d)).filter(Boolean);
  if (good.length < 2) return { verdict: null, samples };
  const bySentence = new Map();
  for (const d of good) {
    const k = norm(d.sentence);
    bySentence.set(k, [...(bySentence.get(k) ?? []), d]);
  }
  const top = [...bySentence.values()].sort((a, b) => b.length - a.length)[0];
  return top.length >= 2 ? { verdict: top[0], samples } : { verdict: null, samples };
}

// v3: PROPOSE (v1, best recall) then VERIFY-SETTLED — a narrow adversarial
// check on the specific claim, with a verbatim-quote grounding invariant. The
// verifier is not asked to find forks (the job v2 fumbled); it is asked
// whether ONE named decision is settled by the draft, and must prove a
// "settled" verdict with a quote the runtime can check. Same propose/verify
// split the repo uses where it needs precision without losing recall.
const VERIFY_SYSTEM = `You are given a developer's DRAFT and ONE candidate open decision someone claims the draft leaves unresolved.
If any sentence of the draft SETTLES that decision — picks the option, gives the missing number, states the interim plan ("I'll do X later; until then Y" settles the interim) — quote that sentence.
Output ONLY: {"settled":"<the settling sentence, copied verbatim from the draft>"}
Or exactly {"settled":null} if nothing in the draft settles it.`;

async function verifySettled(doc, decision) {
  try {
    const raw = await core.dispatchChat(GEN.provider, http,
      { model: GEN.model, messages: [{ role: 'system', content: VERIFY_SYSTEM }, { role: 'user', content: `DRAFT:\n${doc.text}\n\nCANDIDATE OPEN DECISION: ${decision}` }], maxTokens: 200, temperature: 0 },
      { apiKey: GEN.key });
    const m = String(raw).match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : null;
    // Grounding: a settled verdict only counts if the quote is really in the
    // draft — an unquotable "settled" is treated as unsettled, never trusted.
    if (o && typeof o.settled === 'string' && doc.text.includes(o.settled.trim())) return true;
    return false;
  } catch { return false; }
}

const L = (...a) => process.stderr.write(a.join(' ') + '\n');
L('stage-1 detector: naive vs hardened+grounded vs hardened+grounded+consensus\n');

const score = { v1: 0, v2: 0, v2c: 0, v3: 0 };
for (const doc of DOCS) {
  const v1 = grounded(doc, await detect(V1_SYSTEM, doc, 0)) ?? null;
  const v2 = grounded(doc, await detect(V2_SYSTEM, doc, 0)) ?? null;
  const { verdict: v2c } = await detectConsensus(doc);
  let v3 = v1;
  if (v3 && await verifySettled(doc, v3.decision)) v3 = null;
  const want = doc.fork !== null;
  const ok = (v) => (v !== null) === want;
  if (ok(v1)) score.v1++;
  if (ok(v2)) score.v2++;
  if (ok(v2c)) score.v2c++;
  if (ok(v3)) score.v3++;
  L(`── ${doc.id.padEnd(14)} expected ${want ? 'FORK: ' + doc.fork : 'NONE'}`);
  L(`   v1 naive         ${ok(v1) ? '✓' : '✗'}  ${v1 ? v1.decision : 'NONE'}`);
  L(`   v2 hardened      ${ok(v2) ? '✓' : '✗'}  ${v2 ? v2.decision : 'NONE'}`);
  L(`   v2 + consensus   ${ok(v2c) ? '✓' : '✗'}  ${v2c ? v2c.decision : 'NONE'}`);
  L(`   v3 propose+verify ${ok(v3) ? '✓' : '✗'}  ${v3 ? v3.decision : 'NONE'}`);
}
L('');
L(`ACCURACY: v1 ${score.v1}/6 · v2 ${score.v2}/6 · v2+consensus ${score.v2c}/6 · v3 propose+verify ${score.v3}/6`);
process.exit(0);
