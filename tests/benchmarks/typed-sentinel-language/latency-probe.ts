/**
 * Latency + prompt-size probe.
 *
 * Question: does the richer `parameterized` schema cost latency or
 * token spend versus the current `bare` form?
 *
 * Runs the same 34 cases against bare AND parameterized — single
 * provider per run, sequential dispatch (so latency is the per-call
 * wall-clock, not the parallelism-amortized number). Captures:
 *
 *   - prompt-size (chars)        — proxy for input-token cost
 *   - output-size (chars)        — proxy for output-token cost
 *   - per-case latency ms        — model TTFT + emit time
 *   - p50 / p95 / mean across cases
 *
 * Output: side-by-side table per provider.
 *
 *   npx tsx tests/benchmarks/typed-sentinel-language/latency-probe.ts \
 *     --provider cerebras --runs 3
 *
 * `--runs N` runs each (language, case) cell N times and uses the
 * median to smooth single-call jitter. Default 3.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CATALOG } from './catalog';
import { CASES } from './cases';
import { LANGUAGES } from './languages';
import { pickProvider, type ProviderId } from './providers';
import { buildSystemPrompt, buildUserMessage } from './prompt';

function parseArgs(argv: string[]) {
  const out = { provider: 'cerebras' as ProviderId, runs: 3 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] as ProviderId;
    else if (a === '--runs') out.runs = parseInt(argv[++i]!, 10);
  }
  return out;
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function ms(x: number): string { return `${Math.round(x)}ms`; }

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

interface CellResult {
  language: string;
  systemPromptChars: number;
  perCase: Array<{
    caseId: string;
    latencyMedianMs: number;
    outputChars: number;
  }>;
  /** Distribution across all cases (using the median latency per case). */
  latency: {
    p50: number;
    p95: number;
    mean: number;
    min: number;
    max: number;
  };
  outputCharsMean: number;
}

async function runCell(provider: ReturnType<typeof pickProvider>, language: 'bare' | 'parameterized', runs: number): Promise<CellResult> {
  const lang = LANGUAGES[language];
  const system = buildSystemPrompt(CATALOG, lang);
  const systemPromptChars = system.length;
  const perCase: CellResult['perCase'] = [];
  for (const c of CASES) {
    const latencies: number[] = [];
    let firstOutputChars = 0;
    for (let r = 0; r < runs; r++) {
      const messages = provider.sysUser(system, buildUserMessage(c.prompt));
      try {
        const out = await provider.chat(messages, { temperature: 0, seed: 42 + r, maxTokens: 512 });
        latencies.push(out.latencyMs);
        if (r === 0) firstOutputChars = out.text.length;
      } catch {
        latencies.push(0);
      }
    }
    perCase.push({
      caseId: c.id,
      latencyMedianMs: median(latencies),
      outputChars: firstOutputChars,
    });
  }
  const lats = perCase.map(p => p.latencyMedianMs).filter(l => l > 0);
  return {
    language,
    systemPromptChars,
    perCase,
    latency: {
      p50: percentile(lats, 0.50),
      p95: percentile(lats, 0.95),
      mean: lats.reduce((a, b) => a + b, 0) / lats.length,
      min: Math.min(...lats),
      max: Math.max(...lats),
    },
    outputCharsMean: perCase.reduce((a, p) => a + p.outputChars, 0) / perCase.length,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nLatency probe — bare vs parameterized`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})`);
  console.log(`Cases: ${CASES.length}  runs/case: ${args.runs}  (median per case used for distribution)\n`);

  const runId = `latency-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });

  process.stdout.write(`  bare           `);
  let t0 = Date.now();
  const bareResult = await runCell(provider, 'bare', args.runs);
  console.log(`done (wall ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  process.stdout.write(`  parameterized  `);
  t0 = Date.now();
  const paramResult = await runCell(provider, 'parameterized', args.runs);
  console.log(`done (wall ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  console.log('');
  console.log('Metric                    │ bare       │ parameterized │ Δ');
  console.log('──────────────────────────┼────────────┼───────────────┼─────────');
  const rows: Array<[string, number, number]> = [
    ['System prompt size (chars)', bareResult.systemPromptChars, paramResult.systemPromptChars],
    ['Latency p50 (ms)', bareResult.latency.p50, paramResult.latency.p50],
    ['Latency p95 (ms)', bareResult.latency.p95, paramResult.latency.p95],
    ['Latency mean (ms)', bareResult.latency.mean, paramResult.latency.mean],
    ['Latency min (ms)', bareResult.latency.min, paramResult.latency.min],
    ['Latency max (ms)', bareResult.latency.max, paramResult.latency.max],
    ['Output mean (chars)', bareResult.outputCharsMean, paramResult.outputCharsMean],
  ];
  for (const [label, bare, param] of rows) {
    const delta = param - bare;
    const pctDelta = bare > 0 ? (delta / bare) * 100 : 0;
    const sign = delta >= 0 ? '+' : '';
    console.log(`${label.padEnd(25)} │ ${String(Math.round(bare)).padStart(10)} │ ${String(Math.round(param)).padStart(13)} │ ${sign}${Math.round(delta)} (${sign}${pctDelta.toFixed(1)}%)`);
  }
  console.log('');

  // Per-case latency comparison
  const detailLines: string[] = [];
  detailLines.push(`# Per-case latency (median of ${args.runs} runs)`);
  detailLines.push(`# Case-id │ bare-ms │ param-ms │ Δms │ bare-out-chars │ param-out-chars`);
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]!;
    const b = bareResult.perCase[i]!;
    const p = paramResult.perCase[i]!;
    const delta = p.latencyMedianMs - b.latencyMedianMs;
    detailLines.push(`${c.id.padEnd(6)} [${c.category.padEnd(15)}] │ ${String(Math.round(b.latencyMedianMs)).padStart(5)} │ ${String(Math.round(p.latencyMedianMs)).padStart(5)} │ ${(delta >= 0 ? '+' : '') + String(Math.round(delta)).padStart(5)} │ ${String(b.outputChars).padStart(5)} │ ${String(p.outputChars).padStart(5)}`);
  }
  fs.writeFileSync(path.join(outDir, 'per-case.log'), detailLines.join('\n'));

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    runsPerCase: args.runs,
    bare: bareResult,
    parameterized: paramResult,
  }, null, 2));
  console.log(`Per-case log: ${path.join(outDir, 'per-case.log')}`);
  console.log(`Summary:      ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
