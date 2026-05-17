/**
 * Speed-vs-accuracy benchmark — Groq gpt-oss-120b vs Gemini 3.1 Flash Lite.
 *
 * Typical OpenCues surfaces (word-cue, fluid-blank, transform) across
 * BOTH short and long-form (~200-word) context. Pure regex acceptance
 * (no LLM judge), wall-clock latency from the chat clients.
 *
 * Usage:
 *   GROQ_API_KEY=… npx tsx tests/benchmarks/speed-accuracy/run.ts
 *   GEMINI_API_KEY=… OPENCUES_BENCH_PROVIDER=gemini-flash-lite npx tsx ...
 *   GEMINI_API_KEY=… OPENCUES_BENCH_PROVIDER=gemini-flash-lite \
 *     OPENCUES_GEMINI_THINKING=none npx tsx ...
 *
 *   --json <path>    — write per-case JSON for downstream aggregation
 *   --trials <n>     — repeat each case n times (default 1)
 *   --parallel <n>   — concurrent requests (default 4)
 */

import * as fs from 'fs';
import { chat, MODEL } from '../transform-blank/groq';
import { CASES, type Case, type Kind, type Length } from './cases';

interface Args { jsonOut?: string; trials: number; parallel: number }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = { trials: 1, parallel: 4 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--json') out.jsonOut = a[++i];
    else if (a[i] === '--trials') out.trials = parseInt(a[++i], 10);
    else if (a[i] === '--parallel') out.parallel = parseInt(a[++i], 10);
  }
  return out;
}

interface CaseResult {
  id: string; kind: Kind; length: Length;
  trial: number; pass: boolean; latencyMs: number; outBytes: number;
}

async function runOne(c: Case, trial: number): Promise<CaseResult> {
  const t0 = Date.now();
  try {
    const r = await chat(
      [{ role: 'system', content: c.system }, { role: 'user', content: c.user }],
      { maxTokens: c.maxTokens, temperature: 0 },
    );
    return {
      id: c.id, kind: c.kind, length: c.length, trial,
      pass: c.accept(r.text),
      latencyMs: r.latencyMs,
      outBytes: r.text.length,
    };
  } catch (e) {
    return {
      id: c.id, kind: c.kind, length: c.length, trial,
      pass: false, latencyMs: Date.now() - t0, outBytes: 0,
    };
  }
}

async function pool<T, R>(items: T[], conc: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function fmt(n: number): string { return n.toFixed(0); }

async function main() {
  const args = parseArgs();
  const provider = process.env.OPENCUES_BENCH_PROVIDER === 'gemini-flash-lite'
    ? `gemini-flash-lite (thinking=${process.env.OPENCUES_GEMINI_THINKING ?? 'low'})`
    : 'groq';

  console.log(`Speed-Accuracy Bench — ${provider} (${MODEL})`);
  console.log(`Cases: ${CASES.length} × ${args.trials} trial(s) = ${CASES.length * args.trials} calls, parallel=${args.parallel}`);
  console.log('─'.repeat(78));

  const jobs: { c: Case; trial: number }[] = [];
  for (let t = 0; t < args.trials; t++) for (const c of CASES) jobs.push({ c, trial: t });

  const t0 = Date.now();
  const results = await pool(jobs, args.parallel, ({ c, trial }) => runOne(c, trial));
  const wallMs = Date.now() - t0;

  // Per-case print
  for (const r of results) {
    const flag = r.pass ? 'PASS' : 'FAIL';
    console.log(`  ${flag}  ${r.id.padEnd(15)} trial=${r.trial}  ${fmt(r.latencyMs).padStart(5)}ms  ${fmt(r.outBytes)}B`);
  }
  console.log('─'.repeat(78));

  // Aggregate by cell (kind × length)
  const cells: { kind: Kind; length: Length; results: CaseResult[] }[] = [];
  for (const kind of ['word-cue', 'fluid-blank', 'transform'] as Kind[]) {
    for (const length of ['short', 'long'] as Length[]) {
      cells.push({ kind, length, results: results.filter(r => r.kind === kind && r.length === length) });
    }
  }

  console.log('\nCELL                  pass    median   mean    p95     bytes(med)');
  console.log('─'.repeat(78));
  for (const cell of cells) {
    const lats = cell.results.map(r => r.latencyMs);
    const passes = cell.results.filter(r => r.pass).length;
    const total = cell.results.length;
    const bs = cell.results.map(r => r.outBytes);
    console.log(
      `${cell.kind.padEnd(13)} ${cell.length.padEnd(6)} ` +
      `${String(passes).padStart(3)}/${String(total).padStart(2)}  ` +
      `${fmt(median(lats)).padStart(5)}ms  ${fmt(mean(lats)).padStart(5)}ms  ${fmt(p95(lats)).padStart(5)}ms  ${fmt(median(bs)).padStart(5)}`
    );
  }
  console.log('─'.repeat(78));

  const allPass = results.filter(r => r.pass).length;
  const allLats = results.map(r => r.latencyMs);
  console.log(`OVERALL              ${allPass}/${results.length}  ${fmt(median(allLats))}ms median  ${fmt(mean(allLats))}ms mean  ${fmt(p95(allLats))}ms p95`);
  console.log(`Wall clock: ${(wallMs / 1000).toFixed(1)}s`);

  if (args.jsonOut) {
    fs.writeFileSync(args.jsonOut, JSON.stringify({
      provider, model: MODEL,
      ts: new Date().toISOString(),
      trials: args.trials,
      parallel: args.parallel,
      wallMs,
      results,
    }, null, 2));
    console.log(`Wrote ${args.jsonOut}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
