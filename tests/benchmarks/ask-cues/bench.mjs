// ask-cues bench — does the AskUserQuestion tool-prompt come up with GOOD
// questions, and does it stay quiet when the text is fine?
//
// Generator: cerebras/gpt-oss-120b (the default ask-cue provider).
// Judge:     anthropic/claude-sonnet-4-6 — INDEPENDENT model family, so it's
//            not the generator grading itself (the methodological gap Wilfred
//            flagged).
//
// Run: CEREBRAS_API_KEY=… ANTHROPIC_API_KEY=… node tests/benchmarks/ask-cues/bench.mjs
//      node tests/benchmarks/ask-cues/bench.mjs --gen haiku   # generator = Claude Haiku

import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });

// Generators. `sonnet` exists to answer one question and only one: are generic
// questions a MODEL ceiling or a PROMPT problem? Note it is also the judge, so
// read its judge-scored numbers with that in mind — the DETERMINISTIC
// "mentions context" signal is judge-free and is the fair comparison for it.
// `gemma` is the live default on this machine, so it is the number that
// actually describes what users get.
const genArg = process.argv.includes('--gen') ? process.argv[process.argv.indexOf('--gen') + 1] : '';
const GEN = genArg === 'groq'   ? { provider: core.getProvider('groq'), model: 'openai/gpt-oss-120b', key: process.env.GROQ_API_KEY, name: 'groq/gpt-oss-120b' }
          : genArg === 'haiku'  ? { provider: core.getProvider('anthropic'), model: 'claude-haiku-4-5-20251001', key: process.env.ANTHROPIC_API_KEY, name: 'anthropic/haiku' }
          : genArg === 'gemma'  ? { provider: core.getProvider('cerebras'), model: 'gemma-4-31b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gemma-4-31b' }
          : genArg === 'sonnet' ? { provider: core.getProvider('anthropic'), model: 'claude-sonnet-4-6', key: process.env.ANTHROPIC_API_KEY, name: 'anthropic/sonnet (judge-family — deterministic metric only)' }
          :                       { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gpt-oss-120b' };
const JUDGE = { provider: core.getProvider('anthropic'), model: 'claude-sonnet-4-6', key: process.env.ANTHROPIC_API_KEY };

// shouldAsk = a thoughtful editor would genuinely want to raise a question
// (vague/risky claim, ambiguity, a real decision). shouldAsk:false = the
// sentence is clear/settled and the assistant SHOULD stay silent (over-asking
// on these is the main failure mode for an ambient, every-sentence cue).
const CASES = [
  // — warrants a question —
  { s: 'The new API is way faster than the old one.', ask: true },
  { s: 'we should just delete the whole cache module and start over', ask: true },
  { s: 'make the button pop more', ask: true },
  { s: 'This will definitely work in production.', ask: true },
  { s: "Let's use the library everyone's using.", ask: true },
  { s: "I'll deal with the error handling later.", ask: true },
  { s: 'The launch is sometime next month.', ask: true },
  { s: 'We should make the app more user-friendly.', ask: true },
  { s: 'Just hardcode the API key for now.', ask: true },
  { s: 'Everyone hates the new design.', ask: true },
  { s: 'We can probably skip the tests this time.', ask: true },
  { s: 'The results were basically perfect.', ask: true },
  // — fine as-is; should stay silent —
  { s: 'The function returns the sum of two integers.', ask: false },
  { s: 'I ran the test suite and all 47 tests passed.', ask: false },
  { s: 'The config file is at ~/.cues/OPENCUES.md.', ask: false },
  { s: 'Thanks, that fixed it!', ask: false },
  { s: 'We use PostgreSQL 16 in production.', ask: false },
  { s: 'The build finished in 2.3 seconds.', ask: false },
  { s: 'Please open a PR when you are ready.', ask: false },
  { s: 'The meeting is at 3pm on Tuesday.', ask: false },
];

// A fixed session context for the context-aware cases (Phase 2). Grounding
// should sharpen questions AND silence sentences already consistent with it.
const CTX = { summary: 'Building a cache layer for a Bun service; keeping it dependency-free', commitments: [
  { id: 'c1', category: 'stack', statement: 'Runtime is Bun, standard library only' },
  { id: 'c2', category: 'constraint', statement: 'Do not add new npm dependencies' },
  { id: 'c3', category: 'scope', statement: 'Only touching the cache module this session' },
] };
// ask-cues' job is the OPEN, vague question grounded in context — NOT catching
// contradictions with the context (that's session-contradiction's cue). So the
// firing cases are vague-but-consistent sentences the context should sharpen.
// THREE grounding-eligible cases could not support a conclusion. Measured on
// identical code, the grounded score swung 0/3 → 1/3 → 0/3 and, an hour
// earlier, 1/2 → 1/3 → 1/3 — a range wide enough to "show" an improvement or a
// regression from a no-op change, which is exactly what it did to an attempt at
// tuning this prompt. A judge-scored boolean over 3 samples is a coin, not a
// measurement. Eight firing cases + four silent ones give two runs enough
// resolution to tell a real change from the noise.
const CTX_CASES = [
  { s: 'we should make the cache a lot faster', ask: true, ground: true },       // vague perf → grounds
  { s: 'the eviction logic could be better', ask: true, ground: true },          // vague → grounds
  { s: "let's make the cache more robust somehow", ask: true, ground: true },    // vague → grounds
  { s: 'we need to sort out the memory situation', ask: true, ground: true },    // vague → grounds (Bun/std-lib only)
  { s: 'the serialization approach needs work', ask: true, ground: true },       // vague → grounds (no deps)
  { s: 'we should probably add some kind of metrics', ask: true, ground: true }, // vague → grounds (scope: cache only)
  { s: 'the concurrency story here is unclear', ask: true, ground: true },       // vague → grounds
  { s: 'we need a better key strategy', ask: true, ground: true },               // vague → grounds
  { s: 'store the cache entries in a plain Map', ask: false },                   // impl detail → silent
  { s: 'the cache uses an LRU eviction policy', ask: false },                    // clear → silent
  { s: 'entries expire after 60 seconds', ask: false },                          // precise value → silent
  { s: 'the module exports a single get/set pair', ask: false },                 // clear → silent
];

// A DETERMINISTIC grounding signal, reported next to the judge's.
//
// The judge's `grounded` boolean is the honest measure of "did this question
// meaningfully use the context", but it is one subjective call per case and it
// swings hard: on IDENTICAL code, pooled scores of 5/20 and 8/23 across three
// runs each, with individual runs ranging 1/7 to 4/8. That is enough variance
// to invent an improvement or hide a regression, which is exactly what it did
// to one attempt at tuning this prompt.
//
// This check asks a narrower question with no opinion in it: does the output
// mention anything only the CONTEXT could have told it? Terms are drawn from
// the context and exclude words already in the selection (`cache`, `eviction`),
// so a question echoing the user's own sentence cannot score. Cruder than the
// judge — a question can name Bun and still be useless — but it has no
// variance, so it is the one to watch for regressions.
const CONTEXT_ONLY_TERMS = ['bun', 'npm', 'dependenc', 'standard library', 'std lib', 'stdlib', 'third-party', 'third party'];
function mentionsContext(q) {
  const hay = [q.question, ...q.options.flatMap((o) => [o.label, o.description, o.apply])]
    .filter((x) => typeof x === 'string').join(' ').toLowerCase();
  return CONTEXT_ONLY_TERMS.some((t) => hay.includes(t));
}

// PHASE 3 — the sentence sits in a DOCUMENT.
//
// Phases 1 and 2 hand over one sentence, which is what the source used to send.
// That makes half of these questions unanswerable in principle: the writer very
// often answers their own vagueness in the next line, and a cue that asks
// anyway is worse than one that says nothing. `silentBecauseDoc: true` marks
// the cases where the document ALREADY resolves the ambiguity — those are the
// ones that decide whether reading the document is worth its tokens.
const DOC_CASES = [
  // — the document answers it; asking is noise —
  { doc: "We should use the library everyone's using for schema validation. I'll go with Zod since we already depend on it for the API types.",
    target: "We should use the library everyone's using for schema validation.", ask: false, silentBecauseDoc: true },
  { doc: "The new API is way faster than the old one. p50 dropped from 240ms to 38ms across the load test, measured over 10k requests.",
    target: "The new API is way faster than the old one.", ask: false, silentBecauseDoc: true },
  { doc: "The launch is sometime next month. We are committing to the 14th, straight after the security audit signs off.",
    target: "The launch is sometime next month.", ask: false, silentBecauseDoc: true },
  { doc: "I'll deal with the error handling later. Until then every failure crashes loudly and pages on-call, which is what we want while it is behind the flag.",
    target: "I'll deal with the error handling later.", ask: false, silentBecauseDoc: true },
  // — the document does NOT answer it; the fork is genuinely open —
  { doc: "We're moving the billing module onto the new queue this week. I'll deal with the error handling later. The cutover is Friday and finance is watching the first run.",
    target: "I'll deal with the error handling later.", ask: true },
  { doc: "The results were basically perfect. Ship it Monday and we can write the post afterwards.",
    target: "The results were basically perfect.", ask: true },
  { doc: "Auth is the last piece before the beta. Just hardcode the API key for now. Then we can get the demo in front of the design partners.",
    target: "Just hardcode the API key for now.", ask: true },
  { doc: "The dashboard rewrite is nearly done. We should make the app more user-friendly. Design has not looked at it since the first sketch.",
    target: "We should make the app more user-friendly.", ask: true },
];

// PHASE 4 — the WHOLE DRAFT, which is the unit the user actually experiences.
//
// Phases 1-3 ask "given this sentence, is the question good?". That cannot
// compare a per-sentence trigger against a per-draft one, and per-draft is the
// change being considered: today the source fires on EVERY sentence, because
// the sentence is a stand-in for a selection no host wires, and because each
// option's `apply` must replace a span. So the unit of the QUESTION is welded
// to the unit of the EDIT.
//
// This phase walks the cursor through a draft sentence by sentence, exactly as
// a writer does, and collects everything the user would be shown across the
// whole piece. The metrics are what a person would actually notice: how many
// times was I interrupted, and how many of those were worth it.
//
// ONE source instance per draft, so the production cache behaves as it does in
// a real session rather than being reset per sentence.
const DRAFTS = [
  { name: 'PR description', text:
    "This PR moves the cache onto the new queue. The new API is way faster than the old one. " +
    "I'll deal with the error handling later. We should probably add some kind of metrics. " +
    "Ship it Monday." },
  { name: 'design note', text:
    "We need to pick a store for the session data. Let's use the library everyone's using. " +
    "It should be fast enough for now. The launch is sometime next month. " +
    "I'll write the migration once that's settled." },
  { name: 'message to a colleague', text:
    "Thanks for the review! I fixed the two things you flagged. " +
    "The results were basically perfect after that. Just hardcode the API key for now so we can demo. " +
    "We can probably skip the tests this time." },
];

// The SAME three themes at realistic document length. The short versions above
// are 5 sentences; a real PR description, design note or message is 20-30. Two
// things only show up at this length:
//
//   1. A per-sentence trigger scales its interruptions with the DOCUMENT, not
//      with the number of real decisions in it. Whatever the short version
//      costs, multiply it.
//   2. `renderDocumentWindow` is bounded (1200 chars). In a long body the
//      sentence that ANSWERS a question can fall outside the window, so the
//      "stay silent, the draft already answers it" property may quietly stop
//      working at exactly the lengths people actually write.
//
// The load-bearing sentences from the short drafts are kept VERBATIM so the two
// lengths are comparable.
const LONG_DRAFTS = [
  { name: 'PR description (full)', text:
    "This PR moves the session cache off the in-process map and onto the new queue. " +
    "The motivation is the incident last Thursday, where a single node held stale entries for forty minutes after a deploy. " +
    "Reviewers should start with the queue adapter, which is the only genuinely new code here. " +
    "Everything under lib/cache is a move with the imports rewritten. " +
    "The new API is way faster than the old one. " +
    "p50 on the read path went from 240ms to 38ms across the load test, measured over 10k requests on the staging box. " +
    "Writes are unchanged and still go through the same validation. " +
    "I kept the old interface intact so nothing downstream needs touching in this PR. " +
    "There is a compatibility shim in lib/cache/legacy.ts that we can delete once the billing service migrates. " +
    "I'll deal with the error handling later. " +
    "We should probably add some kind of metrics. " +
    "The test suite covers the adapter and the shim, though not the failure paths yet. " +
    "I have not touched the deploy config; that lands in a follow-up once we agree the rollout order. " +
    "Ship it Monday." },
  { name: 'design note (full)', text:
    "We need to pick a store for the session data before the beta. " +
    "Right now everything lives in memory, which is fine for one node and wrong for three. " +
    "The access pattern is read-heavy: roughly fifty reads per write, with the write always coming from the auth path. " +
    "Sessions expire after twelve hours and we never need to query across them. " +
    "So the requirements are modest, and almost anything would work technically. " +
    "Let's use the library everyone's using. " +
    "It should be fast enough for now. " +
    "The operational cost matters more than the raw latency here, since nobody is paged for a 5ms difference. " +
    "We already run Postgres for the main application data, so an extra table there costs us no new infrastructure. " +
    "The launch is sometime next month. " +
    "I'll write the migration once that's settled. " +
    "If we do go with a separate store, someone needs to own its backups, and that is not currently anyone's job." },
  { name: 'message to a colleague (full)', text:
    "Thanks for the review! " +
    "I fixed the two things you flagged, and pulled the retry logic out into its own function while I was in there. " +
    "The nested version was genuinely hard to follow and you were right to call it out. " +
    "I also added the test case you suggested for the empty-response path. " +
    "The results were basically perfect after that. " +
    "One thing I did not do: the config refactor you mentioned at the end. " +
    "It touches the deploy path and I would rather not put that in the same PR as a behaviour change. " +
    "Just hardcode the API key for now so we can demo. " +
    "We can probably skip the tests this time. " +
    "The demo is Thursday and design partners are in the room, so I care more about it working than about it being tidy. " +
    "Happy to do a proper pass next week if you think that is the wrong call." },
];

const JUDGE_SYS = `You are a strict writing editor evaluating an assistant that attaches an OPTIONAL inline question to a sentence a user is writing. It should raise a question ONLY for a genuine, useful fork — a vague/risky claim, an ambiguity, a real decision, or a tension with what the developer already decided (SESSION CONTEXT) — and STAY SILENT when the sentence is clear/fine or already consistent with the context. Over-asking is a failure.

You get optional SESSION CONTEXT, a SELECTION, and the assistant's OUTPUT (a question with options, or ABSTAINED).
Return ONLY JSON: {"warranted": <true|false>, "quality": <0|1|2|null>, "grounded": <true|false|null>, "reason": "<up to 14 words>"}
- warranted: given the context (if any), would a thoughtful editor genuinely want a question here?
- quality: if asked — 0 = forced/rhetorical/options not distinct or wrong, 1 = ok, 2 = genuinely useful. ABSTAINED -> null.
- grounded: if SESSION CONTEXT was provided AND the assistant asked, did the question meaningfully USE the context (specific to their project, or caught a tension with a decision)? No context, or abstained -> null.`;

async function chat(who, sys, user, maxTokens) {
  const raw = await core.dispatchChat(who.provider, http,
    { model: who.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens },
    { apiKey: who.key });
  return raw;
}
function parseObj(raw) { const m = String(raw).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}

async function evalCase(c, snap) {
  // Drive the REAL ToolPromptCueSource, not a copy of what it is believed to do.
  //
  // This used to rebuild the call by hand — `chat(GEN, SYSTEM + ctxBlock,
  // "SELECTION: …")` — which pinned the context into the SYSTEM message
  // forever, independent of the source. When the source moved grounding to the
  // USER message, the bench went on measuring the old placement, and an A/B of
  // the two placements returned two indistinguishable arms because it had been
  // running the SAME configuration twice. A bench that reimplements its subject
  // measures the reimplementation.
  const src = new core.ToolPromptCueSource({
    httpAdapter: http, provider: GEN.provider, model: GEN.model, apiKey: GEN.key,
  });
  let q = null;
  try {
    // A doc case sends the whole document with the cursor inside the target
    // sentence — the shape the real host produces. A plain case is its own
    // document, exactly as before.
    const text = c.doc ?? c.s;
    const at = c.doc ? c.doc.indexOf(c.target) + Math.max(1, Math.floor(c.target.length / 2)) : c.s.length;
    const res = await src.getCues({
      text, words: text.split(/\s+/).filter(Boolean), cursor: at,
      ...(snap ? { sessionCommitments: snap } : {}),
    });
    q = res.results[0]?.metadata?.toolQuestion ?? null;
  } catch (e) {
    // A transient provider error (anthropic "Overloaded") used to kill the whole
    // run on the first case and print an empty report — five runs lost to it in
    // one sitting, each looking like a result rather than an outage. Count it
    // and carry on.
    return { c, asked: false, q: null, errored: true, error: String(e?.message ?? e).slice(0, 80),
             warranted: false, quality: null, grounded: null, lexical: null };
  }
  const asked = !!(q && q.question && q.options.length > 0);
  const outStr = asked ? `Q: ${q.question}\nOPTIONS: ${q.options.map(o => o.label).join(' | ')}` : 'ABSTAINED';
  const ctxForJudge = snap ? `SESSION CONTEXT:\n${core.renderSessionContextForAsk(snap).trim()}\n\n` : '';
  const docForJudge = c.doc ? `DOCUMENT:\n${c.doc}\n\n` : '';
  let j = {};
  try {
    const jRaw = await chat(JUDGE, JUDGE_SYS, `${ctxForJudge}${docForJudge}SELECTION: ${c.target ?? c.s}\n\nASSISTANT OUTPUT:\n${outStr}`, 200);
    j = parseObj(jRaw) || {};
  } catch (e) {
    // Judge unavailable: the generator's answer still stands, and the
    // DETERMINISTIC signal below needs no judge at all — so report the case
    // rather than losing it.
    j = { judgeError: String(e?.message ?? e).slice(0, 80) };
  }
  return { c, asked, q, warranted: !!j.warranted, quality: j.quality, grounded: j.grounded, reason: j.reason,
           lexical: asked ? mentionsContext(q) : null };
}

function report(title, rows, wantGround) {
  let fireOnAsk = 0, silentOnNo = 0, qSum = 0, qN = 0, agree = 0, gY = 0, gN = 0;
  const askTot = rows.filter(r => r.c.ask).length, noTot = rows.length - askTot;
  console.log(`\n${title}\n${'='.repeat(78)}`);
  for (const r of rows) {
    if (r.c.ask && r.asked) fireOnAsk++;
    if (!r.c.ask && !r.asked) silentOnNo++;
    if (r.asked && typeof r.quality === 'number') { qSum += r.quality; qN++; }
    if (r.warranted === r.c.ask) agree++;
    if (wantGround && r.c.ground && r.asked) { gN++; if (r.grounded) gY++; }
    const flag = (r.c.ask === r.asked) ? '  ' : '! ';
    const g = (wantGround && r.asked) ? (r.grounded ? ' [grounded]' : ' [generic] ') : '';
    console.log(`${flag}[${r.c.ask ? 'ASK ' : 'skip'}->${r.asked ? 'asked ' : 'silent'}] q${typeof r.quality === 'number' ? r.quality : '.'}${g} | ${(r.c.target ?? r.c.s).slice(0, 38).padEnd(38)} | ${r.asked ? r.q.question.slice(0, 44) : '-'}`);
  }
  console.log('-'.repeat(78));
  console.log(`FIRING (should-ask -> asked):    ${fireOnAsk}/${askTot}  (${askTot ? (100 * fireOnAsk / askTot).toFixed(0) : '-'}%)`);
  console.log(`RESTRAINT (fine text -> silent): ${silentOnNo}/${noTot}  (${noTot ? (100 * silentOnNo / noTot).toFixed(0) : '-'}%)`);
  console.log(`QUALITY (independent judge):     ${qN ? (qSum / qN).toFixed(2) : 'n/a'} / 2  (n=${qN})`);
  // THE HEADLINE METRIC. Of the questions the user is actually shown, how many
  // are worth the interruption (judge score 2)?
  //
  // FIRING was the de-facto target before this, and it was pulling the wrong
  // way: scoring 12/12 as success demands a question for every flagged
  // sentence, and a forced question is precisely how you get a 0 or a 1. A
  // feature that asks four times and is useful four times beats one that asks
  // twenty times and is useful four times — the second one trains you to
  // ignore it. Optimise USEFUL, read COVERAGE as the cost.
  const asked = rows.filter((r) => r.asked).length;
  const useful = rows.filter((r) => r.asked && r.quality === 2).length;
  console.log(`USEFUL (of what it showed you):  ${asked ? `${useful}/${asked}  (${(100 * useful / asked).toFixed(0)}%)` : 'n/a'}   ← the one that matters`);
  console.log(`COVERAGE (asked / should-ask):   ${askTot ? `${fireOnAsk}/${askTot}` : 'n/a'}   (low is fine IF useful is high)`);
  if (wantGround) console.log(`GROUNDED (used the context):     ${gN ? `${gY}/${gN}  (${(100 * gY / gN).toFixed(0)}%)` : 'n/a'}`);
  if (wantGround) {
    const lN = rows.filter((r) => r.c.ground && r.asked).length;
    const lY = rows.filter((r) => r.c.ground && r.asked && r.lexical).length;
    console.log(`MENTIONS CONTEXT (deterministic):  ${lN ? `${lY}/${lN}  (${(100 * lY / lN).toFixed(0)}%)` : 'n/a'}`);
  }
  console.log(`JUDGE agrees w/ my labels:       ${agree}/${rows.length}  (${(100 * agree / rows.length).toFixed(0)}%)`);
  const errs = rows.filter((r) => r.errored);
  if (errs.length) console.log(`⚠ ${errs.length}/${rows.length} case(s) FAILED to generate — treat every number above as partial: ${errs[0].error}`);
}

console.log(`\nask-cues bench — generator ${GEN.name}, judge anthropic/${JUDGE.model}`);
const isoRows = await mapLimit(CASES, 4, (c) => evalCase(c, undefined));
report('PHASE 1 — sentence alone (no session context)', isoRows, false);
const ctxRows = await mapLimit(CTX_CASES, 4, (c) => evalCase(c, CTX));
report('PHASE 2 — with SESSION CONTEXT (Bun cache, no new deps, cache-module only)', ctxRows, true);

const docRows = await mapLimit(DOC_CASES, 4, (c) => evalCase(c, undefined));
report('PHASE 3 — the sentence inside a DOCUMENT', docRows, false);
{
  // The headline for phase 3: when the document already answers the question,
  // does it hold its tongue? This is the number that says whether sending the
  // surrounding text was worth it.
  const dodgy = docRows.filter((r) => r.c.silentBecauseDoc);
  const quiet = dodgy.filter((r) => !r.asked).length;
  console.log(`SILENT WHEN THE DOC ANSWERS IT: ${quiet}/${dodgy.length}  (${dodgy.length ? (100 * quiet / dodgy.length).toFixed(0) : '-'}%)   ← the point of sending the document`);
}
console.log('');


// ── PHASE 4 — whole-draft interruption load ─────────────────────────────────
const DRAFT_JUDGE_SYS = `You judge whether an inline question was worth interrupting a writer with, GIVEN THE WHOLE DRAFT they are writing.

Return ONLY JSON: {"quality": <0|1|2>, "reason": "<up to 14 words>"}
- 2 = genuinely useful: it surfaces an open decision or a real risk the draft leaves unresolved.
- 1 = ok but skippable.
- 0 = not worth it: the draft already answers it, or it restates the sentence, or it is decoration.
Judge against the WHOLE draft, not the single sentence — a question answered anywhere in the draft is a 0.`;

async function runDraft(d) {
  // One source for the whole draft: the production cache is per-source, so a
  // fresh instance per sentence would hide any re-asking it prevents.
  const src = new core.ToolPromptCueSource({
    httpAdapter: http, provider: GEN.provider, model: GEN.model, apiKey: GEN.key,
  });
  const words = d.text.split(/\s+/).filter(Boolean);
  // Cursor lands mid-sentence, once per sentence, in writing order.
  const stops = [];
  const re = /[^.!?]+[.!?]+/g;
  let m;
  while ((m = re.exec(d.text)) !== null) stops.push(m.index + Math.floor(m[0].length / 2));

  const shown = [];
  for (const at of stops) {
    let q = null;
    try {
      const res = await src.getCues({ text: d.text, words, cursor: at });
      q = res.results[0]?.metadata?.toolQuestion ?? null;
    } catch { /* transient: counts as no question */ }
    if (q && q.question && q.options?.length) shown.push(q);
  }

  // Judge each distinct question against the whole draft.
  const judged = await mapLimit(shown, 3, async (q) => {
    try {
      const raw = await chat(JUDGE, DRAFT_JUDGE_SYS,
        `DRAFT:\n${d.text}\n\nQUESTION SHOWN:\n${q.question}\nOPTIONS: ${q.options.map((o) => o.label).join(' | ')}`, 200);
      return parseObj(raw)?.quality ?? 0;
    } catch { return 0; }
  });
  return { name: d.name, sentences: stops.length, shown: shown.length, useful: judged.filter((x) => x === 2).length, questions: shown };
}

console.log(`\nPHASE 4 — WHOLE DRAFT (what a writer actually experiences)\n${'='.repeat(78)}`);
const draftRows = [];
for (const d of DRAFTS) draftRows.push(await runDraft(d));
let tS = 0, tShown = 0, tUseful = 0;
for (const r of draftRows) {
  tS += r.sentences; tShown += r.shown; tUseful += r.useful;
  console.log(`  ${r.name.padEnd(24)} ${r.sentences} sentences -> ${r.shown} question(s) shown, ${r.useful} useful`);
  for (const q of r.questions) console.log(`      · ${q.question.slice(0, 62)}`);
}
console.log('-'.repeat(78));
console.log(`INTERRUPTIONS PER DRAFT:  ${(tShown / draftRows.length).toFixed(1)}  (across ${tS} sentences in ${draftRows.length} drafts)`);
console.log(`USEFUL PER DRAFT:         ${(tUseful / draftRows.length).toFixed(1)}`);
console.log(`NOISE (shown, not useful): ${tShown - tUseful}/${tShown}  (${tShown ? (100 * (tShown - tUseful) / tShown).toFixed(0) : '-'}%)   <- what a per-sentence trigger costs`);

// ── PHASE 4b — the same themes at full document length ─────────────────────
console.log(`\nPHASE 4b — SAME THEMES, FULL-LENGTH BODIES\n${'='.repeat(78)}`);
const longRows = [];
for (const d of LONG_DRAFTS) longRows.push(await runDraft(d));
let lS = 0, lShown = 0, lUseful = 0;
for (const r of longRows) {
  lS += r.sentences; lShown += r.shown; lUseful += r.useful;
  console.log(`  ${r.name.padEnd(28)} ${r.sentences} sentences -> ${r.shown} question(s) shown, ${r.useful} useful`);
  for (const q of r.questions) console.log(`      · ${q.question.slice(0, 62)}`);
}
console.log('-'.repeat(78));
console.log(`INTERRUPTIONS PER DRAFT:  ${(lShown / longRows.length).toFixed(1)}  (across ${lS} sentences in ${longRows.length} drafts)`);
console.log(`USEFUL PER DRAFT:         ${(lUseful / longRows.length).toFixed(1)}`);
console.log(`NOISE (shown, not useful): ${lShown - lUseful}/${lShown}  (${lShown ? (100 * (lShown - lUseful) / lShown).toFixed(0) : '-'}%)`);
console.log('');
console.log(`SCALING  short: ${tS} sentences -> ${tShown} questions (${(tShown / tS).toFixed(2)} per sentence, ${tUseful} useful)`);
console.log(`         full : ${lS} sentences -> ${lShown} questions (${(lShown / lS).toFixed(2)} per sentence, ${lUseful} useful)`);
console.log(`         If questions/sentence holds steady, interruptions scale with DOCUMENT LENGTH rather than with the number of real decisions.`);
