// Sentence-cue GATE bench (Jev plan step 4): the REAL SentenceCueSource built
// from the shipped more-formal CUE.md (its promptText AND its `gate:` line),
// ungated (today) vs gated (decision provider set), on the sentence-cues
// suite's 34 per-sentence expectations. Scored on the source's own outcome
// per sentence — did it emit a rewrite — against the suite's labels:
//   MORE_FORMAL → a rewrite is wanted (recall: emitted / wanted)
//   SAME / CEDE → no rewrite wanted (spared: rewrite calls the gate saved)
// The rewrite call itself is unchanged, so its quality is the existing
// sentence-cues bench's job (run.ts + judge.ts), not this one's.
//
// Run: TYPESAFE_API_KEY=… CEREBRAS_API_KEY=… npx tsx tests/benchmarks/decisions/sentence-gate-bench.mts [--arm chat|gated|both] [--threshold 0.5]
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import { CASES } from '../sentence-cues/cases';

const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const argv = process.argv.slice(2);
const ARM = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1] : 'both';
const THRESHOLD = argv.includes('--threshold') ? Number(argv[argv.indexOf('--threshold') + 1]) : undefined;
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });
const CEREBRAS = process.env.CEREBRAS_API_KEY, TYPESAFE = process.env.TYPESAFE_API_KEY;
if (!CEREBRAS || !TYPESAFE) { console.error('CEREBRAS_API_KEY and TYPESAFE_API_KEY are required'); process.exit(2); }

const cueDir = path.join(R, 'defaults/cues/more-formal');
const cfg = core.parseSingleCueMd(fs.readFileSync(path.join(cueDir, 'CUE.md'), 'utf8'), cueDir);
const srcCfg = Object.values(cfg.promptConfig.sources)[0] as { gate?: string };
if (!srcCfg?.gate) { console.error('more-formal/CUE.md has no gate: line'); process.exit(2); }

const usage: Record<string, { providerId: string; model: string; calls: number; promptTokens: number; cachedTokens: number; completionTokens: number }> = {};
let arm: string | null = null;
core.registerUsageSink((u: { providerId: string; model: string; promptTokens: number; cachedTokens: number; completionTokens: number }) => {
  if (!arm) return;
  const k = `${arm}|${u.providerId}/${u.model}`;
  const row = usage[k] ?? (usage[k] = { providerId: u.providerId, model: u.model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
  row.calls++; row.promptTokens += u.promptTokens; row.cachedTokens += u.cachedTokens; row.completionTokens += u.completionTokens;
});

function make(decisions: unknown) {
  return new core.SentenceCueSource({
    httpAdapter: http, provider: core.getProvider('cerebras'), endpoint: undefined, apiKey: CEREBRAS, model: 'gpt-oss-120b',
    sourceConfig: srcCfg, ...(decisions ? { decisions } : {}), ...(THRESHOLD !== undefined ? { gateThreshold: THRESHOLD } : {}),
  });
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function run(name: string, src: { getCues: (c: unknown) => Promise<{ results: Array<{ spanStart?: number; spanEnd?: number }> }> }) {
  arm = name;
  const ms: number[] = []; let wanted = 0, emittedWanted = 0, unwanted = 0, emittedUnwanted = 0;
  const misses: string[] = [];
  for (const c of CASES) {
    const text = c.input;
    const t0 = Date.now();
    const r = await src.getCues({ text, words: text.split(/\s+/).filter(Boolean), cursor: text.length }).catch(() => ({ results: [] }));
    ms.push(Date.now() - t0);
    for (const e of c.expectations) {
      const so = text.indexOf(e.originalSentence);
      const hit = r.results.some((x) => so >= 0 && x.spanStart !== undefined && x.spanStart <= so && (x.spanEnd ?? 0) >= so + e.originalSentence.length - 1);
      if (e.expect === 'MORE_FORMAL') { wanted++; if (hit) emittedWanted++; else misses.push(`lost rewrite  [${c.id}] «${e.originalSentence.slice(0, 50)}»`); }
      else { unwanted++; if (hit) { emittedUnwanted++; misses.push(`noise (${e.expect})  [${c.id}] «${e.originalSentence.slice(0, 50)}»`); } }
    }
  }
  arm = null;
  const rows = Object.entries(usage).filter(([k]) => k.startsWith(`${name}|`)).map(([, v]) => v);
  let cost = 0, chat = 0, jev = 0;
  for (const u of rows) { const price = core.priceFor(u.providerId, u.model); if (price) cost += core.estimateRowCostUSD(u, price); if (u.providerId === 'typesafe') jev += u.calls; else chat += u.calls; }
  const sentences = wanted + unwanted;
  console.log(`\n${name}  (${CASES.length} buffers, ${sentences} sentences)`);
  console.log(`  rewrites wanted ${wanted}: emitted ${emittedWanted} (recall ${(emittedWanted / wanted).toFixed(2)}) · not wanted ${unwanted}: emitted ${emittedUnwanted}`);
  console.log(`  rewrite (chat) calls ${chat} · decision calls ${jev} · $ total ${cost.toFixed(4)} · $ per sentence ${(cost / sentences).toFixed(6)}`);
  console.log(`  latency per buffer p50 ${pct(ms, 0.5)} ms · mean ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms`);
  for (const u of rows) console.log(`    ${u.providerId}/${u.model}: ${u.calls} calls · ${Math.round(u.promptTokens / u.calls)} in / ${Math.round(u.completionTokens / u.calls)} out`);
  for (const m of misses) console.log(`    ${m}`);
}

if (ARM === 'chat' || ARM === 'both') await run('CHAT (today, every sentence sent)', make(null));
if (ARM === 'gated' || ARM === 'both') await run('GATED (decision gate per sentence)', make(new core.TypeSafeDecisionProvider({ apiKey: TYPESAFE, httpAdapter: http })));
