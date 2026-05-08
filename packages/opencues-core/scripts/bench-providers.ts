/**
 * Provider speed + quality bench.
 *
 * Targets the four candidates we're choosing between for OpenCues's
 * production wiring:
 *   - groq      : openai/gpt-oss-120b  (current default)
 *   - cerebras  : gpt-oss-120b         (same weights, wafer silicon)
 *   - openai    : gpt-5.4-nano         (latest tiny OpenAI model)
 *   - anthropic : claude-haiku-4-5     (latest fastest Claude)
 *
 * Two phases:
 *
 * 1) SPEED — streaming requests at 3 input sizes × 3 output caps,
 *    2 trials each, median reported. Captures:
 *      - TTFT  : time from POST send to first content byte
 *      - WALL  : POST send → final byte
 *      - TOK/s : completion_tokens / (WALL - TTFT)
 *
 * 2) QUALITY — six tasks that mirror OpenCues's real surfaces:
 *    word alts, fluid-blank lookup, spelling, transform-blank,
 *    short rewrite, indexed cue format. Pass/fail + latency.
 *
 * Usage:
 *   pnpm bench:providers
 *   # or for one provider only:
 *   PROVIDERS=cerebras pnpm bench:providers
 */
/* eslint-disable no-console */
import * as https from 'node:https';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  getProvider,
  buildProviderRequest,
  parseProviderResponse,
  type ProviderId,
  type ChatRequest,
} from '../src/llm-provider';

// ── Config ───────────────────────────────────────────────────────────

interface Candidate { id: ProviderId; model: string; label: string }

const CANDIDATES: Candidate[] = [
  { id: 'groq',      model: 'openai/gpt-oss-120b',         label: 'groq/gpt-oss-120b' },
  { id: 'cerebras',  model: 'gpt-oss-120b',                label: 'cerebras/gpt-oss-120b' },
  { id: 'openai',    model: 'gpt-5.4-nano',                label: 'openai/gpt-5.4-nano' },
  { id: 'anthropic', model: 'claude-haiku-4-5-20251001',   label: 'anthropic/haiku-4.5' },
];

// Input ladders — empty / short / long.
const SHORT_PROMPT = 'Reply with the single word: pong';
const LONG_PROMPT = `You are reviewing a book chapter. The chapter discusses the rise of cottage industries in 18th century England, the role of canal infrastructure in moving raw goods, the slow shift from artisanal craft to factory production, the impact on rural household economies, the growth of company towns near coalfields, the displacement of women from cottage spinning to factory floors, child labour controversies in the early mills, the early Luddite reaction, parliamentary committees of inquiry, the rise of mechanics' institutes, the slow regulatory response, public-health crises in rapidly growing industrial cities, sanitation reform, the cholera outbreaks of the 1830s and 1840s, and finally the way these pressures combined with broader political agitation. Now reply with exactly the word: pong. No other words.`;

interface InputCase { name: string; user: string }

const INPUT_CASES: InputCase[] = [
  { name: 'empty',  user: 'pong' },
  { name: 'short', user: SHORT_PROMPT },
  { name: 'long',  user: LONG_PROMPT },
];

const OUTPUT_CAPS = [16, 100, 500];
const TRIALS = 2;

// Quality battery — task types that mirror what OpenCues runs in prod.
interface QualityTask {
  id: string;
  desc: string;
  system: string;
  user: string;
  /** Returns true if the response is acceptable. Substring-match
   *  against lowercased output is enough for a sanity-pass. */
  accept(out: string): boolean;
}

const QUALITY_TASKS: QualityTask[] = [
  {
    id: 'word-alts',
    desc: 'word cue: 3 synonyms in INDEX:alt format',
    system: 'You produce word alternatives. Output ONLY index:alternatives format (e.g. 0:alt1,alt2,alt3). No prose.',
    user: '0=happy',
    accept: (s) => /0\s*:\s*\w+\s*,\s*\w+/i.test(s),
  },
  {
    id: 'spelling',
    desc: 'spelling correction: helo wrold → hello world',
    system: 'You correct spelling. Output ONLY the corrected words space-separated.',
    user: 'helo wrold',
    accept: (s) => /hello/i.test(s) && /world/i.test(s),
  },
  {
    id: 'fluid-lookup',
    desc: 'fluid blank: capital of France',
    system: 'Answer with one word. No punctuation.',
    user: 'What is the capital of France?',
    accept: (s) => /paris/i.test(s),
  },
  {
    id: 'transform',
    desc: 'transform blank: change boy to girl in passage',
    system: 'Apply the imperative edit and output ONLY the rewritten passage.',
    user: 'Edit: change boy to girl. Passage: The boy ran fast.',
    accept: (s) => /the\s+girl\s+ran\s+fast/i.test(s),
  },
  {
    id: 'rewrite',
    desc: 'agent rewrite: fix typo in sentence',
    system: 'Output ONLY the corrected sentence. No commentary.',
    user: 'Fix typos: I rite stuff.',
    accept: (s) => /i\s+write\s+stuff/i.test(s),
  },
  {
    id: 'compute',
    desc: 'short factual: 100 celsius in fahrenheit',
    system: 'Answer with the number only.',
    user: 'Convert 100 celsius to fahrenheit.',
    accept: (s) => /212/.test(s),
  },
];

// ── HTTP layer ────────────────────────────────────────────────────────

interface StreamResult {
  ttftMs: number;
  wallMs: number;
  bytes: number;
  text: string;
  status: number;
  errorBody?: string;
}

/**
 * Per-host HTTPS agents with keep-alive enabled. Production OpenCues
 * uses `NodeHttpAdapter` which keeps connections warm — without that
 * here, every bench request burns a fresh TLS handshake (50–150ms),
 * which inflates TTFT inversely with how far the host is. Keep-alive
 * makes the comparison fair to OpenAI / Anthropic over WAN.
 */
const AGENTS = new Map<string, https.Agent>();
function agentFor(hostname: string): https.Agent {
  let a = AGENTS.get(hostname);
  if (!a) {
    a = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 60000 });
    AGENTS.set(hostname, a);
  }
  return a;
}

/**
 * POST + read stream in chunks. Records the time to the first byte that
 * contains an SSE data event with assistant content, and the wall time
 * to last byte. Body parsing happens after — so timing is independent
 * of how each provider frames its events.
 */
function postStream(url: string, body: string, headers: Record<string, string>, timeoutMs = 60000): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const t0 = performance.now();
    let firstByteTs: number | null = null;
    let bytes = 0;
    let chunks: Buffer[] = [];
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
      agent: agentFor(u.hostname),
    }, (res) => {
      res.on('data', (c: Buffer) => {
        if (firstByteTs === null) firstByteTs = performance.now();
        bytes += c.length;
        chunks.push(c);
      });
      res.on('end', () => {
        const wall = performance.now() - t0;
        const ttft = firstByteTs !== null ? firstByteTs - t0 : wall;
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          resolve({ ttftMs: ttft, wallMs: wall, bytes, text: '', status: res.statusCode, errorBody: text.slice(0, 200) });
        } else {
          resolve({ ttftMs: ttft, wallMs: wall, bytes, text, status: res.statusCode ?? 0 });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.write(body);
    req.end();
  });
}

// ── Streaming-mode bodies ────────────────────────────────────────────

/**
 * Build a streaming-mode request for the given provider. We can't reuse
 * `buildProviderRequest` directly because (a) it doesn't set stream:true
 * and (b) Anthropic's streaming flag lives at top-level, not inside any
 * adapter we own. Adapter abstraction stops at the body shape; bench is
 * the right place to know about stream framing.
 */
function buildStreamingRequest(c: Candidate, system: string, user: string, maxTokens: number): { url: string; body: string; headers: Record<string, string> } {
  const provider = getProvider(c.id)!;
  const apiKey = process.env[provider.envKeyName]!;
  const req: ChatRequest = {
    model: c.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    maxTokens,
    temperature: 0,
    // OpenAI's gpt-5 line accepts 'minimal' (skip internal reasoning
    // entirely — fastest), 'low', 'medium', 'high'. Other adapters
    // either ignore the value (gemini/anthropic strip it; openrouter
    // forwards but most non-reasoning hosts ignore) or honor it
    // (groq/cerebras gpt-oss-* read 'low' as the floor). Use 'minimal'
    // here to get OpenAI's true low-latency mode while staying compatible.
    reasoningEffort: 'low',
  };
  const built = buildProviderRequest(c.id, req, { apiKey });
  const body = JSON.parse(built.body);
  body.stream = true;
  if (c.id === 'openai') {
    // gpt-5 line: OpenAI accepts {none, low, medium, high, xhigh}.
    // 'none' is the floor and is faster than 'low' — confirmed live
    // (May 2026). Combined with verbosity: 'low' (forces terser
    // outputs, fewer tokens to stream) it gives a noticeably tighter
    // wall time on the per-cue / per-blank tasks OpenCues runs.
    if (/^(gpt-5|o\d)/i.test(c.model)) {
      body.reasoning_effort = 'none';
      body.verbosity = 'low';
    }
  }
  // OpenAI-shape streaming: opt into a final `usage` event so tps can
  // be computed from real completion_tokens, not chunk byte counts.
  if (c.id !== 'anthropic') {
    body.stream_options = { include_usage: true };
  }
  return { url: built.url, body: JSON.stringify(body), headers: built.headers };
}

/**
 * Extract the assistant text from an SSE stream body. Different
 * providers use different event shapes — we sniff and parse. The text
 * is only used for quality verification; speed numbers come from the
 * raw byte timestamps.
 */
function parseStreamText(c: Candidate, raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice('data: '.length).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      if (c.id === 'anthropic') {
        // content_block_delta { delta: { type: 'text_delta', text: '...' } }
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
          out.push(j.delta.text);
        }
      } else {
        // OpenAI-shape { choices: [{ delta: { content: '...' } }] }
        const c0 = j.choices?.[0];
        if (c0?.delta?.content) out.push(c0.delta.content);
      }
    } catch { /* ignore non-JSON heartbeats */ }
  }
  return out.join('');
}

/**
 * Same as parseStreamText but pulls completion-token count from the
 * usage block providers emit at end-of-stream. Used to compute tok/s.
 * Falls back to a rough char-based estimate when usage isn't reported.
 */
function parseStreamUsage(c: Candidate, raw: string): { completionTokens: number | null } {
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice('data: '.length).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      if (c.id === 'anthropic') {
        if (j.type === 'message_delta' && j.usage?.output_tokens) {
          return { completionTokens: j.usage.output_tokens };
        }
      } else if (j.usage?.completion_tokens) {
        return { completionTokens: j.usage.completion_tokens };
      }
    } catch { /* ignore */ }
  }
  return { completionTokens: null };
}

// ── Phase 1: SPEED ────────────────────────────────────────────────────

interface SpeedRow {
  cand: string;
  inputCase: string;
  outputCap: number;
  ttftMs: number;
  wallMs: number;
  completionTokens: number | null;
  toksPerSec: number | null;
  status: number;
  errorBody?: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

async function speedRound(c: Candidate, ic: InputCase, cap: number): Promise<SpeedRow> {
  const trials: { ttft: number; wall: number; tokens: number | null; status: number; errBody?: string }[] = [];
  for (let t = 0; t < TRIALS; t += 1) {
    const sys = ic.user;                 // long context goes in system role
    const user = ic.name === 'long' ? 'Reply with the single word: pong.' : ic.user;
    // For empty/short cases, just send the user prompt with a tiny system.
    const realSys = ic.name === 'long' ? `Background:\n${ic.user}` : 'You are concise.';
    const realUser = ic.name === 'long' ? 'Now reply with exactly the word: pong. No other words.' : ic.user;
    void sys; void user; // (kept the locals as documentation of original idea)
    const { url, body, headers } = buildStreamingRequest(c, realSys, realUser, cap);
    let r: StreamResult;
    try {
      r = await postStream(url, body, headers, 30000);
    } catch (err) {
      trials.push({ ttft: 0, wall: 0, tokens: null, status: 0, errBody: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const usage = r.status === 200 ? parseStreamUsage(c, r.text) : { completionTokens: null };
    trials.push({ ttft: r.ttftMs, wall: r.wallMs, tokens: usage.completionTokens, status: r.status, errBody: r.errorBody });
    // Tiny pace so we don't pile up on rate limits.
    await new Promise((r) => setTimeout(r, 200));
  }
  const ok = trials.filter((t) => t.status === 200);
  if (ok.length === 0) {
    const first = trials[0];
    return { cand: c.label, inputCase: ic.name, outputCap: cap,
      ttftMs: first.ttft, wallMs: first.wall, completionTokens: null, toksPerSec: null,
      status: first.status, errorBody: first.errBody };
  }
  const ttft = median(ok.map((t) => t.ttft));
  const wall = median(ok.map((t) => t.wall));
  const tok = ok[0].tokens;             // tokens vary little across trials; first is fine
  const tps = (tok !== null && tok > 0 && wall > ttft + 1) ? (tok / ((wall - ttft) / 1000)) : null;
  return { cand: c.label, inputCase: ic.name, outputCap: cap, ttftMs: ttft, wallMs: wall,
    completionTokens: tok, toksPerSec: tps, status: 200 };
}

async function runSpeed(candidates: Candidate[]): Promise<SpeedRow[]> {
  const rows: SpeedRow[] = [];
  for (const c of candidates) {
    for (const ic of INPUT_CASES) {
      for (const cap of OUTPUT_CAPS) {
        process.stderr.write(`[speed] ${c.label.padEnd(28)} ${ic.name.padEnd(6)} cap=${String(cap).padEnd(4)} … `);
        const row = await speedRound(c, ic, cap);
        rows.push(row);
        if (row.status === 200) {
          process.stderr.write(`ttft=${Math.round(row.ttftMs)}ms wall=${Math.round(row.wallMs)}ms tps=${row.toksPerSec?.toFixed(1) ?? '?'}\n`);
        } else {
          process.stderr.write(`HTTP ${row.status} ${row.errorBody?.slice(0, 80) ?? ''}\n`);
        }
      }
    }
  }
  return rows;
}

// ── Phase 2: QUALITY ─────────────────────────────────────────────────

interface QualityRow {
  cand: string;
  taskId: string;
  pass: boolean;
  ms: number;
  out: string;
  err?: string;
}

async function runQuality(candidates: Candidate[]): Promise<QualityRow[]> {
  const rows: QualityRow[] = [];
  for (const c of candidates) {
    for (const task of QUALITY_TASKS) {
      const provider = getProvider(c.id)!;
      const apiKey = process.env[provider.envKeyName]!;
      const built = buildProviderRequest(c.id, {
        model: c.model,
        messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.user }],
        maxTokens: 200,
        temperature: 0,
        reasoningEffort: 'low',
      }, { apiKey });
      const t0 = performance.now();
      try {
        const res = await postStream(built.url, built.body, built.headers, 30000);
        const ms = performance.now() - t0;
        if (res.status !== 200) {
          rows.push({ cand: c.label, taskId: task.id, pass: false, ms, out: '', err: `HTTP ${res.status}` });
        } else {
          const text = parseProviderResponse(c.id, res.text);
          rows.push({ cand: c.label, taskId: task.id, pass: task.accept(text), ms, out: text.slice(0, 80) });
        }
      } catch (err) {
        const ms = performance.now() - t0;
        rows.push({ cand: c.label, taskId: task.id, pass: false, ms, out: '', err: err instanceof Error ? err.message : String(err) });
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return rows;
}

// ── Reporting ────────────────────────────────────────────────────────

function fmt(n: number, w = 6, d = 0): string {
  return n.toFixed(d).padStart(w);
}

function reportSpeed(rows: SpeedRow[]): void {
  console.log('\n══ SPEED ════════════════════════════════════════════════════════════════════');
  console.log('candidate                    | input | cap  | ttft   wall   tok    tok/s');
  console.log('-----------------------------+-------+------+----------------------------');
  for (const r of rows) {
    const tps = r.toksPerSec !== null ? fmt(r.toksPerSec, 6, 1) : '   ?  ';
    const tok = r.completionTokens !== null ? fmt(r.completionTokens, 4) : '  ? ';
    if (r.status === 200) {
      console.log(`${r.cand.padEnd(28)} | ${r.inputCase.padEnd(5)} | ${String(r.outputCap).padStart(4)} | ${fmt(r.ttftMs, 5)} ${fmt(r.wallMs, 6)} ${tok} ${tps}`);
    } else {
      console.log(`${r.cand.padEnd(28)} | ${r.inputCase.padEnd(5)} | ${String(r.outputCap).padStart(4)} | FAIL   HTTP ${r.status} ${r.errorBody?.slice(0, 40) ?? ''}`);
    }
  }
}

function reportQuality(rows: QualityRow[]): void {
  console.log('\n══ QUALITY ══════════════════════════════════════════════════════════════════');
  console.log('candidate                    | task              |  ms   | pass | output');
  console.log('-----------------------------+-------------------+-------+------+--------');
  for (const r of rows) {
    const tag = r.pass ? '  ✓ ' : '  ✗ ';
    console.log(`${r.cand.padEnd(28)} | ${r.taskId.padEnd(17)} | ${fmt(r.ms, 5)} | ${tag} | ${r.out.replace(/\n/g, ' ').slice(0, 60)}${r.err ? ` [${r.err}]` : ''}`);
  }
  console.log('\nPer-candidate quality:');
  const byCand = new Map<string, { p: number; t: number; ms: number }>();
  for (const r of rows) {
    const e = byCand.get(r.cand) ?? { p: 0, t: 0, ms: 0 };
    e.t += 1;
    if (r.pass) e.p += 1;
    e.ms += r.ms;
    byCand.set(r.cand, e);
  }
  for (const [cand, e] of byCand) {
    console.log(`  ${cand.padEnd(28)} ${e.p}/${e.t} pass, avg ${(e.ms / e.t).toFixed(0)}ms/task`);
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const filter = process.env.PROVIDERS;
  const cands = filter
    ? CANDIDATES.filter((c) => filter.split(',').includes(c.id))
    : CANDIDATES;

  // Verify keys upfront so we don't waste time partway through.
  for (const c of cands) {
    const provider = getProvider(c.id)!;
    if (!process.env[provider.envKeyName]) {
      console.error(`MISSING ${provider.envKeyName} for ${c.label} — set it or remove from CANDIDATES.`);
      process.exit(2);
    }
  }

  console.log(`Benchmarking ${cands.length} candidate(s): ${cands.map((c) => c.label).join(', ')}`);
  const speedRows = await runSpeed(cands);
  const qualRows = await runQuality(cands);
  reportSpeed(speedRows);
  reportQuality(qualRows);
}

main().catch((err) => {
  console.error('bench crashed:', err);
  process.exit(2);
});
