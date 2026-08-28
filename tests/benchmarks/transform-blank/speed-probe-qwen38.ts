/**
 * speed-probe-qwen38 — clean (non-rate-limit-contaminated) latency
 * measurement for qwen/qwen3.8-27b on transform-blank, and a check of
 * whether disabling reasoning (`max-thinking: off` → reasoning_effort:
 * 'none' instead of production's default 'low') meaningfully speeds it
 * up.
 *
 * Context: the full prod.ts run against this model showed model=Xms
 * clustering at ~16.5s / ~33s / ~65s — near-exact multiples of the
 * ~16s wait this preview-tier model's 8000 TPM cap forces via
 * production's own dispatchChat rate-limit backoff (see BENCHMARKS.md
 * "Qwen 3.8 27B on Groq — spot-check"). Only 2 of 38 cases got a
 * zero-wait attempt (~9s), too few to trust. This probe forces a
 * zero-wait attempt on EVERY call by sleeping long enough between
 * calls (default 65s — comfortably longer than Groq's rolling 60s TPM
 * window) that the quota is always fresh, so `modelMs` here is real
 * model+network latency, not backoff-contaminated.
 *
 * Drives the REAL production TransformBlankSource (same as prod.ts —
 * no bench-local prompt), just with maxThinking toggled and spacing
 * inserted between calls.
 *
 * Usage:
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/transform-blank/speed-probe-qwen38.ts
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/transform-blank/speed-probe-qwen38.ts --gap-ms 75000
 */

import { TransformBlankSource } from '../../../packages/opencues-core/src/sources/transform-blank-source';
import { getProvider } from '../../../packages/opencues-core/src/llm-provider';
import type { HttpAdapter, CueContext } from '../../../packages/opencues-core/src/types';
import { CASES } from './cases';
import * as https from 'https';
import * as http from 'http';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';

const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) { console.error('Set GROQ_API_KEY'); process.exit(1); }

const MODEL = process.env.OPENCUES_GROQ_MODEL ?? 'qwen/qwen3.8-27b';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// Same adapter shape as prod.ts (single-attempt is fine here — no
// need for its transient-retry loop across a 231-case sweep).
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const httpAdapter: HttpAdapter = {
  post: (url, body, headers) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttp = u.protocol === 'http:';
    const req = (isHttp ? http : https).request({
      hostname: u.hostname,
      port: u.port || (isHttp ? 80 : 443),
      path: u.pathname + (u.search ?? ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers ?? {}), 'Content-Length': Buffer.byteLength(body) },
      agent: isHttp ? httpAgent : agent,
      timeout: 30_000,
    }, (res) => {
      let buf = ''; res.on('data', (c: Buffer) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.write(body); req.end();
  }),
};

function buildContext(input: string): CueContext {
  const words = input.split(/\s+/).filter(Boolean);
  return { text: input, words, blankIndices: words.map((w, i) => w === '_' ? i : -1).filter(i => i >= 0) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A small, deliberately varied sample: one short literal edit, one
// long-text edit (the biggest output-token cost), one tone-shift
// (semantically hardest — most likely to lean on real reasoning), one
// format-transform (structurally different task shape).
const SAMPLE_IDS = ['literal-1', 'long-A1', 'tone-1', 'format-1'];

async function main() {
  const gapMs = (() => {
    const i = process.argv.indexOf('--gap-ms');
    return i >= 0 ? parseInt(process.argv[i + 1], 10) : 65_000;
  })();

  const cases = SAMPLE_IDS.map(id => CASES.find(c => c.id === id)!).filter(Boolean);
  console.log(`${BOLD}speed-probe-qwen38${RESET}  ${DIM}(clean latency, no rate-limit contamination — ${gapMs}ms gap between every call)${RESET}`);
  console.log(`Model: groq ${MODEL}\nCases: ${cases.map(c => c.id).join(', ')}\n`);

  const sourceOn = new TransformBlankSource({
    httpAdapter, provider: getProvider('groq')!, endpoint: ENDPOINT, apiKey: GROQ_KEY, model: MODEL,
    maxThinking: true, // production default — reasoning_effort: 'low'
  });
  const sourceOff = new TransformBlankSource({
    httpAdapter, provider: getProvider('groq')!, endpoint: ENDPOINT, apiKey: GROQ_KEY, model: MODEL,
    maxThinking: false, // reasoning_effort: 'none' for unlisted models (see model-thinking.ts notchBelow)
  });

  const rows: Array<{ id: string; onMs: number; offMs: number }> = [];

  for (const c of cases) {
    // maxThinking: true (production default)
    await sleep(gapMs);
    const t0 = Date.now();
    const rOn = await sourceOn.getCues(buildContext(c.input));
    const onMs = Date.now() - t0;
    const rewriteOn = rOn.results[0]?.alternatives?.[1] ?? '(bailed)';
    console.log(`${CYAN}${c.id}${RESET} maxThinking=on   ${BOLD}${onMs}ms${RESET}  ${DIM}${rewriteOn.slice(0, 60)}${RESET}`);

    // maxThinking: false
    await sleep(gapMs);
    const t1 = Date.now();
    const rOff = await sourceOff.getCues(buildContext(c.input));
    const offMs = Date.now() - t1;
    const rewriteOff = rOff.results[0]?.alternatives?.[1] ?? '(bailed)';
    console.log(`${CYAN}${c.id}${RESET} maxThinking=off  ${BOLD}${offMs}ms${RESET}  ${DIM}${rewriteOff.slice(0, 60)}${RESET}`);

    rows.push({ id: c.id, onMs, offMs });
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`${BOLD}Case          maxThinking=on   maxThinking=off   delta${RESET}`);
  let sumOn = 0, sumOff = 0;
  for (const r of rows) {
    sumOn += r.onMs; sumOff += r.offMs;
    const delta = r.onMs - r.offMs;
    console.log(`${r.id.padEnd(14)}${String(r.onMs + 'ms').padEnd(17)}${String(r.offMs + 'ms').padEnd(18)}${delta >= 0 ? '-' : '+'}${Math.abs(delta)}ms`);
  }
  console.log(`${DIM}Avg: on=${(sumOn / rows.length).toFixed(0)}ms  off=${(sumOff / rows.length).toFixed(0)}ms${RESET}`);
}

main().catch(err => { console.error(err); process.exit(1); });
