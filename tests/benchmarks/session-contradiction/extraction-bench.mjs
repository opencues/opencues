// extraction-bench — Stage A (producer) model comparison.
//
// The realtime matcher ("cues side") is FIXED to a fast cerebras model; what
// varies is the EXTRACTION model that distils a raw coding-session transcript
// into the commitments watchlist. Answers the two questions Wilfred asked:
//   • speed  — how long to get the watchlist out of raw code context?
//   • cost   — how many tokens does that read burn?
//   • quality — does the resulting watchlist still catch contradictions?
//
// Extraction models compared (Stage A):
//   gemma   = cerebras/gemma-4-31b
//   haiku   = anthropic/claude-haiku-4-5
//   gemini  = gemini/3.6-flash-lite  (falls back to 3.5-flash-lite)
// Fixed matcher (Stage B / cues side): cerebras/gemma-4-31b  (--matcher gpt-oss to switch)
// Independent judge (bench scorer, NOT a feature model): anthropic/claude-sonnet-4-6
//
// Run: CEREBRAS_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… \
//        node tests/benchmarks/session-contradiction/extraction-bench.mjs

import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const { SessionContradictionSource } = await import(path.join(R, 'packages/opencues-core/dist/contradiction/session-contradiction-source.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 60000 });

const matcherArg = process.argv.includes('--matcher') ? process.argv[process.argv.indexOf('--matcher') + 1] : 'gemma';
const MATCHER = matcherArg === 'gpt-oss'
  ? { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gpt-oss-120b' }
  : { provider: core.getProvider('cerebras'), model: 'gemma-4-31b',  key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gemma-4-31b' };
const JUDGE = { provider: core.getProvider('anthropic'), model: 'claude-sonnet-4-6', key: process.env.ANTHROPIC_API_KEY };

// ── the 5 gold decisions the transcript embeds (recall is measured against these) ──
const GOLD = [
  { id: 'c1', category: 'stack',      statement: 'Runtime is Bun, not Node' },
  { id: 'c2', category: 'constraint', statement: 'Do not add new npm dependencies' },
  { id: 'c3', category: 'scope',      statement: 'Only touching the cache module this session' },
  { id: 'c4', category: 'memory',     statement: 'Keep the running plan in CLAUDE.md, not chat' },
  { id: 'c5', category: 'decision',   statement: 'Ship the feature behind an off-by-default flag first' },
];

// ── realistic raw session transcripts (prose turns; tool I/O is already dropped
//    by the producer, so a transcript IS user+assistant prose). The SAME 5
//    decisions are embedded in both; the LARGE one buries them in ~6× the noise
//    so the time/cost-vs-context-size effect is visible per model. ──
const DECISIONS_WOVEN = [
  { role: 'user', text: "starting on the cache layer for the api service. before we touch anything — this repo is Bun, please don't reach for Node-only APIs." },
  { role: 'assistant', text: "Understood, Bun runtime throughout. I'll use Bun's built-ins (Bun.file, the built-in test runner) rather than node: modules where I can." },
  { role: 'user', text: "good. and keep it dependency-free — I don't want any new npm packages pulled in for this, we've been burned by supply-chain stuff." },
  { role: 'assistant', text: "No new dependencies. A plain Map with a small hand-rolled LRU will cover the cache without pulling anything in." },
  { role: 'user', text: "exactly. also let's stay scoped — only the cache module this session, don't wander into auth or billing even if you spot something." },
  { role: 'assistant', text: "Scoped to the cache module only. If I notice issues elsewhere I'll note them but not touch them." },
  { role: 'user', text: "one more thing: keep the running plan in CLAUDE.md as we go, not buried in this chat — I want it to survive a compaction." },
  { role: 'assistant', text: "Will do — I'll maintain the plan and decisions in CLAUDE.md so they persist across sessions." },
  { role: 'user', text: "and when the feature's ready, ship it behind an off-by-default flag first so we can dogfood before it's on for everyone." },
  { role: 'assistant', text: "Off-by-default flag for the first ship, then flip it on once we've validated. Noted in the plan." },
];
const NOISE = [
  { role: 'user', text: "what's the current read latency roughly? the cache should shave that down." },
  { role: 'assistant', text: "Reads are ~40ms p50 hitting the store directly; an in-process cache should bring hot reads under 1ms." },
  { role: 'user', text: "let's use an LRU eviction policy, cap it around 10k entries." },
  { role: 'assistant', text: "LRU with a 10k cap. I'll track recency with a doubly-linked list over the Map so eviction is O(1)." },
  { role: 'user', text: "write some unit tests for the eviction logic too." },
  { role: 'assistant', text: "I'll add tests covering insertion, hit-promotion, capacity eviction, and TTL expiry." },
  { role: 'user', text: "how are we keying entries?" },
  { role: 'assistant', text: "Composite key of tenant id + resource path, hashed to a short string so keys stay compact." },
  { role: 'user', text: "add a doc comment explaining the key format for whoever reads it next." },
  { role: 'assistant', text: "Added a doc comment on the key builder describing the tenant+path composition and the hashing." },
  { role: 'user', text: "roughly how much memory at 10k entries?" },
  { role: 'assistant', text: "Ballpark a few MB depending on value size; the linked-list overhead is small relative to the cached payloads." },
  { role: 'user', text: "ok. remind me to benchmark before/after once it's wired." },
  { role: 'assistant', text: "I'll add a small before/after read-latency benchmark to the plan so we can quantify the win." },
];
function buildTranscript(noiseCopies) {
  const turns = [...DECISIONS_WOVEN];
  for (let i = 0; i < noiseCopies; i++) turns.push(...NOISE);
  return turns;
}
const TRANSCRIPTS = [
  { size: 'small', turns: buildTranscript(1) },
  { size: 'large', turns: buildTranscript(6) },
];

// ── 18 realtime cases (same set the matcher bench uses) ──
const CASES = [
  { s: 'ok now switch the cache over to node', flag: true },
  { s: "let's add the redis npm package for caching", flag: true },
  { s: 'pull in lodash for the util helpers', flag: true },
  { s: "while I'm here let me also refactor the auth module", flag: true },
  { s: "we'll just keep the running plan here in the chat", flag: true },
  { s: 'ship it on by default for everyone', flag: true },
  { s: 'install express for the little status server', flag: true },
  { s: 'expand this to the billing module too', flag: true },
  { s: 'rewrite the cache to run on plain Node instead', flag: true },
  { s: 'store the cache entries in a plain Map', flag: false },
  { s: 'use an LRU eviction policy for the cache', flag: false },
  { s: 'keep the running plan updated in CLAUDE.md', flag: false },
  { s: "use Bun's built-in test runner for this", flag: false },
  { s: 'ship it behind the off-by-default flag as planned', flag: false },
  { s: "let's write unit tests for the eviction logic", flag: false },
  { s: 'the cache should be a bit faster on reads', flag: false },
  { s: 'commit this and open a PR when ready', flag: false },
  { s: 'add a doc comment explaining the cache keys', flag: false },
];

// ── model roster (extraction side) ──
async function pickGemini() {
  for (const m of ['gemini-3.6-flash-lite', 'gemini-3.5-flash-lite']) {
    try {
      const w = core.buildProviderRequest('gemini', { messages: [{ role: 'user', content: 'ping' }], model: m, maxTokens: 4 }, { apiKey: process.env.GEMINI_API_KEY });
      const r = await fetch(w.url, { method: 'POST', headers: w.headers, body: typeof w.body === 'string' ? w.body : JSON.stringify(w.body) });
      if (r.ok) return m;
    } catch { /* try next */ }
  }
  return 'gemini-3.5-flash-lite';
}
const GEMINI_MODEL = await pickGemini();
const EXTRACTORS = [
  { name: 'gemma  (cerebras/gemma-4-31b)', provider: core.getProvider('cerebras'), model: 'gemma-4-31b', key: process.env.CEREBRAS_API_KEY, pid: 'cerebras' },
  { name: `haiku  (anthropic/claude-haiku-4-5)`, provider: core.getProvider('anthropic'), model: 'claude-haiku-4-5-20251001', key: process.env.ANTHROPIC_API_KEY, pid: 'anthropic' },
  { name: `gemini (gemini/${GEMINI_MODEL})`, provider: core.getProvider('gemini'), model: GEMINI_MODEL, key: process.env.GEMINI_API_KEY, pid: 'gemini' },
];

function usageOf(pid, rawJson) {
  try {
    const j = JSON.parse(rawJson);
    if (pid === 'anthropic') return { in: j.usage?.input_tokens ?? 0, out: j.usage?.output_tokens ?? 0 };
    if (pid === 'gemini') return { in: j.usageMetadata?.promptTokenCount ?? 0, out: j.usageMetadata?.candidatesTokenCount ?? 0 };
    return { in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0 };  // openai-compatible (cerebras)
  } catch { return { in: 0, out: 0 }; }
}

// One extraction call — returns { snapshot, ms, tokIn, tokOut }.
async function extract(ex, turns) {
  const transcriptText = core.renderTranscriptForExtraction(turns);
  const wire = core.buildProviderRequest(ex.pid, {
    messages: [
      { role: 'system', content: core.SESSION_COMMITMENTS_EXTRACT_SYSTEM },
      { role: 'user', content: `TRANSCRIPT:\n${transcriptText}` },
    ],
    model: ex.model, maxTokens: 1024,
  }, { apiKey: ex.key });
  const t0 = performance.now();
  const resp = await fetch(wire.url, { method: 'POST', headers: wire.headers, body: typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body) });
  const bodyText = await resp.text();
  const ms = performance.now() - t0;
  if (!resp.ok) return { snapshot: null, ms, tokIn: 0, tokOut: 0, err: `http ${resp.status}: ${bodyText.slice(0, 120)}` };
  const content = core.parseProviderResponse(ex.pid, bodyText);
  const ext = core.parseExtractionResult(content);
  const snapshot = core.buildSessionCommitmentsSnapshot(ext.commitments, { summary: ext.summary });
  const u = usageOf(ex.pid, bodyText);
  return { snapshot, ms, tokIn: u.in, tokOut: u.out };
}

async function chat(who, sys, user, maxTokens) {
  return core.dispatchChat(who.provider, http, { model: who.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens }, { apiKey: who.key });
}
function parseObj(raw) { const m = String(raw).match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}

// Independent judge: which of the 5 GOLD decisions are represented in the extracted watchlist?
const RECALL_SYS = `You check whether each of a set of GOLD decisions is represented (in meaning, not wording) anywhere in an EXTRACTED list of session commitments. Return ONLY a JSON array of booleans, one per gold decision in order.`;
async function goldRecall(snapshot) {
  const extracted = (snapshot?.commitments || []).map(c => `- ${c.statement}`).join('\n') || '(none)';
  const goldText = GOLD.map((g, i) => `${i + 1}. ${g.statement}`).join('\n');
  const raw = await chat(JUDGE, RECALL_SYS, `GOLD:\n${goldText}\n\nEXTRACTED:\n${extracted}`, 100);
  const arr = parseObj(raw);
  return Array.isArray(arr) ? GOLD.map((_, i) => !!arr[i]) : GOLD.map(() => false);
}

// End-to-end: run the FIXED matcher over the 18 cases using a given watchlist.
async function e2e(watch) {
  const src = new SessionContradictionSource({ httpAdapter: http, provider: MATCHER.provider, model: MATCHER.model, apiKey: MATCHER.key, log: () => {} });
  const rows = await mapLimit(CASES, 4, async (c) => {
    const res = await src.getCues({ text: c.s, words: c.s.split(/\s+/).filter(Boolean), sessionCommitments: watch });
    return { flag: c.flag, flagged: res.results.length > 0 };
  });
  const flagTot = CASES.filter(c => c.flag).length, silentTot = CASES.length - flagTot;
  let recall = 0, silent = 0;
  for (const r of rows) { if (r.flag && r.flagged) recall++; if (!r.flag && !r.flagged) silent++; }
  return { recall, flagTot, silent, silentTot, acc: recall + silent, tot: CASES.length };
}

// ── run ──
console.log(`\nextraction-bench — fixed matcher ${MATCHER.name}, judge anthropic/${JUDGE.model}`);
console.log(`gemini model resolved to: ${GEMINI_MODEL}`);
console.log('='.repeat(92));

const results = [];
for (const ex of EXTRACTORS) {
  const perSize = {};
  for (const tr of TRANSCRIPTS) {
    // 3 runs → median time (gpt-oss/gemma non-deterministic; network jitter)
    const runs = [];
    for (let k = 0; k < 3; k++) runs.push(await extract(ex, tr.turns));
    const ok = runs.filter(r => r.snapshot);
    if (ok.length === 0) { perSize[tr.size] = { err: runs[0].err }; continue; }
    const times = ok.map(r => r.ms).sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)];
    const best = ok[runs.indexOf(ok.reduce((a, b) => (Math.abs(a.ms - med) <= Math.abs(b.ms - med) ? a : b)))] || ok[0];
    const recallArr = await goldRecall(best.snapshot);
    perSize[tr.size] = { ms: med, tokIn: best.tokIn, tokOut: best.tokOut, nCommit: best.snapshot.commitments.length, recall: recallArr.filter(Boolean).length, best };
  }
  // end-to-end on the LARGE watchlist (the realistic case)
  const large = perSize.large;
  let e2eRes = null;
  if (large && large.best) e2eRes = await e2e({ summary: large.best.snapshot.summary, commitments: large.best.snapshot.commitments });
  results.push({ ex, perSize, e2e: e2eRes });
}

// ── report ──
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log(`\n${pad('EXTRACTION MODEL', 34)} ${pad('size', 6)} ${padL('time(ms)', 9)} ${padL('tok_in', 7)} ${padL('tok_out', 7)} ${padL('#cmt', 5)} ${padL('gold', 5)}`);
console.log('-'.repeat(92));
for (const res of results) {
  for (const size of ['small', 'large']) {
    const p = res.perSize[size];
    const nm = size === 'small' ? res.ex.name : '';
    if (!p || p.err) { console.log(`${pad(nm, 34)} ${pad(size, 6)}  ERR ${p?.err || ''}`); continue; }
    console.log(`${pad(nm, 34)} ${pad(size, 6)} ${padL(p.ms.toFixed(0), 9)} ${padL(p.tokIn, 7)} ${padL(p.tokOut, 7)} ${padL(p.nCommit, 5)} ${padL(p.recall + '/5', 5)}`);
  }
}
console.log('\nEND-TO-END accuracy on 18 realtime cases (large-transcript watchlist → fixed matcher):');
console.log(`${pad('EXTRACTION MODEL', 34)} ${padL('flag-recall', 12)} ${padL('restraint', 11)} ${padL('overall', 9)}`);
console.log('-'.repeat(92));
for (const res of results) {
  const e = res.e2e;
  if (!e) { console.log(`${pad(res.ex.name, 34)}  (no watchlist)`); continue; }
  console.log(`${pad(res.ex.name, 34)} ${padL(`${e.recall}/${e.flagTot}`, 12)} ${padL(`${e.silent}/${e.silentTot}`, 11)} ${padL(`${e.acc}/${e.tot} (${(100 * e.acc / e.tot).toFixed(0)}%)`, 9)}`);
}
console.log('');
