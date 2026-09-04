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
  const override = process.env.OPENCUES_CEREBRAS_REASONING;
  if (override === 'none' || override === 'low' || override === 'medium' || override === 'high') return override;
  if (model === 'zai-glm-4.7') return 'none';
  // gemma-4-31b is non-reasoning: any non-'none' value routes the answer
  // into the `reasoning` field and leaves `content` empty (the parser
  // reads `content` → every case would score 0). Force 'none'.
  if (model === 'gemma-4-31b') return 'none';
  // qwen-3.8-27b is a hybrid reasoning model: accepts none|low|medium|high;
  // 'none' fully disables thinking. Production pins 'low' (MODEL_THINKING
  // ceiling — 137/137 fluid at 'low' vs 135/137 at 'none', ~equal latency).
  // Sweep alternatives via OPENCUES_CEREBRAS_REASONING.
  if (model === 'qwen-3.8-27b') return 'low';
  return 'low';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry wrapper — the hackathon-tier key throttles aggressively and the
 *  adapter would otherwise swallow a rate-limit as empty content (→ silent
 *  bail → phantom accuracy collapse). Retries empty/rate-limited responses
 *  with exponential backoff so the measured accuracy reflects the MODEL,
 *  not the key's TPM ceiling. Up to OC_BENCH_RETRIES (default 6) attempts. */
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
    // Empty = throttle/malformed. Back off: 250ms, 500ms, 1s, 2s, 4s…
    await sleep(250 * Math.pow(2, attempt));
  }
  return lastEmpty;
}

async function chatOnce(
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
