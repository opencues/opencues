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

/** Per-model default reasoning effort. Mirrors the production
 *  MODEL_THINKING table in @opencues/core/model-thinking.ts so the
 *  bench measures what production will actually run.
 *  - gpt-oss-120b: 'low' is the floor (reasoning model, 'none' rejected)
 *  - zai-glm-4.7: 'none' is the only useful value (any other burns
 *    500-700 reasoning tokens for no quality gain) */
function defaultReasoningFor(model: string): 'none' | 'low' | 'medium' | 'high' {
  if (model === 'zai-glm-4.7') return 'none';
  return 'low';
}

export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {},
): Promise<ChatResult> {
  // Mirror production: cerebras gpt-oss-120b uses reasoning_format:
  // "hidden" to suppress the reasoning trace from the response
  // (bench-validated tail reduction; see llm-provider.ts § hidden
  // reasoning). zai-glm-4.7 runs at reasoning_effort: 'none' so it
  // produces no reasoning text either way.
  const reqBody: Record<string, unknown> = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
    seed: opts.seed ?? 42,
    reasoning_effort: opts.reasoning ?? defaultReasoningFor(MODEL),
  };
  if (/^gpt-oss/i.test(MODEL)) {
    reqBody.reasoning_format = 'hidden';
  }
  const body = JSON.stringify(reqBody);

  // Mirror production's gzip request compression (PR June 2026, see
  // @opencues/core/node-http-adapter.js's GZIP_REQUEST_HOSTS).
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
