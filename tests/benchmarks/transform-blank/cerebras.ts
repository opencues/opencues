/**
 * Minimal Cerebras client — OpenAI-compatible chat completions for
 * gpt-oss-120b on Cerebras inference. Same `chat()` signature as
 * groq-impl.ts so the benchmark runner can swap via env var.
 *
 * Set OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss to route here.
 * Override the model via OPENCUES_CEREBRAS_MODEL.
 */

import * as https from 'https';
import { gzipSync } from 'node:zlib';

const ENDPOINT = 'https://api.cerebras.ai/v1/chat/completions';
export const MODEL = process.env.OPENCUES_CEREBRAS_MODEL ?? 'gpt-oss-120b';

const API_KEY = process.env.CEREBRAS_API_KEY;
if (!API_KEY) {
  console.error('Set CEREBRAS_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry wrapper — see fluid-blank/cerebras.ts. The hackathon-tier key
 *  throttles; the rate-limit branch returns empty content, which would
 *  silently bail the case. Retry empty responses with exponential backoff
 *  so accuracy reflects the model, not the key's TPM ceiling. */
export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number } = {},
): Promise<ChatResult> {
  const maxAttempts = Number(process.env.OC_BENCH_RETRIES ?? 6);
  let lastEmpty: ChatResult = { text: '', latencyMs: 0 };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await chatOnce(messages, opts);
    if (r.text.trim().length > 0) return r;
    lastEmpty = r;
    await sleep(250 * Math.pow(2, attempt));
  }
  return lastEmpty;
}

async function chatOnce(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number } = {},
): Promise<ChatResult> {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
    seed: opts.seed ?? 42,
    // Match Groq's gpt-oss-120b config for fair apples-to-apples.
    // Override via OPENCUES_CEREBRAS_REASONING=medium for probes that
    // need to mirror production (production uses 'medium' for
    // transform-blank — see llm-provider.ts).
    // zai-glm-4.7 requires 'none' — any non-none value burns 500-700
    // reasoning tokens for no quality gain (see model-thinking.ts).
    // gemma-4-31b is non-reasoning: a non-'none' value routes output into
    // the `reasoning` field and empties `content` (parser reads content).
    reasoning_effort: (process.env.OPENCUES_CEREBRAS_REASONING ?? (MODEL === 'zai-glm-4.7' || MODEL === 'gemma-4-31b' ? 'none' : 'low')) as 'none' | 'low' | 'medium' | 'high',
  });

  // Mirror production's gzip request compression (PR June 2026, see
  // @opencues/core/node-http-adapter.js's GZIP_REQUEST_HOSTS). Keeps
  // bench wire-shape identical to production so latency comparisons
  // are honest.
  const wireBody = gzipSync(Buffer.from(body, 'utf8'));
  const t0 = Date.now();
  const data = await new Promise<string>((resolve, reject) => {
    const u = new URL(ENDPOINT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': wireBody.length,
      },
      agent,
    }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.write(wireBody);
    req.end();
  });
  const latencyMs = Date.now() - t0;

  let parsed: any;
  try { parsed = JSON.parse(data); } catch { throw new Error(`Bad Cerebras response: ${data.slice(0, 200)}`); }
  if (parsed.error || parsed.message?.error) {
    const msg = parsed.error?.message ?? parsed.message ?? JSON.stringify(parsed);
    if (/parsing|could not be parsed|rate.?limit/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`Cerebras error: ${msg}`);
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
