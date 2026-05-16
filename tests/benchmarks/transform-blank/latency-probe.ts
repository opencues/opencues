/**
 * Tiny latency probe — pick 10 representative transform-blank cases,
 * run them ONCE per model × reasoning combo. Goal: answer "how fast
 * can the bigger OpenAI models return without reasoning?" without
 * burning a full 231-case suite.
 *
 * Usage (no judging, just per-case raw latency):
 *   GROQ_API_KEY=… OPENAI_API_KEY=… \
 *     OPENCUES_OPENAI_MODEL=gpt-5.4 OPENCUES_OPENAI_REASONING=none \
 *     OPENCUES_BENCH_PROVIDER=openai-nano \
 *     npx tsx tests/benchmarks/transform-blank/latency-probe.ts
 */

import { CASES } from './cases';
import { runFused } from './fused-extract-apply';
import { MODEL } from './openai';

const PROBE_IDS = [
  'literal-1',
  'multi-span-1',
  'concept-1',
  'transform-1',
  'negative-1',
  'math-1',
  'linked-1',
  'long-text-1',
  'targeted-1',
  'multi-paragraph-1',
];

async function main() {
  const cases = PROBE_IDS
    .map(id => CASES.find(c => c.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c);

  const reasoning = process.env.OPENCUES_OPENAI_REASONING ?? 'low';
  console.log(`MODEL=${MODEL}  reasoning_effort=${reasoning}  cases=${cases.length}`);

  const latencies: number[] = [];
  const t0 = Date.now();
  for (const c of cases) {
    const r = await runFused(c.input);
    latencies.push(r.latencyMs);
    const ok = r.rewrite && r.rewrite !== c.input;
    process.stdout.write(`  ${c.id.padEnd(22)} ${r.latencyMs.toString().padStart(5)}ms  ${ok ? 'OUTPUT' : 'EMPTY '}\n`);
  }
  const wallMs = Date.now() - t0;
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  console.log(`\n  mean=${mean.toFixed(0)}ms  p50=${p50}ms  min=${min}ms  max=${max}ms  wall=${(wallMs / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
