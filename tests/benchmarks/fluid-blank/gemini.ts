/**
 * Minimal Gemini chat client — mirrors agent-rewrite/groq.ts's `chat()`
 * signature so run.ts can swap providers via an env-var switch.
 *
 * Pinned to gemini-3.1-flash-lite (Google's lightest 3.x tier as of
 * 2026-05). Set OPENCUES_BENCH_PROVIDER=gemini-flash-lite in the
 * environment to route through this module instead of groq.ts.
 */

import * as https from 'https';

const ENDPOINT_HOST = 'generativelanguage.googleapis.com';
export const MODEL = 'gemini-3.1-flash-lite';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Set GEMINI_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

/**
 * Adapt OpenAI-style { role, content } messages to Gemini's
 * `{ systemInstruction, contents: [{ role, parts: [{ text }] }] }`.
 *
 * Gemini uses `user` / `model` for roles (not `assistant`) and folds
 * the system message into a separate `systemInstruction` field.
 */
function toGeminiBody(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' }): string {
  const systemMsgs = messages.filter(m => m.role === 'system');
  const turnMsgs = messages.filter(m => m.role !== 'system');
  return JSON.stringify({
    systemInstruction: systemMsgs.length
      ? { parts: [{ text: systemMsgs.map(m => m.content).join('\n\n') }] }
      : undefined,
    contents: turnMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: opts.temperature ?? 0,
      maxOutputTokens: opts.maxTokens ?? 512,
      // Disable thinking entirely — biggest single latency win on
      // Gemini 3.x flash tier (cuts 200-500ms TTFT). Override via
      // OPENCUES_GEMINI_THINKING={low|high|none}; default 'none' for
      // production runtime use.
      thinkingConfig: ((): any => {
        const level = opts.reasoning ?? process.env.OPENCUES_GEMINI_THINKING ?? 'none';
        if (level === 'none' || level === 'off' || level === '0') {
          return { thinkingBudget: 0 };
        }
        // Gemini's `thinkingLevel` officially accepts 'low' | 'high'.
        // Map 'medium' to 'low' as the closest valid value (its API
        // rejects 'medium' explicitly) — the bench reports the mapping.
        const mapped = level === 'medium' ? 'low' : level;
        return { thinkingLevel: mapped };
      })(),
    },
  });
}

export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {},
): Promise<ChatResult> {
  const body = toGeminiBody(messages, opts);
  const path = `/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const t0 = Date.now();
  const data = await new Promise<string>((resolve, reject) => {
    const req = https.request({
      hostname: ENDPOINT_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
  try { parsed = JSON.parse(data); } catch { throw new Error(`Bad Gemini response: ${data.slice(0, 200)}`); }
  if (parsed.error) {
    // Soft-fail safety-blocked / parse-failed responses — let the
    // caller's parser see empty text and bail rather than killing
    // the whole run on one rejection.
    const msg = parsed.error.message ?? JSON.stringify(parsed.error);
    if (/blocked|safety|parsing|could not be parsed/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`Gemini error: ${msg}`);
  }

  // Gemini sometimes returns { finishReason: "MAX_TOKENS" } with no
  // candidates.parts when output is truncated. Treat as empty so the
  // caller's parser bails the case.
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p: any) => p.text ?? '').join('');
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
