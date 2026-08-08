// extraction-bench — Stage A (producer) model comparison, MULTI-SESSION suite.
//
// The realtime matcher ("cues side") is FIXED to a fast cerebras model; what
// varies is the EXTRACTION model that distils a raw coding-session transcript
// into the commitments watchlist. Answers the two questions Wilfred asked:
//   • speed  — how long to get the watchlist out of raw code context?
//   • cost   — how many tokens does that read burn?
//   • quality — does the resulting watchlist still catch contradictions?
//
// Thorough version: SIX diverse sessions (bun cache, python ETL, react UI, API
// design, terraform infra, revision/musing traps) × ~8 realtime cases each ≈ 47
// cases, with deliberate-revision + future-musing precision traps. Extraction
// timed over 2 uncontended runs (median); end-to-end matched over 2 runs to
// separate LLM non-determinism from signal.
//
// Extraction models compared (Stage A):
//   gemma   = cerebras/gemma-4-31b
//   haiku   = anthropic/claude-haiku-4-5
//   gemini  = gemini/3.6-flash-lite  (falls back to 3.5-flash-lite)
// Fixed matcher (Stage B / cues side): cerebras/gemma-4-31b  (--matcher gpt-oss to switch)
// Independent judge (bench scorer, NOT a feature model): anthropic/claude-sonnet-4-6
//
// Run: CEREBRAS_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… \
//        node tests/benchmarks/session-contradiction/extraction-bench.mjs [--e2e-runs 2]

import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const { SessionContradictionSource } = await import(path.join(R, 'packages/opencues-core/dist/contradiction/session-contradiction-source.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 60000 });

const arg = (name, def) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def;
const E2E_RUNS = parseInt(arg('--e2e-runs', '2'), 10);
const matcherArg = arg('--matcher', 'gemma');
const MATCHER = matcherArg === 'gpt-oss'
  ? { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gpt-oss-120b' }
  : { provider: core.getProvider('cerebras'), model: 'gemma-4-31b',  key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gemma-4-31b' };
const JUDGE = { provider: core.getProvider('anthropic'), model: 'claude-sonnet-4-6', key: process.env.ANTHROPIC_API_KEY };

// ── shared noise (realistic on-scope chatter that carries NO decisions) ──
const NOISE = [
  { role: 'user', text: "what's the rough read latency right now?" },
  { role: 'assistant', text: 'Around 40ms p50 hitting the store directly; there is clear headroom.' },
  { role: 'user', text: 'add a doc comment for whoever reads this next.' },
  { role: 'assistant', text: 'Added a short doc comment describing the shape and intent.' },
  { role: 'user', text: 'remind me to benchmark before/after once it is wired.' },
  { role: 'assistant', text: 'I will add a small before/after measurement to the plan so we can quantify it.' },
  { role: 'user', text: 'roughly how much memory does that use?' },
  { role: 'assistant', text: 'A few MB at the target size; the bookkeeping overhead is small relative to the payloads.' },
];
const withNoise = (decisions, copies = 3) => {
  const t = [...decisions];
  for (let i = 0; i < copies; i++) t.push(...NOISE);
  return t;
};

// ── six diverse sessions. Each: gold decisions + a transcript that STATES them
//    in prose, and realtime cases (flag=true → must fire ⚠; flag=false → must
//    stay silent: consistent / agrees / unrelated / future-musing / revision). ──
const SESSIONS = [
  {
    name: 'bun-cache',
    gold: [
      'Runtime is Bun, not Node', 'Do not add new npm dependencies',
      'Only touching the cache module this session', 'Keep the running plan in CLAUDE.md, not chat',
      'Ship the feature behind an off-by-default flag first',
    ],
    decisions: [
      { role: 'user', text: "starting the cache layer. this repo is Bun — please don't reach for Node-only APIs." },
      { role: 'assistant', text: "Understood, Bun throughout — Bun.file and the built-in test runner rather than node: modules." },
      { role: 'user', text: "keep it dependency-free, no new npm packages for this — supply-chain risk." },
      { role: 'assistant', text: "No new dependencies. A plain Map with a hand-rolled LRU covers the cache." },
      { role: 'user', text: "stay scoped — only the cache module this session, don't wander into auth or billing." },
      { role: 'assistant', text: "Scoped to the cache module only; I'll note anything else but not touch it." },
      { role: 'user', text: "keep the running plan in CLAUDE.md as we go, not buried in chat — it must survive compaction." },
      { role: 'assistant', text: "I'll maintain the plan and decisions in CLAUDE.md so they persist." },
      { role: 'user', text: "when it's ready, ship behind an off-by-default flag first so we can dogfood." },
      { role: 'assistant', text: "Off-by-default flag for the first ship, then flip on once validated." },
    ],
    cases: [
      { s: 'ok now switch the cache over to node', flag: true },
      { s: "let's add the redis npm package for caching", flag: true },
      { s: "while I'm here let me also refactor the auth module", flag: true },
      { s: 'ship it on by default for everyone', flag: true },
      { s: "we'll just keep the running plan here in the chat", flag: true },
      { s: 'store the cache entries in a plain Map', flag: false },
      { s: "use Bun's built-in test runner for this", flag: false },     // agrees
      { s: 'ship it behind the off-by-default flag as planned', flag: false }, // agrees
      { s: 'add a doc comment explaining the cache keys', flag: false }, // unrelated
    ],
  },
  {
    name: 'python-etl',
    gold: [
      'Use Polars, not Pandas', 'Use DuckDB locally, no cloud warehouse this sprint',
      'Keep credentials in environment variables, not in code', 'Target Python 3.12',
    ],
    decisions: [
      { role: 'user', text: 'building the ETL for the events table. use Polars for the dataframes, not Pandas — we standardised on it.' },
      { role: 'assistant', text: 'Polars throughout, lazy frames where it helps. Noted.' },
      { role: 'user', text: 'keep it local this sprint — DuckDB for the store, do not push anything to a cloud warehouse yet.' },
      { role: 'assistant', text: 'DuckDB locally, no BigQuery/Snowflake this sprint.' },
      { role: 'user', text: 'and never hardcode credentials — read them from environment variables only.' },
      { role: 'assistant', text: 'All secrets from os.environ, nothing in code.' },
      { role: 'user', text: 'target Python 3.12, we rely on the newer typing features.' },
      { role: 'assistant', text: '3.12 it is.' },
    ],
    cases: [
      { s: "let's just use pandas for this join, it's easier", flag: true },
      { s: 'push the output straight to BigQuery', flag: true },
      { s: 'hardcode the api token in the config file for now', flag: true },
      { s: 'downgrade to python 3.9 for compatibility', flag: true },
      { s: 'load the frame lazily with a Polars scan', flag: false },   // agrees
      { s: 'read the api key from os.environ', flag: false },           // agrees
      { s: 'write the intermediate table into DuckDB', flag: false },   // agrees
      { s: 'add a test for the dedupe transform', flag: false },        // unrelated
    ],
  },
  {
    name: 'react-ui',
    gold: [
      'TypeScript strict mode stays on', 'No new UI libraries — use the in-house design system',
      'Feature-flag new screens', 'Use CSS modules, not inline styles',
    ],
    decisions: [
      { role: 'user', text: 'working on the dashboard. keep TypeScript strict mode on, no loosening it per-file.' },
      { role: 'assistant', text: 'Strict mode stays on everywhere.' },
      { role: 'user', text: "don't pull in new UI libraries — use our in-house design system components." },
      { role: 'assistant', text: 'Design-system components only, no new UI deps.' },
      { role: 'user', text: 'gate any new screen behind a feature flag before it ships.' },
      { role: 'assistant', text: 'Feature-flagged rollout for new screens.' },
      { role: 'user', text: 'styling via CSS modules, no inline style props.' },
      { role: 'assistant', text: 'CSS modules throughout, no inline styles.' },
    ],
    cases: [
      { s: 'pull in material-ui for the dialog', flag: true },
      { s: 'just disable strict mode for this one file', flag: true },
      { s: 'ship the new dashboard to all users right now', flag: true },
      { s: 'add a style={{ margin: 8 }} prop here', flag: true },
      { s: "use the design system's Button component", flag: false },   // agrees
      { s: 'wrap the new screen behind the feature flag', flag: false },// agrees
      { s: 'add a CSS module for the card layout', flag: false },       // agrees
      { s: 'write a unit test for the reducer', flag: false },          // unrelated
    ],
  },
  {
    name: 'api-design',
    gold: [
      'REST, not GraphQL', 'Version new endpoints under /v2',
      'Keep /v1 backward-compatible', 'JSON payloads only, not protobuf',
    ],
    decisions: [
      { role: 'user', text: 'designing the new endpoints. stay REST, we are not introducing GraphQL.' },
      { role: 'assistant', text: 'REST only, no GraphQL layer.' },
      { role: 'user', text: 'put new endpoints under /v2, and keep /v1 responding exactly as it does for backward compat.' },
      { role: 'assistant', text: 'New surface under /v2; /v1 stays backward-compatible.' },
      { role: 'user', text: 'JSON payloads only — no protobuf on these.' },
      { role: 'assistant', text: 'JSON throughout.' },
    ],
    cases: [
      { s: "let's expose this as a GraphQL resolver instead", flag: true },
      { s: 'just change the /v1 response shape to match', flag: true },
      { s: 'switch the payload encoding to protobuf', flag: true },
      { s: 'drop the /v1 endpoint entirely', flag: true },
      { s: 'add the new field under the /v2 route', flag: false },      // agrees
      { s: 'return a JSON object from the handler', flag: false },      // agrees
      { s: 'keep /v1 responding the same as before', flag: false },     // agrees
      { s: 'document the /v2 request schema', flag: false },            // unrelated
    ],
  },
  {
    name: 'terraform-infra',
    gold: [
      'All infrastructure via Terraform, no manual console changes', 'Deploy to staging before prod',
      'No secrets committed — use the vault', 'Single region us-east-1 for now',
    ],
    decisions: [
      { role: 'user', text: 'infra work today. everything goes through Terraform — no manual AWS console changes.' },
      { role: 'assistant', text: 'Terraform-managed only, no console drift.' },
      { role: 'user', text: 'always deploy to staging before prod, no direct-to-prod.' },
      { role: 'assistant', text: 'Staging first, then prod.' },
      { role: 'user', text: 'no secrets in the repo — pull them from the vault.' },
      { role: 'assistant', text: 'Secrets from vault, nothing committed.' },
      { role: 'user', text: 'single region for now, us-east-1, keep it simple.' },
      { role: 'assistant', text: 'us-east-1 only for now.' },
    ],
    cases: [
      { s: 'just click through the AWS console to add the bucket', flag: true },
      { s: 'push this change straight to prod', flag: true },
      { s: 'commit the db password into the repo for now', flag: true },
      { s: 'spin up a second region in eu-west-1', flag: true },
      { s: 'add the resource in the terraform module', flag: false },   // agrees
      { s: 'roll it out to staging first', flag: false },               // agrees
      { s: 'pull the api secret from the vault', flag: false },         // agrees
      { s: 'add an output for the bucket name', flag: false },          // unrelated
    ],
  },
  {
    name: 'revision-musing-traps',   // precision stress: revision + future-musing must NOT flag
    gold: [
      'Use SQLite for the prototype', 'Single-threaded worker for now', 'Log to stdout, not files',
    ],
    decisions: [
      { role: 'user', text: 'for the prototype use SQLite — we can revisit the datastore later, but SQLite for now.' },
      { role: 'assistant', text: 'SQLite for the prototype.' },
      { role: 'user', text: 'keep the worker single-threaded for now, concurrency later.' },
      { role: 'assistant', text: 'Single-threaded worker.' },
      { role: 'user', text: 'log to stdout, not to files — the platform captures stdout.' },
      { role: 'assistant', text: 'Logging to stdout.' },
    ],
    cases: [
      { s: 'swap the worker over to a thread pool now', flag: true },
      { s: 'write the logs to /var/log/app.log', flag: true },
      { s: 'migrate the prototype to postgres today', flag: true },
      { s: 'keep using SQLite for the prototype', flag: false },        // agrees
      { s: 'we could consider postgres for production later', flag: false }, // FUTURE MUSING — not a now-contradiction
      { s: 'log the startup message to stdout', flag: false },          // agrees
      { s: 'add a healthcheck endpoint', flag: false },                 // unrelated
    ],
  },
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
  { name: 'gemma  (cerebras/gemma-4-31b)', model: 'gemma-4-31b', key: process.env.CEREBRAS_API_KEY, pid: 'cerebras' },
  { name: 'haiku  (anthropic/claude-haiku-4-5)', model: 'claude-haiku-4-5-20251001', key: process.env.ANTHROPIC_API_KEY, pid: 'anthropic' },
  { name: `gemini (gemini/${GEMINI_MODEL})`, model: GEMINI_MODEL, key: process.env.GEMINI_API_KEY, pid: 'gemini' },
];

function usageOf(pid, rawJson) {
  try {
    const j = JSON.parse(rawJson);
    if (pid === 'anthropic') return { in: j.usage?.input_tokens ?? 0, out: j.usage?.output_tokens ?? 0 };
    if (pid === 'gemini') return { in: j.usageMetadata?.promptTokenCount ?? 0, out: j.usageMetadata?.candidatesTokenCount ?? 0 };
    return { in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0 };  // openai-compatible (cerebras)
  } catch { return { in: 0, out: 0 }; }
}

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

const RECALL_SYS = `You check whether each of a set of GOLD decisions is represented (in meaning, not wording) anywhere in an EXTRACTED list of session commitments. Return ONLY a JSON array of booleans, one per gold decision in order.`;
async function goldRecall(gold, snapshot) {
  const extracted = (snapshot?.commitments || []).map(c => `- ${c.statement}`).join('\n') || '(none)';
  const goldText = gold.map((g, i) => `${i + 1}. ${g}`).join('\n');
  const raw = await chat(JUDGE, RECALL_SYS, `GOLD:\n${goldText}\n\nEXTRACTED:\n${extracted}`, 120);
  const a = parseObj(raw);
  return Array.isArray(a) ? gold.map((_, i) => !!a[i]) : gold.map(() => false);
}

async function matchCases(watch, cases) {
  const src = new SessionContradictionSource({ httpAdapter: http, provider: MATCHER.provider, model: MATCHER.model, apiKey: MATCHER.key, log: () => {} });
  return mapLimit(cases, 4, async (c) => {
    const res = await src.getCues({ text: c.s, words: c.s.split(/\s+/).filter(Boolean), sessionCommitments: watch });
    return { flag: c.flag, flagged: res.results.length > 0 };
  });
}

// ── run ──
const totalGold = SESSIONS.reduce((n, s) => n + s.gold.length, 0);
const flagTot = SESSIONS.reduce((n, s) => n + s.cases.filter(c => c.flag).length, 0);
const silentTot = SESSIONS.reduce((n, s) => n + s.cases.filter(c => !c.flag).length, 0);
console.log(`\nextraction-bench (thorough) — ${SESSIONS.length} sessions, ${flagTot + silentTot} cases (${flagTot} contradiction / ${silentTot} silent)`);
console.log(`fixed matcher ${MATCHER.name}, judge anthropic/${JUDGE.model}, e2e runs ${E2E_RUNS}, gemini→${GEMINI_MODEL}`);
console.log('='.repeat(96));

const summary = [];
for (const ex of EXTRACTORS) {
  const times = [], tokIns = [], tokOuts = [];
  let goldCaught = 0, nCommit = 0, anyErr = null;
  const e2e = Array.from({ length: E2E_RUNS }, () => ({ flagHit: 0, silentHit: 0 }));
  const perSession = [];
  for (const S of SESSIONS) {
    const turns = withNoise(S.decisions, 3);
    // 2 uncontended extraction runs → median time; use the median run's watchlist
    const runs = [];
    for (let k = 0; k < 2; k++) runs.push(await extract(ex, turns));
    const ok = runs.filter(r => r.snapshot);
    if (!ok.length) { anyErr = runs[0].err; perSession.push({ name: S.name, err: runs[0].err }); continue; }
    ok.sort((a, b) => a.ms - b.ms);
    const med = ok[Math.floor(ok.length / 2)];
    times.push(med.ms); tokIns.push(med.tokIn); tokOuts.push(med.tokOut); nCommit += med.snapshot.commitments.length;
    const rec = await goldRecall(S.gold, med.snapshot);
    const caught = rec.filter(Boolean).length; goldCaught += caught;
    const watch = { summary: med.snapshot.summary, commitments: med.snapshot.commitments };
    let sFlagHit = 0, sSilentHit = 0;
    for (let run = 0; run < E2E_RUNS; run++) {
      const rows = await matchCases(watch, S.cases);
      for (const r of rows) { if (r.flag && r.flagged) { e2e[run].flagHit++; sFlagHit++; } if (!r.flag && !r.flagged) { e2e[run].silentHit++; sSilentHit++; } }
    }
    perSession.push({ name: S.name, ms: med.ms, gold: `${caught}/${S.gold.length}`, flag: `${(sFlagHit / E2E_RUNS).toFixed(1)}/${S.cases.filter(c => c.flag).length}`, silent: `${(sSilentHit / E2E_RUNS).toFixed(1)}/${S.cases.filter(c => !c.flag).length}` });
  }
  summary.push({ ex, times, tokIns, tokOuts, goldCaught, nCommit, e2e, perSession, anyErr });
}

const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const sum = a => a.reduce((x, y) => x + y, 0);
const pad = (s, n) => String(s).padEnd(n); const padL = (s, n) => String(s).padStart(n);

console.log(`\nPER-SESSION (median extraction ms · gold-recall · e2e flag-recall · e2e restraint):`);
for (const r of summary) {
  console.log(`\n  ${r.ex.name}`);
  for (const p of r.perSession) {
    if (p.err) { console.log(`    ${pad(p.name, 22)} ERR ${p.err}`); continue; }
    console.log(`    ${pad(p.name, 22)} ${padL(p.ms.toFixed(0), 6)}ms   gold ${p.gold}   flag ${p.flag}   silent ${p.silent}`);
  }
}

console.log(`\n${'='.repeat(96)}`);
console.log(`AGGREGATE (across ${SESSIONS.length} sessions):\n`);
console.log(`${pad('EXTRACTION MODEL', 34)} ${padL('med ms', 7)} ${padL('mean ms', 8)} ${padL('tok_in', 8)} ${padL('tok_out', 8)} ${padL('gold', 8)}`);
console.log('-'.repeat(96));
for (const r of summary) {
  const mean = r.times.length ? (sum(r.times) / r.times.length) : 0;
  console.log(`${pad(r.ex.name, 34)} ${padL(med(r.times).toFixed(0), 7)} ${padL(mean.toFixed(0), 8)} ${padL(sum(r.tokIns), 8)} ${padL(sum(r.tokOuts), 8)} ${padL(`${r.goldCaught}/${totalGold}`, 8)}`);
}

console.log(`\nEND-TO-END accuracy on ${flagTot + silentTot} realtime cases (per e2e run, to show matcher stability):`);
console.log(`${pad('EXTRACTION MODEL', 34)} ${padL('flag-recall', 26)} ${padL('restraint', 26)} ${padL('overall', 10)}`);
console.log('-'.repeat(96));
for (const r of summary) {
  const fr = r.e2e.map(e => `${e.flagHit}/${flagTot}`).join(' ');
  const rs = r.e2e.map(e => `${e.silentHit}/${silentTot}`).join(' ');
  const accs = r.e2e.map(e => (100 * (e.flagHit + e.silentHit) / (flagTot + silentTot)));
  const accStr = accs.length === 1 ? `${accs[0].toFixed(0)}%` : `${Math.min(...accs).toFixed(0)}-${Math.max(...accs).toFixed(0)}%`;
  console.log(`${pad(r.ex.name, 34)} ${padL(fr, 26)} ${padL(rs, 26)} ${padL(accStr, 10)}`);
}
console.log('');
