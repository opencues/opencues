/**
 * Minimal Groq client — copy of transform-blank/groq.ts. Self-contained
 * so this benchmark can evolve independently.
 */

import * as https from 'https';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const MODEL = 'openai/gpt-oss-120b';

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error('Set GROQ_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

export async function chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; seed?: number } = {}): Promise<ChatResult> {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 1024,
    reasoning_effort: 'low',
    seed: opts.seed ?? 42,
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
  try { parsed = JSON.parse(data); } catch { throw new Error(`Bad Groq response: ${data.slice(0, 200)}`); }
  if (parsed.error) {
    const msg = parsed.error.message ?? JSON.stringify(parsed.error);
    if (/Parsing failed|model generated output that could not be parsed/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`Groq error: ${msg}`);
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  return { text, latencyMs };
}

/** Adapter shape that AgentLoop expects via its httpAdapter option. */
export const httpAdapter = {
  async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
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
    });
  },
};
