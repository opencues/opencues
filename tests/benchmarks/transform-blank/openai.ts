/**
 * Minimal OpenAI client — pinned to gpt-5.4-mini for the smallest/
 * fastest tier in the GPT-5.4 family. Same `chat()` signature as
 * groq-impl.ts.
 *
 * Set OPENCUES_BENCH_PROVIDER=openai-nano to route here.
 * Override the model via OPENCUES_OPENAI_MODEL.
 */

import * as https from 'https';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const MODEL = process.env.OPENCUES_OPENAI_MODEL ?? 'gpt-5.4-mini';

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('Set OPENAI_API_KEY');
  process.exit(1);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; latencyMs: number; }

export async function chat(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; seed?: number } = {},
): Promise<ChatResult> {
  // gpt-5.x reasoning models only accept temperature=1 and use
  // max_completion_tokens (not max_tokens). Branch on model name.
  // Detect reasoning models so we use max_completion_tokens (not max_tokens),
  // strip temperature (locked to 1), and forward reasoning_effort.
  // `chat-latest` is the OpenAI alias for the gpt-5.5 Instant model
  // (still a reasoning model under the hood) — explicit match.
  const isReasoning = /^gpt-5/i.test(MODEL) || /^o\d/i.test(MODEL) || MODEL === 'chat-latest';
  const payload: Record<string, unknown> = {
    model: MODEL,
    messages,
    seed: opts.seed ?? 42,
  };
  if (isReasoning) {
    // gpt-5 nano/mini: reasoning_effort='low' (NOT 'none') because the
    // reasoning tokens are doing real work — setting 'none' drops
    // transform-blank-fused 85% → 28% on mini. The 2048 floor below
    // gives the model room to fit reasoning + output even on multi-
    // pass pipelines where the caller passes a smaller budget.
    //
    // Override via OPENCUES_OPENAI_REASONING when exploring whether a
    // SMARTER model can win without reasoning (e.g. gpt-5.4 full +
    // reasoning=none might match nano/mini-with-reasoning at lower
    // latency). Accepts: 'none', 'low', 'medium', 'high', 'xhigh'.
    const isLowReasoningTier = /gpt-5(\.\d+)?-(nano|mini)\b/i.test(MODEL);
    payload.max_completion_tokens = Math.max(opts.maxTokens ?? 2048, isLowReasoningTier ? 2048 : 1024);
    payload.reasoning_effort = process.env.OPENCUES_OPENAI_REASONING ?? 'low';
    // Don't set temperature on reasoning models (only default=1 allowed).
  } else {
    payload.max_tokens = opts.maxTokens ?? 512;
    payload.temperature = opts.temperature ?? 0;
  }
  const body = JSON.stringify(payload);

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
  try { parsed = JSON.parse(data); } catch { throw new Error(`Bad OpenAI response: ${data.slice(0, 200)}`); }
  if (parsed.error) {
    const msg = parsed.error.message ?? JSON.stringify(parsed.error);
    // Soft-fail: rate-limit, parse failures, AND token-budget exhaustion
    // (reasoning model spent the whole budget thinking). Reasoning models
    // emit this as a structured error rather than finish_reason=length.
    if (/rate.?limit|parsing|max.?tokens|output limit/i.test(msg)) {
      return { text: '', latencyMs };
    }
    throw new Error(`OpenAI error: ${msg}`);
  }

  // Reasoning models can return finish_reason="length" with empty content
  // when they spend all max_completion_tokens on reasoning. Treat as soft
  // empty rather than throwing so one bad case doesn't kill the run.
  const finishReason = parsed.choices?.[0]?.finish_reason;
  if (finishReason === 'length' && !parsed.choices?.[0]?.message?.content) {
    return { text: '', latencyMs };
  }

  const text = parsed.choices?.[0]?.message?.content ?? '';
  return { text, latencyMs };
}

export const sysUser = (system: string, user: string): ChatMessage[] =>
  [{ role: 'system', content: system }, { role: 'user', content: user }];
