/**
 * Production-fused benchmark — drives the actual `TransformBlankSource`
 * from `@opencues/core` (via its source file) so we measure what users
 * will actually run, not a separate benchmark prompt.
 *
 * Usage:
 *   CEREBRAS_API_KEY=xxx GROQ_API_KEY=xxx \
 *     npx tsx tests/benchmarks/transform-blank/prod-fused.ts [--parallel N]
 *
 * Set CEREBRAS_API_KEY for the production inference path. GROQ_API_KEY is
 * also required because the JUDGE pins to Groq gpt-oss-120b regardless
 * of inference provider (see transform-blank EXPERIMENTS.md § Experiment 6).
 *
 * Compares against `--mode fused` in `run.ts`, which uses a separate
 * (benchmark-only) fused prompt. If production fused matches benchmark
 * fused within ±2pp accuracy, the prod port is faithful.
 */

import { TransformBlankSource } from '../../../packages/opencues-core/src/sources/transform-blank-source';
import { getProvider } from '../../../packages/opencues-core/src/llm-provider';
import type { HttpAdapter, CueContext } from '../../../packages/opencues-core/src/types';
import { CASES, type TransformCase } from './cases';
import { judge, type JudgeInput } from './judge';
import * as https from 'https';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
if (!CEREBRAS_KEY) { console.error('Set CEREBRAS_API_KEY'); process.exit(1); }
if (!GROQ_KEY)     { console.error('Set GROQ_API_KEY (judge pin)'); process.exit(1); }

// Tiny Node-https HTTP adapter — same shape as the runtime's
// node-http-adapter but inlined here to keep the bench self-contained.
// Adds 2-retry on transient connect errors (ETIMEDOUT / ECONNRESET /
// ENETUNREACH) so a single network blip doesn't kill a 231-case run.
const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });
function postOnce(url: string, body: string, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search ?? ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers ?? {}), 'Content-Length': Buffer.byteLength(body) },
      agent,
      timeout: 30_000,
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.write(body);
    req.end();
  });
}
const transientCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNREFUSED']);
const httpAdapter: HttpAdapter = {
  post: async (url, body, headers) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await postOnce(url, body, headers); }
      catch (err) {
        lastErr = err;
        const code = (err as { code?: string }).code;
        const errors = (err as { errors?: Array<{ code?: string }> }).errors;
        const transient = (code && transientCodes.has(code))
          || errors?.some(e => e.code && transientCodes.has(e.code));
        if (!transient) throw err;
        // backoff: 500ms, 1500ms
        await new Promise(r => setTimeout(r, 500 + attempt * 1000));
      }
    }
    throw lastErr;
  },
};

function buildSource(): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: CEREBRAS_KEY!,
    model: 'gpt-oss-120b',
    mode: 'fused', // explicit — what we're testing
  });
}

async function runWithConcurrency<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, conc: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

interface Outcome { pass: boolean; modelMs: number; judgeMs: number; output: string; }

function buildContext(input: string): CueContext {
  // Production TransformBlank takes a CueContext with words array. Split
  // on whitespace, preserving the `_` token.
  const words = input.split(/\s+/).filter(Boolean);
  return { text: input, words, blankIndices: words.map((w, i) => w === '_' ? i : -1).filter(i => i >= 0) };
}

async function runOne(c: TransformCase, source: TransformBlankSource): Promise<Outcome> {
  return runOneInner(c, source).catch(err => {
    const modelMs = 0;
    return {
      pass: false,
      modelMs,
      judgeMs: 0,
      output: `${'─'.repeat(78)}\n${BOLD}${c.id}${RESET}  ${DIM}[${c.category}]${RESET}  ${RED}FAIL${RESET}\n  ${YELLOW}ERROR  :${RESET} ${(err as Error).message ?? err}`,
    };
  });
}

async function runOneInner(c: TransformCase, source: TransformBlankSource): Promise<Outcome> {
  const t0 = Date.now();
  const result = await source.getCues(buildContext(c.input));
  const modelMs = Date.now() - t0;
  const rewrite = result.results[0]?.alternatives?.[1] ?? null;
  const actualBail = result.results.length === 0 || !rewrite;

  const judgeInput: JudgeInput = {
    input: c.input,
    expected: c.expected.finalText ?? null,
    alternates: c.expected.finalTextAlternates ?? [],
    actual: rewrite,
    actualBail,
    expectedBail: !!c.expected.shouldFailSoft,
  };
  const j = await judge(judgeInput);
  const pass = j.verdict === 'PASS';
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const lines: string[] = [];
  lines.push('─'.repeat(78));
  lines.push(`${BOLD}${c.id}${RESET}  ${DIM}[${c.category}]${RESET}  ${tag}`);
  lines.push(`  ${DIM}INPUT  :${RESET} ${c.input}`);
  lines.push(`  ${DIM}EXP    :${RESET} ${c.expected.finalText ?? '(bail)'}`);
  lines.push(`  ${DIM}ACTUAL :${RESET} ${rewrite ?? '(bailed)'}`);
  lines.push(`  ${DIM}JUDGE  :${RESET} ${j.rationale}`);
  lines.push(`  ${DIM}TIMING :${RESET} model=${modelMs}ms  judge=${j.latencyMs}ms`);
  if (!pass) lines.push(`  ${YELLOW}META   :${RESET} ${JSON.stringify(result.results[0]?.metadata ?? {})}`);
  return { pass, modelMs, judgeMs: j.latencyMs, output: lines.join('\n') };
}

async function main() {
  const parallel = (() => {
    const i = process.argv.indexOf('--parallel');
    return i >= 0 ? parseInt(process.argv[i + 1], 10) : 8;
  })();
  console.log(`${BOLD}transform-blank PROD FUSED benchmark${RESET}`);
  console.log(`Provider: cerebras gpt-oss-120b (mode=fused)`);
  console.log(`Judge: groq gpt-oss-120b (pinned)`);
  console.log(`Cases: ${CASES.length}  parallel=${parallel}\n`);

  const source = buildSource();
  const wall0 = Date.now();
  const outcomes = await runWithConcurrency(CASES, c => runOne(c, source), parallel);
  const wallMs = Date.now() - wall0;

  for (const o of outcomes) console.log(o.output);

  const passed = outcomes.filter(o => o.pass).length;
  const totModel = outcomes.reduce((a, o) => a + o.modelMs, 0);
  const totJudge = outcomes.reduce((a, o) => a + o.judgeMs, 0);
  const byCat = new Map<string, { p: number; t: number }>();
  for (let i = 0; i < outcomes.length; i++) {
    const c = CASES[i]; const o = outcomes[i];
    const s = byCat.get(c.category) ?? { p: 0, t: 0 };
    s.t++; if (o.pass) s.p++; byCat.set(c.category, s);
  }
  console.log('='.repeat(78));
  for (const [cat, s] of byCat) {
    console.log(`${cat.padEnd(20)} ${s.p}/${s.t} (${((s.p / s.t) * 100).toFixed(1)}%)`);
  }
  console.log('─'.repeat(78));
  console.log(`${BOLD}Total:${RESET}        ${passed}/${CASES.length} (${((passed / CASES.length) * 100).toFixed(1)}%)`);
  console.log(`Avg model: ${(totModel / CASES.length).toFixed(0)}ms  Avg judge: ${(totJudge / CASES.length).toFixed(0)}ms`);
  console.log(`Wall-clock total: ${(wallMs / 1000).toFixed(1)}s  (parallel=${parallel})`);
  console.log(`Throughput: ${(CASES.length / (wallMs / 1000)).toFixed(2)} cases/sec`);
  process.exit(passed === CASES.length ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
