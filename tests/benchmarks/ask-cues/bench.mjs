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

const GEN = process.argv.includes('--gen') && process.argv[process.argv.indexOf('--gen') + 1] === 'haiku'
  ? { provider: core.getProvider('anthropic'), model: 'claude-haiku-4-5-20251001', key: process.env.ANTHROPIC_API_KEY, name: 'anthropic/haiku' }
  : { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gpt-oss-120b' };
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
const CTX_CASES = [
  { s: 'we should make the cache a lot faster', ask: true, ground: true },       // vague perf → grounds
  { s: 'the eviction logic could be better', ask: true, ground: true },          // vague → grounds
  { s: "let's make the cache more robust somehow", ask: true, ground: true },    // vague → grounds
  { s: 'store the cache entries in a plain Map', ask: false },                   // impl detail → silent
  { s: 'the cache uses an LRU eviction policy', ask: false },                    // clear → silent
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
  const ctxBlock = snap ? core.renderSessionContextForAsk(snap) : '';
  const genRaw = await chat(GEN, `${core.ASK_USER_QUESTION_SYSTEM}${ctxBlock}`, `SELECTION: ${c.s}`, 500);
  const q = core.parseToolQuestion(genRaw);
  const asked = !!(q && q.question && q.options.length > 0);
  const outStr = asked ? `Q: ${q.question}\nOPTIONS: ${q.options.map(o => o.label).join(' | ')}` : 'ABSTAINED';
  const ctxForJudge = snap ? `SESSION CONTEXT:\n${core.renderSessionContextForAsk(snap).trim()}\n\n` : '';
  const jRaw = await chat(JUDGE, JUDGE_SYS, `${ctxForJudge}SELECTION: ${c.s}\n\nASSISTANT OUTPUT:\n${outStr}`, 200);
  const j = parseObj(jRaw) || {};
  return { c, asked, q, warranted: !!j.warranted, quality: j.quality, grounded: j.grounded, reason: j.reason };
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
  console.log(`JUDGE agrees w/ my labels:       ${agree}/${rows.length}  (${(100 * agree / rows.length).toFixed(0)}%)`);
}

console.log(`\nask-cues bench — generator ${GEN.name}, judge anthropic/${JUDGE.model}`);
const isoRows = await mapLimit(CASES, 4, (c) => evalCase(c, undefined));
report('PHASE 1 — sentence alone (no session context)', isoRows, false);
const ctxRows = await mapLimit(CTX_CASES, 4, (c) => evalCase(c, CTX));
report('PHASE 2 — with SESSION CONTEXT (Bun cache, no new deps, cache-module only)', ctxRows, true);
console.log('');
