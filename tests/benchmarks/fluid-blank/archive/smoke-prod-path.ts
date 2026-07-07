/**
 * End-to-end smoke test: real Groq calls through the production
 * buildSourcesFromConfig path.
 *
 * Verifies:
 *   1. enableFluidBlank: true produces a FluidBlankSource in the array
 *   2. Calling .getCues() with a real httpAdapter actually returns an answer
 *   3. WIPE mode emits proper character-offset spanStart/spanEnd
 *   4. FILL mode does not set spanStart/spanEnd
 *
 * Run: GROQ_API_KEY=... npx tsx tests/benchmarks/fluid-blank/smoke-prod-path.ts
 */

import * as https from 'https';
import { buildSourcesFromConfig, FluidBlankSource } from '../../../packages/opencues-core/src/index';

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error('Set GROQ_API_KEY');
  process.exit(1);
}

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'openai/gpt-oss-120b';

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const httpAdapter = {
  post: (url: string, body: string, headers: Record<string, string>): Promise<string> =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        agent,
      }, (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => { buf += c; });
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    }),
};

async function smoke() {
  // Build the source array via the production path
  const sources = buildSourcesFromConfig(undefined, undefined, {
    httpAdapter,
    endpoint: ENDPOINT,
    apiKey: API_KEY!,
    defaultModel: MODEL,
    enableFluidBlank: true,
  });

  console.log(`Built ${sources.length} sources:`);
  for (const s of sources) console.log(`  - ${s.id} (priority ${s.priority})`);
  console.log();

  const fluid = sources.find(s => s.id === 'fluid-blank') as FluidBlankSource | undefined;
  if (!fluid) {
    console.error('FluidBlankSource not in source array — wiring broken');
    process.exit(1);
  }

  // Test cases — one of each shape
  const cases = [
    { input: 'trivia tonight capital of france _', expectedMode: 'WIPE' },
    { input: 'The capital of France is _', expectedMode: 'FILL' },
    { input: 'kids homework what\'s the speed of light in m/s? _', expectedMode: 'FILL' },
    { input: 'unicode for em dash _', expectedMode: 'WIPE' },
    { input: 'click _ to continue', expectedMode: 'WIPE' }, // P1 should bail → no result
  ];

  for (const c of cases) {
    const ctx = { text: c.input, words: c.input.split(/\s+/) };
    const t0 = Date.now();
    const out = await fluid.getCues(ctx);
    const ms = Date.now() - t0;

    console.log(`INPUT: ${c.input}`);
    if (out.results.length === 0) {
      console.log(`  (no result — P1 bailed or P3 failed) [${ms}ms]`);
      console.log(`  expected mode was: ${c.expectedMode}`);
    } else {
      const r = out.results[0];
      const mode = r.metadata?.fluidBlankMode;
      const span = r.metadata?.span;
      console.log(`  ANSWER  : ${r.alternatives[1]}`);
      console.log(`  MODE    : ${mode}  ${mode === c.expectedMode ? '\x1b[32m●\x1b[0m' : `✗ expected ${c.expectedMode}`}`);
      console.log(`  P1 SPAN : ${span}`);
      if (typeof r.spanStart === 'number') {
        console.log(`  CHAR RANGE: [${r.spanStart}, ${r.spanEnd}) → "${c.input.slice(r.spanStart, r.spanEnd)}"`);
      }
      console.log(`  TIMING  : ${ms}ms`);
    }
    console.log();
  }
}

smoke().catch(e => { console.error('FATAL:', e); process.exit(1); });
