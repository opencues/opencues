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
const GEN = genArg === 'haiku'  ? { provider: core.getProvider('anthropic'), model: 'claude-haiku-4-5-20251001', key: process.env.ANTHROPIC_API_KEY, name: 'anthropic/haiku' }
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
    const res = await src.getCues({
      text: c.s, words: c.s.split(/\s+/).filter(Boolean), cursor: c.s.length,
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
  let j = {};
  try {
    const jRaw = await chat(JUDGE, JUDGE_SYS, `${ctxForJudge}SELECTION: ${c.s}\n\nASSISTANT OUTPUT:\n${outStr}`, 200);
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
    console.log(`${flag}[${r.c.ask ? 'ASK ' : 'skip'}->${r.asked ? 'asked ' : 'silent'}] q${typeof r.quality === 'number' ? r.quality : '.'}${g} | ${r.c.s.slice(0, 38).padEnd(38)} | ${r.asked ? r.q.question.slice(0, 44) : '-'}`);
  }
  console.log('-'.repeat(78));
  console.log(`FIRING (should-ask -> asked):    ${fireOnAsk}/${askTot}  (${askTot ? (100 * fireOnAsk / askTot).toFixed(0) : '-'}%)`);
  console.log(`RESTRAINT (fine text -> silent): ${silentOnNo}/${noTot}  (${noTot ? (100 * silentOnNo / noTot).toFixed(0) : '-'}%)`);
  console.log(`QUALITY (independent judge):     ${qN ? (qSum / qN).toFixed(2) : 'n/a'} / 2  (n=${qN})`);
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
console.log('');
