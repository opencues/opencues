// Batching bench: ONE decision request per pass vs one per source.
//
// The REAL core resolver with the REAL sources that ask questions — the
// session rail (tips + contradiction, claude-code pack + an engineering
// rulebook, as pause-bench.mjs) and the shipped more-formal sentence cue
// (its `gate:`) — on the sentence-cues suite's 30 buffers (the gate's
// corpus) plus pause-bench's 26 drafts (the rail's corpus). Two arms, same
// session:
//   SEPARATE  the resolver has no provider: each source sends its own
//             request (the rail's fused request, the gate's request in
//             front of its rewrite calls) — today
//   BATCHED   the resolver has the provider: one request for both,
//             answers handed in, sources start their chat calls together
// Scored per pass: decision requests, chat calls, $, latency to the pass's
// end and to each source's own result (onSourceResult), and the results per
// source (parity).
//
// Run: TYPESAFE_API_KEY=… CEREBRAS_API_KEY=… npx tsx tests/benchmarks/decisions/batch-bench.mts [--arm separate|batched|both]
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import { CASES as SENTENCE_CASES } from '../sentence-cues/cases';

const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const argv = process.argv.slice(2);
const ARM = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1] : 'both';
const http = new NodeHttpAdapter({ maxSockets: 6, timeout: 30000 });
const CEREBRAS = process.env.CEREBRAS_API_KEY, TYPESAFE = process.env.TYPESAFE_API_KEY;
if (!CEREBRAS || !TYPESAFE) { console.error('CEREBRAS_API_KEY and TYPESAFE_API_KEY are required'); process.exit(2); }
const decisions = new core.TypeSafeDecisionProvider({ apiKey: TYPESAFE, httpAdapter: http });

// ── inputs ─────────────────────────────────────────────────────────────────
const pack = JSON.parse(fs.readFileSync(path.join(R, 'defaults/cues/tips-claude-code/CUE.md'), 'utf8').match(/```json\s*([\s\S]*?)```/)![1]);
const tipsCatalog = core.buildTipsCatalog(pack);
const RULES = [
  'No new third-party dependencies without platform-team approval.',
  'Secrets and API keys never go in code, config files, or logs.',
  'Customer data stays in EU regions (eu-west-1) — never replicate it elsewhere.',
  'Every change to main requires a reviewed PR — no direct pushes.',
  'Use the structured logger; console.log never ships to production.',
];
const snapshot = core.buildSessionCommitmentsSnapshot(RULES.map((statement) => ({ category: 'constraint', statement })), { sessionId: 'batch-bench' });
const PAUSE_TEXTS = [
  "ok this is a mess, let's start over on the auth stuff", 'it forgot the plan we agreed on and is wandering', 'how do i undo what it just did to the router',
  'why is this burning through my budget so fast', "can we use a cheaper model for this, it's a trivial change", 'it keeps asking me to approve every single git command',
  'something auto-formats every edit would be nice', 'why is it so slow on a one line change', "let's just npm install lodash for this, it's one helper",
  "I'll hardcode the Stripe key in the config for the demo and rotate it later", 'quickest fix is to mirror the customer table to us-east-1 for the analytics job',
  "it's a one-line fix, I'll push straight to main and skip the PR", 'threw a few console.logs in the payment handler to trace it in prod',
  'the context of this function is the request object', 'compact the JSON before you send it over the wire', 'clear the cache directory before the build',
  'undo the last migration in the db folder', 'the cost field on the invoice should be a decimal', 'I asked platform for approval on the redis client and they signed off, adding it now',
  'moved the key out of the repo and into the vault; the config reads it from the environment now', 'opened the PR for the retry change, waiting on review before it goes to main',
  'add a delete button to the ProjectCard component', 'what does this project do?', 'rename the helper to parseHeaders and update the two call sites',
  'the zorb tests pass locally, pushing the branch now', 'can you summarise the last three commits',
];
const TEXTS = [...SENTENCE_CASES.map((c) => c.input), ...PAUSE_TEXTS];

const cueDir = path.join(R, 'defaults/cues/more-formal');
const cfg = core.parseSingleCueMd(fs.readFileSync(path.join(cueDir, 'CUE.md'), 'utf8'), cueDir);
const srcCfg = Object.values(cfg.promptConfig.sources)[0] as { gate?: string };
if (!srcCfg?.gate) { console.error('more-formal/CUE.md has no gate: line'); process.exit(2); }

// ── usage per arm ──────────────────────────────────────────────────────────
const usage: Record<string, any> = {};
let arm: string | null = null;
core.registerUsageSink((u: any) => {
  if (!arm) return;
  const k = `${arm}|${u.providerId}/${u.model}`;
  const row = usage[k] ?? (usage[k] = { arm, providerId: u.providerId, model: u.model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
  row.calls++; row.promptTokens += u.promptTokens; row.cachedTokens += u.cachedTokens; row.completionTokens += u.completionTokens;
});
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));

function makeSources() {
  const llm = { httpAdapter: http, provider: core.getProvider('cerebras'), endpoint: undefined, apiKey: CEREBRAS, model: 'gpt-oss-120b' };
  const rail = new core.SessionCueSource({ ...llm, enableContradiction: true, enableSemanticTips: true, enableAsk: false, decisions });
  const sentence = new core.SentenceCueSource({ ...llm, sourceConfig: srcCfg, decisions });
  return [rail, sentence];
}

async function run(name: string, batched: boolean) {
  arm = name;
  const resolver = core.createResolver(makeSources(), { parallel: true, timeout: 30000, continueOnError: true, ...(batched ? { decisions } : {}) });
  const passMs: number[] = []; const railMs: number[] = []; const sentMs: number[] = []; const sentRewrittenMs: number[] = [];
  const counts: Record<string, number> = {};
  for (const text of TEXTS) {
    const t0 = Date.now();
    const settled: Record<string, number> = {};
    let r: any;
    try {
      r = await resolver.resolve({ text, words: text.split(/\s+/).filter(Boolean), cursor: text.length, tipsCatalog, sessionCommitments: snapshot }, { onSourceResult: (id: string) => { settled[id] = Date.now() - t0; } });
    } catch { r = { results: [] }; }
    passMs.push(Date.now() - t0);
    if (settled['session-cue'] !== undefined) railMs.push(settled['session-cue']);
    if (settled['sentence-cue:more-formal'] !== undefined) {
      sentMs.push(settled['sentence-cue:more-formal']);
      if (r.results.some((x: any) => x.source === 'sentence-cue:more-formal')) sentRewrittenMs.push(settled['sentence-cue:more-formal']);
    }
    for (const x of r.results) counts[x.source] = (counts[x.source] ?? 0) + 1;
  }
  arm = null;
  const rows = Object.values(usage).filter((u: any) => u.arm === name);
  let cost = 0, chat = 0, jev = 0;
  for (const u of rows) { const price = core.priceFor(u.providerId, u.model); if (price) cost += core.estimateRowCostUSD(u, price); if (u.providerId === 'typesafe') jev += u.calls; else chat += u.calls; }
  console.log(`\n${name}  (${TEXTS.length} passes: ${SENTENCE_CASES.length} sentence-suite buffers + ${PAUSE_TEXTS.length} pause drafts)`);
  console.log(`  decision requests per pass ${(jev / TEXTS.length).toFixed(2)} · chat calls per pass ${(chat / TEXTS.length).toFixed(2)} · $ per pass ${(cost / TEXTS.length).toFixed(6)}`);
  console.log(`  pass end p50 ${pct(passMs, 0.5)} / p90 ${pct(passMs, 0.9)} / mean ${mean(passMs)} ms`);
  console.log(`  rail result p50 ${pct(railMs, 0.5)} / mean ${mean(railMs)} ms · sentence cue result p50 ${pct(sentMs, 0.5)} / mean ${mean(sentMs)} ms · on buffers WITH a rewrite p50 ${pct(sentRewrittenMs, 0.5)} / mean ${mean(sentRewrittenMs)} ms (${sentRewrittenMs.length})`);
  console.log(`  results by source: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  for (const u of rows) console.log(`    ${u.providerId}/${u.model}: ${u.calls} calls · ${Math.round(u.promptTokens / u.calls)} in / ${Math.round(u.completionTokens / u.calls)} out`);
}

if (ARM === 'separate' || ARM === 'both') await run('SEPARATE (one request per source)', false);
if (ARM === 'batched' || ARM === 'both') await run('BATCHED (one request per pass)', true);
