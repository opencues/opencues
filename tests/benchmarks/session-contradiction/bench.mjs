// session-contradiction bench — does it flag REAL contradictions with a session
// decision, and stay silent when the draft is consistent or unrelated?
//
// Generator: the real SessionContradictionSource (includes its grounding — the
//            quote must be in the buffer, the cited commitment must be on the
//            watchlist), on cerebras/gpt-oss-120b by default (--gen gemma for
//            the user's live model, --gen haiku to compare).
// Judge:     anthropic/claude-sonnet-4-6 — INDEPENDENT family, so it's not the
//            generator grading itself.
//
// Run: CEREBRAS_API_KEY=… ANTHROPIC_API_KEY=… node tests/benchmarks/session-contradiction/bench.mjs

import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const { SessionContradictionSource } = await import(path.join(R, 'packages/opencues-core/dist/contradiction/session-contradiction-source.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });

const genArg = process.argv.includes('--gen') ? process.argv[process.argv.indexOf('--gen') + 1] : '';
const GEN = genArg === 'gemma'  ? { provider: core.getProvider('cerebras'), model: 'gemma-4-31b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gemma-4-31b' }
         : genArg === 'haiku'  ? { provider: core.getProvider('anthropic'), model: 'claude-haiku-4-5-20251001', key: process.env.ANTHROPIC_API_KEY, name: 'anthropic/haiku' }
         :                       { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gpt-oss-120b' };
const JUDGE = { provider: core.getProvider('anthropic'), model: 'claude-sonnet-4-6', key: process.env.ANTHROPIC_API_KEY };

// The session's committed decisions — the watchlist every draft is checked against.
const WATCH = { summary: 'Building a cache layer for a Bun service', commitments: [
  { id: 'c1', category: 'stack', statement: 'Runtime is Bun, not Node' },
  { id: 'c2', category: 'constraint', statement: 'Do not add new npm dependencies' },
  { id: 'c3', category: 'scope', statement: 'Only touching the cache module this session' },
  { id: 'c4', category: 'memory', statement: 'Keep the running plan in CLAUDE.md, not chat' },
  { id: 'c5', category: 'decision', statement: 'Ship the feature behind an off-by-default flag first' },
] };

// flag=true → the draft genuinely goes AGAINST a commitment (should fire ⚠).
// flag=false → consistent-with, agrees-with, or unrelated (should stay silent) —
// the agrees-with ones (mentions the topic but aligns) are the precision traps.
const CASES = [
  // — should flag —
  { s: 'ok now switch the cache over to node', flag: true },
  { s: "let's add the redis npm package for caching", flag: true },
  { s: 'pull in lodash for the util helpers', flag: true },
  { s: "while I'm here let me also refactor the auth module", flag: true },
  { s: "we'll just keep the running plan here in the chat", flag: true },
  { s: 'ship it on by default for everyone', flag: true },
  { s: 'install express for the little status server', flag: true },
  { s: 'expand this to the billing module too', flag: true },
  { s: 'rewrite the cache to run on plain Node instead', flag: true },
  // — should stay silent (consistent / agrees / unrelated) —
  { s: 'store the cache entries in a plain Map', flag: false },     // consistent (no dep, on-scope)
  { s: 'use an LRU eviction policy for the cache', flag: false },   // consistent
  { s: "keep the running plan updated in CLAUDE.md", flag: false }, // AGREES with c4 (trap)
  { s: 'use Bun\'s built-in test runner for this', flag: false },   // AGREES with c1 (trap)
  { s: 'ship it behind the off-by-default flag as planned', flag: false }, // AGREES with c5 (trap)
  { s: "let's write unit tests for the eviction logic", flag: false }, // unrelated, on-scope
  { s: 'the cache should be a bit faster on reads', flag: false },  // vague, no contradiction
  { s: 'commit this and open a PR when ready', flag: false },       // unrelated
  { s: 'add a doc comment explaining the cache keys', flag: false },// unrelated, on-scope
];

const JUDGE_SYS = `You evaluate a "contradiction cue": it watches a developer's SESSION DECISIONS and flags a draft sentence that goes AGAINST one of them (e.g. adds a dependency after "no new deps", switches a chosen runtime, touches an out-of-scope module). It must stay silent when the draft is consistent with, AGREES with, or is unrelated to the decisions. A false alarm is worse than a miss.

You are given the DECISIONS, a DRAFT, and the cue's OUTPUT (a flag with the decision it claims is contradicted, or NO-FLAG).
Return ONLY JSON: {"shouldFlag": <true|false>, "flagIsCorrect": <true|false|null>, "reason": "<up to 14 words>"}
- shouldFlag: judging DECISIONS vs DRAFT yourself, does the draft genuinely contradict a listed decision?
- flagIsCorrect: if the cue FLAGGED, is it a real contradiction of a real listed decision (not a false alarm / not misreading agreement as contradiction)? NO-FLAG → null.`;

async function chat(who, sys, user, maxTokens) {
  return core.dispatchChat(who.provider, http,
    { model: who.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens },
    { apiKey: who.key });
}
function parseObj(raw) { const m = String(raw).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}
const decisionsText = WATCH.commitments.map(c => `- ${c.statement}`).join('\n');

const src = new SessionContradictionSource({ httpAdapter: http, provider: GEN.provider, model: GEN.model, apiKey: GEN.key, log: () => {} });

console.log(`\nsession-contradiction bench — generator ${GEN.name}, judge anthropic/${JUDGE.model}\n${'='.repeat(80)}`);
const rows = await mapLimit(CASES, 4, async (c) => {
  const res = await src.getCues({ text: c.s, words: c.s.split(/\s+/).filter(Boolean), sessionCommitments: WATCH });
  const flagged = res.results.length > 0;
  const tip = flagged ? res.results[0].cueTip : 'NO-FLAG';
  const out = flagged ? `FLAGGED: ${tip}` : 'NO-FLAG';
  const jRaw = await chat(JUDGE, JUDGE_SYS, `DECISIONS:\n${decisionsText}\n\nDRAFT: ${c.s}\n\nCUE OUTPUT: ${out}`, 200);
  const j = parseObj(jRaw) || {};
  return { c, flagged, tip, jShould: !!j.shouldFlag, correct: j.flagIsCorrect, reason: j.reason };
});

let recallHit = 0, silentHit = 0, fpFlag = 0, judgeAgree = 0, correctFlags = 0, flagN = 0;
const flagTot = CASES.filter(c => c.flag).length, silentTot = CASES.length - flagTot;
for (const r of rows) {
  if (r.c.flag && r.flagged) recallHit++;
  if (!r.c.flag && !r.flagged) silentHit++;
  if (!r.c.flag && r.flagged) fpFlag++;
  if (r.flagged) { flagN++; if (r.correct) correctFlags++; }
  if (r.jShould === r.c.flag) judgeAgree++;
  const mark = (r.c.flag === r.flagged) ? '  ' : '! ';
  console.log(`${mark}[${r.c.flag ? 'FLAG' : 'skip'}->${r.flagged ? 'flagged' : 'silent '}]${r.flagged ? (r.correct ? ' ✓real' : ' ✗false') : '      '} | ${r.c.s.slice(0, 44).padEnd(44)} | ${r.flagged ? r.tip.slice(0, 30) : '-'}`);
}
console.log('-'.repeat(80));
console.log(`RECALL (real contradiction -> flagged):  ${recallHit}/${flagTot}  (${(100 * recallHit / flagTot).toFixed(0)}%)`);
console.log(`RESTRAINT (consistent/unrelated -> silent): ${silentHit}/${silentTot}  (${(100 * silentHit / silentTot).toFixed(0)}%)   [false alarms: ${fpFlag}]`);
console.log(`PRECISION (independent judge: of flags, how many REAL): ${flagN ? `${correctFlags}/${flagN}  (${(100 * correctFlags / flagN).toFixed(0)}%)` : 'n/a'}`);
console.log(`JUDGE agrees with my flag/skip labels:   ${judgeAgree}/${CASES.length}  (${(100 * judgeAgree / CASES.length).toFixed(0)}%)`);
console.log('');
