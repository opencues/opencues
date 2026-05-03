/**
 * Minimal Groq client — copied from fluid-blank/groq.ts to keep this
 * benchmark self-contained. Pinned to gpt-oss-120b for apples-to-apples
 * comparison with the fluid-blank baseline.
 */

import * as https from 'https';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const MODEL = 'openai/gpt-oss-120b';

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error('Set GROQ_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

export async function chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; seed?: number } = {}): Promise<ChatResult> {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
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
    // Soft-fail Groq-side parse errors so one bad response doesn't kill a
    // 50-case benchmark. Caller's parser will treat empty text as a bail.
    const msg = parsed.error.message ?? JSON.stringify(parsed.error);
    if (/Parsing failed|model generated output that could not be parsed/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`Groq error: ${msg}`);
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
