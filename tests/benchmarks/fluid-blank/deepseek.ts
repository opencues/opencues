/**
 * Minimal DeepSeek client — OpenAI-compatible chat completions for
 * deepseek-v4-flash. Same `chat()` signature as groq-impl.ts so the
 * benchmark runner can swap via env var.
 *
 * Set OPENCUES_BENCH_PROVIDER=deepseek-flash to route here.
 * Override the model via OPENCUES_DEEPSEEK_MODEL.
 *
 * Bench-only: this adapter does NOT imply a production @opencues/core
 * PROVIDERS entry. See tests/benchmarks/CLAUDE.md § "How to add a new
 * model" — step 3 is the separate production wiring.
 *
 * Probed live 2026-08-07 against deepseek-v4-flash (build
 * DeepSeek-V4-Flash-0731, `system_fingerprint` prod0820_fp8_kvcache):
 *   - `/models` lists exactly `deepseek-v4-flash` + `deepseek-v4-pro`.
 *   - Reasoning is ON by default (~15-20 reasoning tokens on a one-word
 *     lookup); the trace lands in `message.reasoning_content`, NOT in
 *     `content`, so the parser reads a clean answer either way.
 *   - `thinking: { type: 'disabled' }` zeroes reasoning tokens. This is
 *     the bench default — fluid-blank is the ≤500ms interactive surface
 *     and the reasoning tokens buy nothing on short lookups. Flip with
 *     OPENCUES_DEEPSEEK_THINKING=enabled.
 *   - `seed`, `reasoning_effort` and `response_format: json_object` are
 *     all accepted (200), though seed determinism is unverified.
 */

import * as https from 'https';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const MODEL = process.env.OPENCUES_DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

/** 'disabled' (default) | 'enabled' — maps to the `thinking` block. */
const THINKING = process.env.OPENCUES_DEEPSEEK_THINKING ?? 'disabled';

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.error('Set DEEPSEEK_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry wrapper — mirrors cerebras.ts. An empty response is treated as a
 *  throttle/malformed signal rather than a model failure, so a rate-limited
 *  sweep can't masquerade as an accuracy collapse (see
 *  tests/benchmarks/CLAUDE.md § "Things you'll trip on" #4). */
export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {},
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
  opts: { temperature?: number; maxTokens?: number; seed?: number; reasoning?: 'none' | 'low' | 'medium' | 'high' } = {},
): Promise<ChatResult> {
  const reqBody: Record<string, unknown> = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 512,
    seed: opts.seed ?? 42,
    thinking: { type: THINKING },
  };
  // Only forward reasoning_effort when the caller asked AND thinking is on
  // — with `thinking: disabled` the field is inert, and sending both is a
  // contradictory pair we'd rather not have to reason about later.
  if (opts.reasoning && THINKING === 'enabled') {
    reqBody.reasoning_effort = opts.reasoning;
  }
  const body = JSON.stringify(reqBody);

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
  try { parsed = JSON.parse(data); } catch { throw new Error(`Bad DeepSeek response: ${data.slice(0, 200)}`); }
  if (parsed.error || parsed.message?.error) {
    const msg = parsed.error?.message ?? parsed.message ?? JSON.stringify(parsed);
    if (/rate.?limit|too many requests|server is busy/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`DeepSeek error: ${msg}`);
  }

  // `reasoning_content` is a SIBLING of `content` on this API — reading
  // `content` alone already excludes the trace. No stripping needed.
  const text = parsed.choices?.[0]?.message?.content ?? '';
  if (process.env.OC_DEBUG_RAW) {
    const fr = parsed.choices?.[0]?.finish_reason;
    const rt = parsed.usage?.completion_tokens_details?.reasoning_tokens;
    const ct = parsed.usage?.completion_tokens;
    const hit = parsed.usage?.prompt_cache_hit_tokens;
    const miss = parsed.usage?.prompt_cache_miss_tokens;
    const pt = parsed.usage?.prompt_tokens;
    process.stderr.write(`[RAW] finish=${fr} reasoning_tokens=${rt} completion_tokens=${ct} prompt=${pt} cache_hit=${hit} cache_miss=${miss} contentLen=${text.length}\n`);
  }
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
