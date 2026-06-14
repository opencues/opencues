/**
 * Minimal Cerebras client — OpenAI-compatible chat completions for
 * gpt-oss-120b on Cerebras inference. Same `chat()` signature as
 * groq-impl.ts so the benchmark runner can swap via env var.
 *
 * Set OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss to route here.
 * Override the model via OPENCUES_CEREBRAS_MODEL.
 */

import * as https from 'https';

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

export async function chat(
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
    reasoning_effort: (process.env.OPENCUES_CEREBRAS_REASONING ?? (MODEL === 'zai-glm-4.7' ? 'none' : 'low')) as 'none' | 'low' | 'medium' | 'high',
  });

  const t0 = Date.now();
  const data = await new Promise<string>((resolve, reject) => {
    const u = new URL(ENDPOINT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
      agent,
    }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.write(body);
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
