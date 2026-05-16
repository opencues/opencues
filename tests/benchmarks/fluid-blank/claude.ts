/**
 * Minimal Anthropic Messages API client — pinned to claude-haiku-4-5
 * for the cheapest/fastest tier in the Claude 4 family. Same `chat()`
 * signature as groq-impl.ts.
 *
 * Set OPENCUES_BENCH_PROVIDER=claude-haiku to route here.
 * Override the model via OPENCUES_CLAUDE_MODEL.
 *
 * NOTE: thinking is disabled (Claude 4.5 haiku doesn't support extended
 * thinking, and we explicitly want no-thinking for this benchmark).
 */

import * as https from 'https';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const MODEL = process.env.OPENCUES_CLAUDE_MODEL ?? 'claude-haiku-4-5';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Set ANTHROPIC_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number } = {},
): Promise<ChatResult> {
  // Anthropic puts system message in a top-level `system` field, not the
  // messages array. Fold every system msg into one block.
  const systemMsgs = messages.filter(m => m.role === 'system');
  const turnMsgs = messages.filter(m => m.role !== 'system');
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0,
    system: systemMsgs.length ? systemMsgs.map(m => m.content).join('\n\n') : undefined,
    messages: turnMsgs.map(m => ({ role: m.role, content: m.content })),
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
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
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
  try { parsed = JSON.parse(data); } catch { throw new Error(`Bad Claude response: ${data.slice(0, 200)}`); }
  if (parsed.type === 'error' || parsed.error) {
    const msg = parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed);
    if (/rate.?limit|overloaded|parsing/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`Claude error: ${msg}`);
  }

  // content is an array of blocks; we only emit text blocks
  const blocks = parsed.content ?? [];
  const text = blocks
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text ?? '')
    .join('');
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
