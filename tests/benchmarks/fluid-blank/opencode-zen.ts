/**
 * Minimal OpenCode Zen client — OpenAI-compatible chat completions at
 * `https://opencode.ai/zen/v1/chat/completions`. Same `chat()` signature
 * as groq-impl.ts so the bench runner can swap via env var.
 *
 * Set OPENCUES_BENCH_PROVIDER=opencode-zen to route here.
 * Override the model via OPENCUES_OPENCODE_ZEN_MODEL (default: big-pickle).
 *
 * Free-tier models do NOT require an API key — verified May 2026.
 * Paid models need OPENCODE_ZEN_API_KEY. The adapter sends the
 * Authorization header only when the key is present.
 *
 * NON-AGGRESSIVE THROTTLE: a per-request sleep gates anonymous traffic
 * so a sequential 137-case sweep doesn't trip the shared rate limit
 * (anonymous users almost certainly share a low TPM bucket). Default
 * 1500ms; tune via OPENCUES_OPENCODE_ZEN_DELAY_MS (set to 0 for
 * full-speed once we know the limit).
 *
 * IMPORTANT: bare model IDs (no `opencode/` prefix). The opencode.ai
 * docs say `opencode/<id>` but the live endpoint 401s on the prefixed
 * form. The /v1/models GET returns bare IDs which is what we use.
 */

import * as https from 'https';

const ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';
export const MODEL = process.env.OPENCUES_OPENCODE_ZEN_MODEL ?? 'big-pickle';

// API key is optional — free models authenticate anonymously.
const API_KEY = process.env.OPENCODE_ZEN_API_KEY ?? '';

// Throttle between requests. Default 1500ms keeps anonymous sweeps below
// what looks like a shared rate-limit ceiling (no documented number, so
// be polite). Override via OPENCUES_OPENCODE_ZEN_DELAY_MS=0 once we
// have data on the actual limit.
const DELAY_MS = (() => {
  const raw = process.env.OPENCUES_OPENCODE_ZEN_DELAY_MS;
  if (raw === undefined) return 1500;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
})();

// Use a single keep-alive socket — parallel anonymous requests are likely
// to be rate-limited as one bucket, so there's no win to multi-socket.
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

let _lastCallAt = 0;
async function throttle(): Promise<void> {
  if (DELAY_MS === 0) return;
  const elapsed = Date.now() - _lastCallAt;
  const wait = DELAY_MS - elapsed;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallAt = Date.now();
}

export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {},
): Promise<ChatResult> {
  await throttle();

  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
    seed: opts.seed ?? 42,
    reasoning_effort: opts.reasoning ?? 'low',
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const t0 = Date.now();
  const data = await new Promise<string>((resolve, reject) => {
    const u = new URL(ENDPOINT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers,
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
  try { parsed = JSON.parse(data); } catch { throw new Error(`Bad OpenCode Zen response: ${data.slice(0, 200)}`); }
  if (parsed.error || (parsed.message && parsed.code)) {
    const msg = parsed.error?.message ?? parsed.message ?? JSON.stringify(parsed);
    // Soft-fail rate-limit + parse so one bad response doesn't kill a
    // sequential sweep; the case is counted as bail/empty by the parser.
    if (/parsing|could not be parsed|rate.?limit|too many requests/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`OpenCode Zen error: ${msg}`);
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
