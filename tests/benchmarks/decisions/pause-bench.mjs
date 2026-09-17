// Per-PAUSE compare bench (Jev plan step 3): the REAL SessionCueSource on a
// realistic session rail — the claude-code tips pack + an engineering
// watchlist — on the CHAT path (today) vs the FUSED decision path (one
// request per pause). This is the per-EVENT number the gains ledger wants:
// chat calls per pause, latency to decision, $ per pause, with the two
// legs' shipped accuracy metrics scored the same way their own benches do.
//
// Run: TYPESAFE_API_KEY=… CEREBRAS_API_KEY=… node tests/benchmarks/decisions/pause-bench.mjs [--ask] [--spelling] [--arm chat|fused|both]
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const argv = process.argv.slice(2);
const ASK = argv.includes('--ask');
const SPELLING = argv.includes('--spelling');   // the spelling passenger on the pause request (plan step 7B)
const ARM = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1] : 'both';
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });
const CEREBRAS = process.env.CEREBRAS_API_KEY, TYPESAFE = process.env.TYPESAFE_API_KEY;
if (!CEREBRAS || !TYPESAFE) { console.error('CEREBRAS_API_KEY and TYPESAFE_API_KEY are required'); process.exit(2); }

// ── the rail's inputs ──────────────────────────────────────────────────────
const pack = JSON.parse(fs.readFileSync(path.join(R, 'defaults/cues/tips-claude-code/CUE.md'), 'utf8').match(/```json\s*([\s\S]*?)```/)[1]);
const tipsCatalog = core.buildTipsCatalog(pack);
const RULES = [
  'No new third-party dependencies without platform-team approval.',
  'Secrets and API keys never go in code, config files, or logs.',
  'Customer data stays in EU regions (eu-west-1) — never replicate it elsewhere.',
  'Every change to main requires a reviewed PR — no direct pushes.',
  'Use the structured logger; console.log never ships to production.',
];
const snapshot = core.buildSessionCommitmentsSnapshot(RULES.map((statement) => ({ category: 'constraint', statement })), { sessionId: 'pause-bench' });
const ruleId = (i) => snapshot.commitments[i].id;

// ── cases: [draft, want] — want: {tip: /trigger/} | {rule: idx} | null ─────
// Tips cases are the shipped tips bench's claude-code set (recall + traps);
// rule cases are the company-rules bench's engineering domain; neutral
// drafts written here. Fixtures kept synthetic where new.
const CASES = [
  ["ok this is a mess, let's start over on the auth stuff", { tip: /^\/clear$/ }],
  ["it forgot the plan we agreed on and is wandering", { tip: /^\/compact$/ }],
  ["how do i undo what it just did to the router", { tip: /^\/rewind$|^undo$/ }],
  ["why is this burning through my budget so fast", { tip: /^\/cost$|^\/model$|^\/usage$|^tokens$|^limit$/ }],
  ["can we use a cheaper model for this, it's a trivial change", { tip: /^\/model$/ }],
  ["it keeps asking me to approve every single git command", { tip: /^permission$|^\/permissions$|^shift\+tab$/ }],
  ["something auto-formats every edit would be nice", { tip: /^hooks?$/ }],
  ["why is it so slow on a one line change", { tip: /^slow$|^\/model$/ }],
  ["let's just npm install lodash for this, it's one helper", { rule: 0 }],
  ["I'll hardcode the Stripe key in the config for the demo and rotate it later", { rule: 1 }],
  ["quickest fix is to mirror the customer table to us-east-1 for the analytics job", { rule: 2 }],
  ["it's a one-line fix, I'll push straight to main and skip the PR", { rule: 3 }],
  ["threw a few console.logs in the payment handler to trace it in prod", { rule: 4 }],
  // traps: topic named, situation absent / rule obeyed
  ["the context of this function is the request object", null],
  ["compact the JSON before you send it over the wire", null],
  ["clear the cache directory before the build", null],
  ["undo the last migration in the db folder", null],
  ["the cost field on the invoice should be a decimal", null],
  ["I asked platform for approval on the redis client and they signed off, adding it now", null],
  ["moved the key out of the repo and into the vault; the config reads it from the environment now", null],
  ["opened the PR for the retry change, waiting on review before it goes to main", null],
  // neutral
  ["add a delete button to the ProjectCard component", null],
  ["what does this project do?", null],
  ["rename the helper to parseHeaders and update the two call sites", null],
  // borderline (reported, not gated): "pushing the branch" sits next to the commit entry's "is about to commit";
  // Jev scores it none 0.47–0.53 alone and fused — inside the ±0.05 band at the 0.5 threshold.
  ["the zorb tests pass locally, pushing the branch now", null, 'borderline'],
  ["can you summarise the last three commits", null],
];

// ── usage per arm, priced from the meter ──────────────────────────────────
const usage = {};
let arm = null;
core.registerUsageSink((u) => {
  if (!arm) return;
  const k = `${arm}|${u.providerId}/${u.model}`;
  const row = usage[k] ?? (usage[k] = { arm, providerId: u.providerId, model: u.model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
  row.calls++; row.promptTokens += u.promptTokens; row.cachedTokens += u.cachedTokens; row.completionTokens += u.completionTokens;
});

function makeRail(decisions) {
  return new core.SessionCueSource({
    httpAdapter: http, provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', apiKey: CEREBRAS,
    enableContradiction: true, enableSemanticTips: true, enableAsk: ASK,
    ...(decisions ? { decisions, enableSpelling: SPELLING } : {}),
  });
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function run(name, rail) {
  arm = name;
  const ms = []; let tipRight = 0, tipN = 0, ruleRight = 0, ruleN = 0, falseAlarms = 0, trapN = 0, borderline = 0;
  const misses = [];
  for (const [text, want, flag] of CASES) {
    const t0 = Date.now();
    const r = await rail.getCues({ text, words: text.split(/\s+/).filter(Boolean), tipsCatalog, sessionCommitments: snapshot, cursor: text.length }).catch(() => ({ results: [] }));
    ms.push(Date.now() - t0);
    const got = r.results[0];
    if (!want) { trapN++; if (got) { if (flag === 'borderline') { borderline++; misses.push(`borderline   ${got.source} «${text.slice(0, 50)}» → ${got.cueTip}`); } else { falseAlarms++; misses.push(`FALSE ALARM  ${got.source} «${text.slice(0, 50)}» → ${got.cueTip}`); } } continue; }
    if (want.tip) { tipN++; const trig = got?.metadata?.tip?.trigger?.split(' / ')[0].toLowerCase(); if (got && want.tip.test(trig ?? '')) tipRight++; else misses.push(`tip miss     «${text.slice(0, 50)}» → ${got ? got.cueTip : '(silent)'}`); }
    if (want.rule !== undefined) { ruleN++; if (got && got.source === 'sentence-cue:session-contradiction') ruleRight++; else misses.push(`rule miss    «${text.slice(0, 50)}» → ${got ? got.cueTip : '(silent)'}`); }
  }
  arm = null;
  const rows = Object.values(usage).filter((u) => u.arm === name);
  let cost = 0, chat = 0, jev = 0;
  for (const u of rows) { const price = core.priceFor(u.providerId, u.model); if (price) cost += core.estimateRowCostUSD(u, price); if (u.providerId === 'typesafe') jev += u.calls; else chat += u.calls; }
  console.log(`\n${name}  (${CASES.length} pauses, ask ${ASK ? 'on' : 'off'}${SPELLING ? ', spelling passenger on' : ''})`);
  console.log(`  tips right ${tipRight}/${tipN} · contradiction recall ${ruleRight}/${ruleN} · false alarms ${falseAlarms}/${trapN}${borderline ? ` (+${borderline} borderline, reported not gated)` : ''}`);
  console.log(`  latency p50 ${pct(ms, 0.5)} ms · p90 ${pct(ms, 0.9)} ms · mean ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms`);
  console.log(`  calls per pause: chat ${(chat / CASES.length).toFixed(2)} · jev ${(jev / CASES.length).toFixed(2)} · $ per pause ${(cost / CASES.length).toFixed(6)}`);
  for (const u of rows) console.log(`    ${u.providerId}/${u.model}: ${u.calls} calls · ${Math.round(u.promptTokens / u.calls)} in / ${Math.round(u.completionTokens / u.calls)} out`);
  for (const m of misses) console.log(`    ${m}`);
}

if (ARM === 'chat' || ARM === 'both') await run('CHAT (today)', makeRail(null));
if (ARM === 'fused' || ARM === 'both') await run('FUSED (one decision request per pause)', makeRail(new core.TypeSafeDecisionProvider({ apiKey: TYPESAFE, httpAdapter: http })));
