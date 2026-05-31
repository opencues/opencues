/**
 * fluid-config switch-provider bench — entry point.
 *
 * Runs every case in cases.ts against the LIVE SYSTEM_PROMPT exported
 * from packages/opencues-core/src/sources/config-intent-source.ts.
 * Drift between bench prompt and shipped prompt is impossible — they
 * are the same string.
 *
 * Two metrics:
 *
 *   PRECISION (gate) — among reject cases (kind='none'), % correctly
 *                      classified. A false-positive is the security-
 *                      relevant outcome (routing prose to a training
 *                      pool, mis-routing a provider when user meant
 *                      a lookup). Target ≥ 95%.
 *   RECALL           — among hit cases (provider + setting), % where
 *                      scope+provider (+ optionally model) match.
 *                      Target ≥ 80%.
 *
 * Per-category breakdown shows where the prompt is fragile.
 *
 * Usage:
 *   GROQ_API_KEY=xxx tsx tests/benchmarks/fluid-config-switch-provider/run.ts
 *   GROQ_API_KEY=xxx tsx tests/benchmarks/fluid-config-switch-provider/run.ts --parallel 8
 *   OPENCUES_BENCH_PROVIDER=cerebras CEREBRAS_API_KEY=xxx tsx ... --parallel 8
 *   tsx ... --case po-cues-anthropic           # one case
 *   tsx ... --category hit-provider-and-model  # one bucket
 *   tsx ... --verbose                          # print raw LLM output per case
 */

import { CASES, SwitchProviderCase } from './cases';
import { judge, Verdict, ActualVerdict } from './judge';
import {
  SYSTEM_PROMPT,
  parseConfigIntentOutput,
  validateAgainstRegistry,
} from '../../../packages/opencues-core/src/sources/config-intent-source';
import {
  dispatchChat,
  getProvider,
  type ProviderAdapter,
} from '../../../packages/opencues-core/src/llm-provider';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NodeHttpAdapter } = require('../../../packages/opencues-core/node-http-adapter') as {
  NodeHttpAdapter: new (opts?: { maxSockets?: number; timeout?: number }) => {
    post: (url: string, body: string, headers?: Record<string, string>) => Promise<string>;
  };
};
const httpAdapter = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface Args {
  caseId?: string;
  category?: string;
  parallel: number;
  verbose: boolean;
}

function parseArgs(): Args {
  const out: Args = { parallel: 1, verbose: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') out.caseId = args[++i];
    else if (args[i] === '--category') out.category = args[++i];
    else if (args[i] === '--verbose' || args[i] === '-v') out.verbose = true;
    else if (args[i] === '--parallel') {
      const v = parseInt(args[++i], 10);
      if (Number.isNaN(v) || v < 1) {
        console.error(`--parallel must be a positive integer, got: ${args[i]}`);
        process.exit(2);
      }
      out.parallel = v;
    }
  }
  return out;
}

function pickBenchProvider(): { provider: ProviderAdapter; apiKey: string; model: string } {
  // Mirror tests/benchmarks/fluid-config/groq.ts shape but route by
  // env var OPENCUES_BENCH_PROVIDER. Default: groq (matches our other
  // bench defaults; cheapest free tier with decent throughput).
  const envChoice = process.env.OPENCUES_BENCH_PROVIDER || 'groq';
  const aliases: Record<string, string> = {
    'cerebras-gpt-oss': 'cerebras',
    'gemini-flash-lite': 'gemini',
    'claude-haiku': 'anthropic',
    'openai-nano': 'openai',
  };
  const providerId = aliases[envChoice] ?? envChoice;
  const provider = getProvider(providerId);
  if (!provider) {
    console.error(`Unknown OPENCUES_BENCH_PROVIDER=${envChoice}; expected one of: groq, cerebras, anthropic, gemini, openai`);
    process.exit(2);
  }
  const apiKey = provider.envKeyName ? process.env[provider.envKeyName] : '';
  if (!apiKey && !provider.optionalAuth && provider.transport !== 'cli') {
    console.error(`${provider.envKeyName} unset — needed for provider '${providerId}'`);
    process.exit(2);
  }
  return { provider, apiKey: apiKey ?? '', model: provider.defaultModel };
}

interface RunOutcome {
  caseId: string;
  category: string;
  input: string;
  raw: string;
  actual: ActualVerdict;
  judge: ReturnType<typeof judge>;
  latencyMs: number;
}

async function runOne(c: SwitchProviderCase, ctx: ReturnType<typeof pickBenchProvider>): Promise<RunOutcome> {
  const t0 = Date.now();
  let raw = '';
  try {
    raw = await dispatchChat(
      ctx.provider,
      httpAdapter,
      {
        model: ctx.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `INPUT: ${c.input}` },
        ],
        maxTokens: 256,
        temperature: 0,
        seed: 42,
      },
      { apiKey: ctx.apiKey },
    );
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const actual: ActualVerdict = { kind: 'none' };
    return {
      caseId: c.id,
      category: c.category,
      input: c.input,
      raw: `[LLM ERROR] ${(e as Error).message}`,
      actual,
      judge: judge(c, actual),
      latencyMs,
    };
  }
  const latencyMs = Date.now() - t0;

  const parsed = parseConfigIntentOutput(raw);
  const check = validateAgainstRegistry(parsed);

  // For bench judging purposes, an invalid-but-non-none verdict
  // counts as NONE (the runtime would cede). This matches what the
  // user actually experiences.
  let actual: ActualVerdict;
  if (!check.ok) {
    actual = { kind: 'none' };
  } else if (parsed.kind === 'none') {
    actual = { kind: 'none' };
  } else if (parsed.kind === 'setting') {
    actual = { kind: 'setting', setting: parsed.setting, value: parsed.value };
  } else {
    actual = {
      kind: 'provider',
      scope: parsed.scope,
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  return {
    caseId: c.id,
    category: c.category,
    input: c.input,
    raw,
    actual,
    judge: judge(c, actual),
    latencyMs,
  };
}

async function runAll(cases: SwitchProviderCase[], ctx: ReturnType<typeof pickBenchProvider>, parallel: number, verbose: boolean): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = new Array(cases.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= cases.length) return;
      outcomes[i] = await runOne(cases[i], ctx);
      printOneLine(outcomes[i], verbose);
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return outcomes;
}

function printOneLine(o: RunOutcome, verbose: boolean): void {
  const v = o.judge.verdict;
  const color = o.judge.pass ? GREEN : (v === 'FP' ? RED : YELLOW);
  const tag = `${color}${BOLD}${v.padEnd(14)}${RESET}`;
  console.log(`${tag} ${DIM}${o.caseId.padEnd(34)}${RESET} ${o.input}`);
  if (!o.judge.pass) {
    console.log(`               ${DIM}${o.judge.rationale}${RESET}`);
  }
  if (verbose) {
    console.log(`               ${DIM}raw: ${o.raw.replace(/\n/g, ' ⏎ ').slice(0, 200)}${RESET}`);
  }
}

function summarise(outcomes: RunOutcome[]): void {
  console.log('');
  console.log(`${BOLD}── Results ──${RESET}`);

  const verdictCounts: Record<string, number> = {};
  for (const o of outcomes) {
    verdictCounts[o.judge.verdict] = (verdictCounts[o.judge.verdict] ?? 0) + 1;
  }

  // Hit / reject metrics
  const rejects = outcomes.filter(o => {
    const c = CASES.find(cc => cc.id === o.caseId)!;
    return c.expected.kind === 'none';
  });
  const hits = outcomes.filter(o => {
    const c = CASES.find(cc => cc.id === o.caseId)!;
    return c.expected.kind !== 'none';
  });
  const tn = rejects.filter(o => o.judge.verdict === 'TN').length;
  const tp = hits.filter(o => o.judge.pass).length;
  const fp = rejects.filter(o => o.judge.verdict === 'FP').length;

  const precision = rejects.length === 0 ? 100 : (tn / rejects.length) * 100;
  const recall = hits.length === 0 ? 100 : (tp / hits.length) * 100;

  console.log(`${BOLD}Precision${RESET}: ${precision.toFixed(1)}%  ${DIM}(${tn}/${rejects.length} rejects correctly classified)${RESET}`);
  console.log(`${BOLD}Recall${RESET}:    ${recall.toFixed(1)}%  ${DIM}(${tp}/${hits.length} hits correctly classified)${RESET}`);
  console.log(`${BOLD}FP${RESET} (security-critical): ${fp === 0 ? GREEN : RED}${fp}${RESET}`);

  console.log('');
  console.log(`${BOLD}Per-verdict counts:${RESET}`);
  for (const v of ['TP-PROVIDER', 'TP-SETTING', 'TN', 'FN', 'FP', 'WRONG-KIND', 'WRONG-SCOPE', 'WRONG-PROVIDER', 'WRONG-MODEL'] as Verdict[]) {
    const n = verdictCounts[v] ?? 0;
    if (n === 0) continue;
    console.log(`  ${v.padEnd(14)} ${n}`);
  }

  // Per-category breakdown
  console.log('');
  console.log(`${BOLD}Per-category:${RESET}`);
  const categories = [...new Set(outcomes.map(o => o.category))].sort();
  for (const cat of categories) {
    const byCat = outcomes.filter(o => o.category === cat);
    const passed = byCat.filter(o => o.judge.pass).length;
    const pct = (passed / byCat.length) * 100;
    const col = pct >= 80 ? GREEN : pct >= 60 ? YELLOW : RED;
    console.log(`  ${col}${pct.toFixed(0).padStart(3)}%${RESET} ${cat.padEnd(28)} ${DIM}${passed}/${byCat.length}${RESET}`);
  }

  // Per-case latency summary
  const latencies = outcomes.map(o => o.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  console.log('');
  console.log(`${DIM}Latency: p50 ${p50}ms · p95 ${p95}ms${RESET}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const ctx = pickBenchProvider();

  let cases = CASES;
  if (args.caseId) cases = cases.filter(c => c.id === args.caseId);
  if (args.category) cases = cases.filter(c => c.category === args.category);
  if (cases.length === 0) {
    console.error('no cases matched the filter');
    process.exit(2);
  }

  console.log(`${BOLD}fluid-config switch-provider bench${RESET}`);
  console.log(`${DIM}provider: ${ctx.provider.id} · model: ${ctx.model} · cases: ${cases.length} · parallel: ${args.parallel}${RESET}`);
  console.log('');

  const outcomes = await runAll(cases, ctx, args.parallel, args.verbose);
  summarise(outcomes);

  const failed = outcomes.filter(o => !o.judge.pass).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('bench crashed:', e);
  process.exit(2);
});
