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

const JUDGE_SYS = `You are a strict writing editor evaluating an assistant that attaches an OPTIONAL inline question to a sentence a user is writing. The assistant should raise a question ONLY when there is a genuine, useful fork — a vague or risky claim, an ambiguity, or a real decision the sentence implies — and should STAY SILENT when the sentence is clear and fine as-is. Over-asking is a failure.

You are given a SELECTION and the assistant's OUTPUT (either a question with options, or ABSTAINED).
Return ONLY JSON: {"warranted": <true|false>, "quality": <0|1|2|null>, "reason": "<≤14 words>"}
- warranted: judging the SELECTION on its own, would a thoughtful editor genuinely want to raise a question here?
- quality: if the assistant asked, rate the question — 0 = forced/rhetorical/options not distinct or wrong, 1 = ok, 2 = genuinely useful (real fork, distinct sensible options, sound recommended-first). If it ABSTAINED, quality = null.`;

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

console.log(`\nask-cues bench — generator ${GEN.name}, judge anthropic/${JUDGE.model}\n${'='.repeat(78)}`);
const rows = await mapLimit(CASES, 4, async (c) => {
  const genRaw = await chat(GEN, core.ASK_USER_QUESTION_SYSTEM, `SELECTION: ${c.s}`, 500);
  const q = core.parseToolQuestion(genRaw);
  const asked = !!(q && q.question && q.options.length > 0);
  const outStr = asked ? `Q: ${q.question}\nOPTIONS: ${q.options.map(o => o.label).join(' | ')}` : 'ABSTAINED';
  const jRaw = await chat(JUDGE, JUDGE_SYS, `SELECTION: ${c.s}\n\nASSISTANT OUTPUT:\n${outStr}`, 200);
  const j = parseObj(jRaw) || {};
  return { c, asked, q, warranted: !!j.warranted, quality: j.quality, reason: j.reason };
});

let firedOnAsk = 0, silentOnNo = 0, qSum = 0, qN = 0, judgeAgree = 0;
const askTotal = CASES.filter(c => c.ask).length, noTotal = CASES.length - askTotal;
for (const r of rows) {
  const tag = r.c.ask ? 'ASK ' : 'skip';
  const act = r.asked ? 'asked ' : 'silent';
  if (r.c.ask && r.asked) firedOnAsk++;
  if (!r.c.ask && !r.asked) silentOnNo++;
  if (r.asked && typeof r.quality === 'number') { qSum += r.quality; qN++; }
  if (r.warranted === r.c.ask) judgeAgree++;
  const qtxt = r.asked ? (r.q.question.slice(0, 46)) : '—';
  const flag = (r.c.ask === r.asked) ? '  ' : '⚠ ';
  console.log(`${flag}[${tag}→${act}] q${typeof r.quality === 'number' ? r.quality : '·'} | ${r.c.s.slice(0, 40).padEnd(40)} | ${qtxt}`);
}
console.log('='.repeat(78));
console.log(`FIRING (recall on should-ask):   ${firedOnAsk}/${askTotal}  (${(100 * firedOnAsk / askTotal).toFixed(0)}%)`);
console.log(`RESTRAINT (silent on fine text): ${silentOnNo}/${noTotal}  (${(100 * silentOnNo / noTotal).toFixed(0)}%)`);
console.log(`QUALITY (independent judge, asked only): ${qN ? (qSum / qN).toFixed(2) : 'n/a'} / 2   (n=${qN})`);
console.log(`JUDGE agrees with my ask/skip labels:    ${judgeAgree}/${CASES.length}  (${(100 * judgeAgree / CASES.length).toFixed(0)}%)`);
console.log('');
