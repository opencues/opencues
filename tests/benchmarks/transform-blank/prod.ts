/**
 * Production benchmark — drives the actual `TransformBlankSource` from
 * `@opencues/core` so we measure EXACTLY what users run. There is no
 * bench-local copy of any production prompt: the single FUSED prompt
 * lives solely in
 * `packages/opencues-core/src/sources/transform-blank-source.ts`. This is
 * the single source of truth — editing it is automatically what this
 * bench measures. (TransformBlank runs ONE fused pipeline on every
 * provider; the old 3-pass groq path was retired June 2026 after groq
 * fused benched at parity — see EXPERIMENTS.md § Experiment 10.)
 *
 * (Historical note: the old `run.ts` comparative harness kept its OWN
 * copies of these prompts and drifted from production — e.g. the bench
 * APPLY prompt was missing the FILL PLACEHOLDER rule production had — so
 * a "production" bench mode silently measured a stale prompt. That
 * harness now lives in `archive/`; this runner replaces it.)
 *
 * Usage:
 *   CEREBRAS_API_KEY=xxx GROQ_API_KEY=xxx \
 *     npx tsx tests/benchmarks/transform-blank/prod.ts [--provider cerebras|groq] [--parallel N]
 *
 * Flags: `--provider cerebras|groq` (default cerebras),
 * `--parallel N` (default 8). GROQ_API_KEY is always required — the JUDGE
 * pins to groq gpt-oss-120b regardless of inference provider (see
 * EXPERIMENTS.md § Experiment 6). The selected inference provider's key
 * (CEREBRAS_API_KEY / GROQ_API_KEY) is required too.
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
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// The inference-provider key is validated in buildSource (only the
// selected provider's key is required). GROQ_KEY is always needed — the
// judge is pinned to groq gpt-oss-120b regardless of inference provider.
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

const CEREBRAS_MODEL = process.env.OPENCUES_CEREBRAS_MODEL ?? 'gpt-oss-120b';
const GROQ_MODEL = process.env.OPENCUES_GROQ_MODEL ?? 'openai/gpt-oss-120b';
const GEMINI_MODEL = process.env.OPENCUES_GEMINI_MODEL ?? 'gemini-3.1-flash-lite';

// Provider wiring. TransformBlank runs a SINGLE fused pipeline on every
// provider (the prompt lives solely in @opencues/core's FUSED_SYSTEM), so
// this just selects the endpoint/model to measure that one shape against.
const PROVIDERS: Record<string, { endpoint: string; key: string | undefined; model: string }> = {
  cerebras: { endpoint: 'https://api.cerebras.ai/v1/chat/completions', key: CEREBRAS_KEY, model: CEREBRAS_MODEL },
  groq:     { endpoint: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY, model: GROQ_MODEL },
  gemini:   { endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', key: GEMINI_KEY, model: GEMINI_MODEL },
};

function buildSource(providerId: string): TransformBlankSource {
  const p = PROVIDERS[providerId];
  if (!p) { console.error(`Unknown provider "${providerId}". Known: ${Object.keys(PROVIDERS).join(', ')}`); process.exit(1); }
  if (!p.key) { console.error(`Set ${providerId.toUpperCase()}_API_KEY to bench provider "${providerId}".`); process.exit(1); }
  return new TransformBlankSource({
    httpAdapter,
    provider: getProvider(providerId)!,
    endpoint: p.endpoint,
    apiKey: p.key,
    model: p.model,
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
  const argVal = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const parallel = argVal('--parallel') ? parseInt(argVal('--parallel')!, 10) : 8;
  // Single fused pipeline on every provider; --provider selects which one
  // to measure (default cerebras).
  const provider = argVal('--provider') ?? 'cerebras';
  console.log(`${BOLD}transform-blank PROD benchmark${RESET}  ${DIM}(drives @opencues/core TransformBlankSource — no bench-local prompt)${RESET}`);
  console.log(`Provider: ${provider} ${PROVIDERS[provider]?.model ?? '?'} (fused)`);
  console.log(`Judge: groq gpt-oss-120b (pinned)`);
  console.log(`Cases: ${CASES.length}  parallel=${parallel}\n`);

  // --only-file <path>: surgically re-run just the case ids listed in the
  // file (one id per line). Used to re-test failures cleanly (e.g. strip
  // throttle-induced bails) without re-running the whole suite.
  const onlyFile = argVal('--only-file');
  let cases = CASES;
  if (onlyFile) {
    const ids = new Set(require('fs').readFileSync(onlyFile, 'utf8').split('\n').map((s: string) => s.trim()).filter(Boolean));
    cases = CASES.filter(c => ids.has(c.id));
    console.log(`${DIM}--only-file: re-running ${cases.length} of ${CASES.length} cases${RESET}`);
  }

  const source = buildSource(provider);
  const wall0 = Date.now();
  const outcomes = await runWithConcurrency(cases, c => runOne(c, source), parallel);
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
