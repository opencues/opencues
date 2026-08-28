/**
 * Groq client pinned to Qwen 3.8 27B (`qwen/qwen3.8-27b`) — a spot-check
 * provider for the newly-added Groq preview model (Aug 2026). Same shape
 * as cerebras.ts / groq-impl.ts so the benchmark runner can swap via env
 * var.
 *
 * Set OPENCUES_BENCH_PROVIDER=groq-qwen38 to route here.
 * Override the model via OPENCUES_GROQ_QWEN_MODEL (e.g. to spot-check the
 * sibling qwen/qwen3.6-27b without a second file).
 */

import * as https from 'https';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const MODEL = process.env.OPENCUES_GROQ_QWEN_MODEL ?? 'qwen/qwen3.8-27b';

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) {
  console.error('Set GROQ_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** qwen/qwen3.8-27b is a Groq PREVIEW-tier model with an org-wide TPM
 *  cap of just 8000 (confirmed live, Aug 2026 — see the "Rate limit
 *  reached... Limit 8000" error body). That's ~2-8 calls/min depending
 *  on prompt size, so a naive fixed backoff either under-waits (still
 *  429s) or over-waits (wastes the window). Instead: parse Groq's own
 *  "Please try again in Xs" from the error body and sleep exactly that
 *  (+500ms buffer), falling back to exponential backoff only when the
 *  body doesn't carry a wait hint. */
let lastRateLimitWaitMs: number | null = null;
export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {},
): Promise<ChatResult> {
  const maxAttempts = Number(process.env.OC_BENCH_RETRIES ?? 6);
  let lastEmpty: ChatResult = { text: '', latencyMs: 0 };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastRateLimitWaitMs = null;
    const r = await chatOnce(messages, opts);
    if (r.text.trim().length > 0) return r;
    lastEmpty = r;
    const waitMs = lastRateLimitWaitMs ?? 250 * Math.pow(2, attempt);
    await sleep(waitMs);
  }
  return lastEmpty;
}

async function chatOnce(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {},
): Promise<ChatResult> {
  // qwen/qwen3.8-27b is a dual-mode (thinking/instruct) model — mirror
  // production's groq default of reasoning_effort: 'low' unless the
  // caller overrides it (see llm-provider.ts's GroqProvider defaultReasoningEffort).
  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
    seed: opts.seed ?? 42,
    reasoning_effort: opts.reasoning ?? 'low',
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
  if (parsed.error || parsed.message?.error) {
    const msg = parsed.error?.message ?? parsed.message ?? JSON.stringify(parsed);
    if (/rate.?limit/i.test(msg)) {
      const waitMatch = /try again in ([\d.]+)s/i.exec(msg);
      lastRateLimitWaitMs = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500 : null;
      // Always log — this is signal, not noise: a silently-swallowed
      // rate-limit reads as "model produced no answer" to every
      // downstream case, which is indistinguishable from a real model
      // failure without this line (see CLAUDE.md's silent-catch bug class).
      process.stderr.write(`[qwen38] rate-limited, waiting ${lastRateLimitWaitMs ?? '(backoff)'}ms: ${msg}\n`);
      return { text: '', latencyMs };
    }
    if (/parsing|could not be parsed/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`Groq error: ${msg}`);
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  if (process.env.OC_DEBUG_RAW) {
    const fr = parsed.choices?.[0]?.finish_reason;
    const rt = parsed.usage?.completion_tokens_details?.reasoning_tokens;
    const ct = parsed.usage?.completion_tokens;
    process.stderr.write(`[RAW] finish=${fr} reasoning_tokens=${rt} completion_tokens=${ct} contentLen=${text.length}\n`);
  }
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
