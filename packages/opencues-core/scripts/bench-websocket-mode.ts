/**
 * Cross-provider transport bench: WebSocket vs HTTP (Responses API)
 * vs HTTP (chat-completions) on OpenCues-shaped workloads.
 *
 * Workloads:
 *   1. SINGLE      — one P1-style call. Single round-trip.
 *   2. FLUID-CHAIN — SEGMENT → ANSWER (2 turns).
 *   3. XFORM-CHAIN — EXTRACT → APPLY → VERIFY (3 turns).
 *
 * Per-model transport map:
 *   - OpenAI models: HTTP-RESP (chained via previous_response_id, store:true)
 *                    + WS-RESP (chained via previous_response_id, store:false,
 *                    in-memory cache).
 *   - Groq / Cerebras: CHAT — chat-completions, independent calls per turn.
 *     They have no Responses API or chain mechanic, so each turn is a
 *     fresh request. This is also how OpenCues' production code uses them.
 *
 * Each (model, transport, workload) cell runs N=5 trials, median reported.
 *
 * Usage:
 *   OPENAI_API_KEY=… GROQ_API_KEY=… CEREBRAS_API_KEY=… \
 *     pnpm --filter @opencues/core bench:websocket
 *
 * Notes:
 * - Uses Node 22's global WebSocket (stable since 22.4). No extra dep.
 * - All HTTP calls share keep-alive Agents per host so the comparison
 *   is transport shape, not connection setup vs reuse.
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
} from '../src/llm-provider';

type Transport = 'HTTP-RESP' | 'WS-RESP' | 'CHAT';

interface ModelConfig {
  /** Model id sent on the wire. */
  id: string;
  /** Display label in the results table. */
  label: string;
  /** Provider — selects endpoint, auth, request shape. */
  provider: ProviderId;
  /** Transports to test for this model. */
  transports: Transport[];
  /** Reasoning config — shape varies by transport. For Responses API
   *  it's emitted as top-level `reasoning: { effort: ... }`; for
   *  chat-completions it's flattened to `reasoning_effort`. */
  reasoning?: { effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' };
}

const MODELS: ModelConfig[] = [
  // OpenAI — Responses API (HTTP + WS).
  // Note: gpt-5-nano accepts 'minimal' as its no-reasoning floor; the
  // .4 variants accept 'none'. Keeping each model at its supported floor.
  { id: 'gpt-5-nano',    label: 'openai/gpt-5-nano (minimal-reasoning)', provider: 'openai',   transports: ['HTTP-RESP', 'WS-RESP'], reasoning: { effort: 'minimal' } },
  { id: 'gpt-5.4-nano',  label: 'openai/gpt-5.4-nano (no-reasoning)',    provider: 'openai',   transports: ['HTTP-RESP', 'WS-RESP'], reasoning: { effort: 'none' } },
  { id: 'gpt-5.4-mini',  label: 'openai/gpt-5.4-mini (no-reasoning)',    provider: 'openai',   transports: ['HTTP-RESP', 'WS-RESP'], reasoning: { effort: 'none' } },
  { id: 'gpt-5.5',       label: 'openai/gpt-5.5 (no-reasoning)',         provider: 'openai',   transports: ['HTTP-RESP', 'WS-RESP'], reasoning: { effort: 'none' } },

  // Groq / Cerebras — chat-completions only. No WS, no Responses API.
  // gpt-oss models accept reasoning_effort 'low' as their floor.
  // Cerebras key here doesn't have gpt-oss-120b access (tier-gated);
  // qwen-3-235b is the big model the key can call.
  { id: 'openai/gpt-oss-120b', label: 'groq/gpt-oss-120b (low-reasoning)',     provider: 'groq',     transports: ['CHAT'], reasoning: { effort: 'low' } },
  { id: 'gpt-oss-120b',        label: 'cerebras/gpt-oss-120b (low-reasoning)', provider: 'cerebras', transports: ['CHAT'], reasoning: { effort: 'low' } },
];

const TRIALS = 5;
/** Print the wire-level request/response shape for the first trial of
 *  the first workload, so the reader can SEE what HTTP vs WS exchange
 *  for the same workload. Set false to suppress. */
const SHOW_WIRE_TRACE = true;

// ── Workload prompts ─────────────────────────────────────────────────

// Concise versions of the production prompts. Full text isn't needed —
// we're measuring transport overhead, not prompt accuracy.

const FLUID_P1_SYSTEM = `You are a SEGMENT extractor. Given INPUT, identify the lookup phrase ending at the _ marker. Output exactly:
SPAN: <substring including _>
CONTEXT: <surrounding text or "none">`;

const FLUID_P3_SYSTEM = `You are an ANSWER provider. Given a SPAN and CONTEXT, return a terse answer. Output exactly:
ANSWER: <terse answer>`;

const XFORM_EXTRACT_SYSTEM = `Classify the user's input. Output exactly:
VERDICT: TRANSFORM | NONE
INSTRUCTION: <verb phrase or empty>
TARGET: <target text or empty>`;

const XFORM_APPLY_SYSTEM = `Apply the INSTRUCTION to the TARGET. Output exactly:
REWRITE: <rewritten target>`;

const XFORM_VERIFY_SYSTEM = `Check the REWRITE against TARGET + INSTRUCTION. Output exactly:
VERDICT: OK | REPAIR
REWRITE: <corrected text or unchanged>`;

interface Turn { role: 'system' | 'user'; content: string }

interface Workload {
  id: string;
  /** Each entry is one model turn in the chain. system + user. */
  turns: { system: string; user: string; maxTokens: number }[];
}

const WORKLOADS: Workload[] = [
  {
    id: 'SINGLE',
    turns: [
      { system: FLUID_P1_SYSTEM, user: 'INPUT: capital of france _', maxTokens: 128 },
    ],
  },
  {
    id: 'FLUID-CHAIN',
    turns: [
      { system: FLUID_P1_SYSTEM, user: 'INPUT: trivia tonight capital of france _', maxTokens: 128 },
      // Second turn: in the chained variant, no system + only the new
      // user input is sent (state via previous_response_id). We still
      // record the system for the unchained baseline rebuild.
      { system: FLUID_P3_SYSTEM, user: 'Now produce ANSWER for the SPAN you extracted.', maxTokens: 64 },
    ],
  },
  {
    id: 'XFORM-CHAIN',
    turns: [
      { system: XFORM_EXTRACT_SYSTEM, user: 'INPUT: change "boy" to "girl" in: the boy ran fast', maxTokens: 128 },
      { system: XFORM_APPLY_SYSTEM, user: 'Now apply the INSTRUCTION you extracted to the TARGET.', maxTokens: 256 },
      { system: XFORM_VERIFY_SYSTEM, user: 'Now verify the REWRITE.', maxTokens: 128 },
    ],
  },
];

// ── Responses-API request shape ──────────────────────────────────────

interface RespCreate {
  type: 'response.create';
  model: string;
  store: boolean;
  previous_response_id?: string;
  instructions?: string;
  reasoning?: { effort: string };
  input: Array<{
    type: 'message';
    role: 'user';
    content: Array<{ type: 'input_text'; text: string }>;
  }>;
}

function buildCreate(turn: { system: string; user: string }, prevId: string | null, store: boolean, model: ModelConfig): RespCreate {
  const body: RespCreate = {
    type: 'response.create',
    model: model.id,
    store,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.user }] },
    ],
  };
  if (prevId) body.previous_response_id = prevId;
  // On the first turn we set instructions; on chained turns the prior
  // instructions are already part of the conversation state. (For the
  // unchained baseline below we always send instructions.)
  if (!prevId) body.instructions = turn.system;
  if (model.reasoning) body.reasoning = model.reasoning;
  return body;
}

// ── HTTP transport ───────────────────────────────────────────────────

const AGENT = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 60000 });

interface HttpResult { ok: boolean; ms: number; responseId: string | null; err?: string }

function postResponses(body: object, apiKey: string): Promise<HttpResult> {
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    const u = new URL('https://api.openai.com/v1/responses');
    const t0 = performance.now();
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      agent: AGENT,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data).toString(),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = performance.now() - t0;
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          resolve({ ok: false, ms, responseId: null, err: `HTTP ${res.statusCode}: ${text.slice(0, 160)}` });
          return;
        }
        try {
          const parsed = JSON.parse(text);
          resolve({ ok: true, ms, responseId: parsed.id ?? null });
        } catch (err) {
          resolve({ ok: false, ms, responseId: null, err: `parse: ${(err as Error).message}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, ms: performance.now() - t0, responseId: null, err: err.message }));
    req.setTimeout(60000, () => req.destroy(new Error('timeout 60s')));
    req.write(data);
    req.end();
  });
}

async function runHttp(workload: Workload, apiKey: string, model: ModelConfig, trace = false): Promise<{ totalMs: number; perTurnMs: number[]; ok: boolean; err?: string }> {
  // HTTP needs store:true to chain via previous_response_id (no
  // connection-local cache exists between two POSTs). This is the
  // natural HTTP-mode config; we're comparing best-HTTP vs best-WS.
  let prevId: string | null = null;
  const perTurnMs: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < workload.turns.length; i++) {
    const turn = workload.turns[i];
    const wsBody = buildCreate(turn, prevId, /* store */ true, model);
    // HTTP `POST /v1/responses` rejects the `type: 'response.create'`
    // envelope — that's a WebSocket-only field. Strip it.
    const { type: _t, ...httpBody } = wsBody;
    void _t;
    if (trace) {
      console.log(`\n      [HTTP turn ${i + 1}/${workload.turns.length}] POST /v1/responses`);
      console.log(`      ${JSON.stringify(httpBody)}`);
    }
    const r = await postResponses(httpBody, apiKey);
    perTurnMs.push(r.ms);
    if (trace) console.log(`      ← ${r.ok ? `200 in ${r.ms.toFixed(0)}ms (id=${r.responseId})` : `FAIL: ${r.err}`}`);
    if (!r.ok) return { totalMs: performance.now() - t0, perTurnMs, ok: false, err: r.err };
    prevId = r.responseId;
  }
  return { totalMs: performance.now() - t0, perTurnMs, ok: true };
}

// ── WebSocket transport ──────────────────────────────────────────────

interface WsResult { totalMs: number; perTurnMs: number[]; ok: boolean; err?: string }

async function runWs(workload: Workload, apiKey: string, model: ModelConfig, trace = false): Promise<WsResult> {
  const ws = new WebSocket('wss://api.openai.com/v1/responses', {
    // Node's global WebSocket accepts headers as second-arg options
    // since 22.4. The lib.dom typing doesn't expose this, so cast.
    headers: { Authorization: `Bearer ${apiKey}` },
  } as unknown as undefined);

  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (ev: Event) => reject(new Error(`ws error: ${(ev as ErrorEvent).message ?? 'unknown'}`)), { once: true });
  });

  try {
    await Promise.race([
      opened,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ws connect timeout')), 15000)),
    ]);
  } catch (err) {
    try { ws.close(); } catch { /* ignore */ }
    return { totalMs: 0, perTurnMs: [], ok: false, err: (err as Error).message };
  }

  let prevId: string | null = null;
  const perTurnMs: number[] = [];
  const t0 = performance.now();

  // Send each turn; await response.completed before the next turn.
  // WS uses store:false (the ZDR-compatible mode) — connection-local
  // cache holds the chain state.
  for (let i = 0; i < workload.turns.length; i++) {
    const turn = workload.turns[i];
    const body = buildCreate(turn, prevId, /* store */ false, model);
    if (trace) {
      console.log(`\n      [WS turn ${i + 1}/${workload.turns.length}] send response.create`);
      console.log(`      ${JSON.stringify(body)}`);
    }
    const tTurn = performance.now();
    const finished: Promise<{ ok: boolean; responseId: string | null; err?: string }> = new Promise((resolve) => {
      const onMsg = (ev: MessageEvent) => {
        let evt: { type?: string; response?: { id?: string }; error?: { message?: string }; status?: number };
        try { evt = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
        catch { return; }
        if (evt.type === 'response.completed') {
          ws.removeEventListener('message', onMsg);
          resolve({ ok: true, responseId: evt.response?.id ?? null });
        } else if (evt.type === 'error') {
          ws.removeEventListener('message', onMsg);
          resolve({ ok: false, responseId: null, err: `ws error: ${evt.error?.message ?? JSON.stringify(evt)}` });
        }
      };
      ws.addEventListener('message', onMsg);
    });
    ws.send(JSON.stringify(body));
    const r = await Promise.race([
      finished,
      new Promise<{ ok: false; responseId: null; err: string }>((_, rej) =>
        setTimeout(() => rej(new Error('ws turn timeout 60s')), 60000)),
    ]).catch((err: Error) => ({ ok: false as const, responseId: null, err: err.message }));
    const turnMs = performance.now() - tTurn;
    perTurnMs.push(turnMs);
    if (trace) console.log(`      ← ${r.ok ? `response.completed in ${turnMs.toFixed(0)}ms (id=${r.responseId})` : `FAIL: ${r.err}`}`);
    if (!r.ok) {
      try { ws.close(); } catch { /* ignore */ }
      return { totalMs: performance.now() - t0, perTurnMs, ok: false, err: r.err };
    }
    prevId = r.responseId;
  }

  const totalMs = performance.now() - t0;
  try { ws.close(); } catch { /* ignore */ }
  return { totalMs, perTurnMs, ok: true };
}

// ── Chat-completions transport (groq / cerebras / any OpenAI-compat) ─

interface ChatResult { totalMs: number; perTurnMs: number[]; ok: boolean; err?: string }

const HTTPS_AGENTS = new Map<string, https.Agent>();
function agentFor(host: string): https.Agent {
  let a = HTTPS_AGENTS.get(host);
  if (!a) { a = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 60000 }); HTTPS_AGENTS.set(host, a); }
  return a;
}

function postJson(url: string, body: string, headers: Record<string, string>, timeoutMs = 60000): Promise<{ status: number; text: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const t0 = performance.now();
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'POST', agent: agentFor(u.hostname),
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), ms: performance.now() - t0 }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
    req.write(body); req.end();
  });
}

/**
 * Chat-completions transport — independent call per turn (no chaining
 * mechanic exists on chat-completions). Mirrors how OpenCues' production
 * code uses Groq/Cerebras: each pipeline pass is a fresh request.
 */
async function runChat(workload: Workload, apiKey: string, model: ModelConfig, trace = false): Promise<ChatResult> {
  const provider = getProvider(model.provider);
  if (!provider) return { totalMs: 0, perTurnMs: [], ok: false, err: `unknown provider ${model.provider}` };

  const perTurnMs: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < workload.turns.length; i++) {
    const turn = workload.turns[i];
    const built = buildProviderRequest(model.provider, {
      model: model.id,
      messages: [
        { role: 'system', content: turn.system },
        { role: 'user', content: turn.user },
      ],
      maxTokens: turn.maxTokens,
      temperature: 0,
      // Chat-completions reasoning_effort only accepts 'low' | 'medium' |
      // 'high'. Map our broader vocabulary down: 'none'/'minimal' → 'low'.
      reasoningEffort:
        model.reasoning?.effort === 'low' || model.reasoning?.effort === 'medium' || model.reasoning?.effort === 'high'
          ? model.reasoning.effort
          : (model.reasoning ? 'low' : undefined),
    }, { apiKey });
    if (trace) {
      console.log(`\n      [CHAT turn ${i + 1}/${workload.turns.length}] POST ${built.url}`);
      console.log(`      ${built.body}`);
    }
    const r = await postJson(built.url, built.body, built.headers);
    perTurnMs.push(r.ms);
    if (trace) console.log(`      ← ${r.status === 200 ? `200 in ${r.ms.toFixed(0)}ms` : `${r.status}: ${r.text.slice(0, 120)}`}`);
    if (r.status !== 200) {
      return { totalMs: performance.now() - t0, perTurnMs, ok: false, err: `HTTP ${r.status}: ${r.text.slice(0, 160)}` };
    }
    // Parse so we error early on malformed responses; result text not used.
    try { parseProviderResponse(model.provider, r.text); }
    catch (err) { return { totalMs: performance.now() - t0, perTurnMs, ok: false, err: `parse: ${(err as Error).message}` }; }
  }
  return { totalMs: performance.now() - t0, perTurnMs, ok: true };
}

// ── Stats helpers ────────────────────────────────────────────────────

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function fmtMs(ms: number): string { return `${ms.toFixed(0)}ms`; }

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Resolve API keys per provider. Models for a provider whose key is
  // missing are silently skipped — print a heads-up but don't fail.
  const keys: Record<ProviderId, string | undefined> = {
    openai:    process.env.OPENAI_API_KEY,
    groq:      process.env.GROQ_API_KEY,
    cerebras:  process.env.CEREBRAS_API_KEY,
    openrouter: undefined,
    gemini:    undefined,
    anthropic: undefined,
  };
  for (const m of MODELS) {
    if (!keys[m.provider]) {
      console.log(`(skipping ${m.label} — no API key for provider ${m.provider})`);
    }
  }

  console.log(`Bench: WebSocket vs HTTP (Responses API) vs HTTP (chat-completions)`);
  console.log(`Trials per cell: ${TRIALS}`);
  console.log('');

  interface Row {
    model: string;
    workload: string;
    transport: Transport;
    medianTotal: number;
    medianPerTurn: number[];
    failures: number;
    sample?: string;
  }
  const rows: Row[] = [];

  // Wire trace — show the actual exchange once per transport for the
  // chained workload, using the first OpenAI model. Separate from
  // the timing rollup; just illustrates the wire-level differences.
  const traceModel = MODELS.find(m => m.provider === 'openai' && keys.openai);
  if (SHOW_WIRE_TRACE && traceModel) {
    console.log('━━━ WIRE TRACE ━━━');
    console.log(`Workload: ${WORKLOADS[2].id} (3-turn chain)  Model: ${traceModel.id}`);
    console.log('\n  --- HTTP (Responses) ---');
    await runHttp(WORKLOADS[2], keys.openai!, traceModel, /* trace */ true);
    console.log('\n  --- WebSocket (Responses) ---');
    await runWs(WORKLOADS[2], keys.openai!, traceModel, /* trace */ true);
    // Add a chat-completions trace using the first chat-only model so
    // the reader can compare.
    const chatModel = MODELS.find(m => m.transports.includes('CHAT') && keys[m.provider]);
    if (chatModel) {
      console.log(`\n  --- chat-completions (${chatModel.label}) ---`);
      await runChat(WORKLOADS[2], keys[chatModel.provider]!, chatModel, /* trace */ true);
    }
    console.log('\n━━━━━━━━━━━━━━━━\n');
  }

  for (const model of MODELS) {
    const apiKey = keys[model.provider];
    if (!apiKey) continue;
    console.log(`▶ ${model.label}`);
    for (const wl of WORKLOADS) {
      for (const transport of model.transports) {
        const totals: number[] = [];
        const perTurnByIdx: number[][] = wl.turns.map(() => []);
        let failures = 0;
        let sample: string | undefined;
        for (let i = 0; i < TRIALS; i++) {
          let r;
          switch (transport) {
            case 'HTTP-RESP': r = await runHttp(wl, apiKey, model); break;
            case 'WS-RESP':   r = await runWs(wl, apiKey, model); break;
            case 'CHAT':      r = await runChat(wl, apiKey, model); break;
          }
          if (!r.ok) {
            failures++;
            if (!sample) sample = r.err;
            continue;
          }
          totals.push(r.totalMs);
          r.perTurnMs.forEach((ms, idx) => perTurnByIdx[idx].push(ms));
        }
        rows.push({
          model: model.label,
          workload: wl.id,
          transport,
          medianTotal: median(totals),
          medianPerTurn: perTurnByIdx.map(median),
          failures,
          sample,
        });
        const status = failures === 0 ? 'OK' : `${failures}/${TRIALS} failed`;
        console.log(`  ${wl.id.padEnd(12)} ${transport.padEnd(10)} total=${fmtMs(median(totals)).padStart(7)}  per-turn=[${perTurnByIdx.map(t => fmtMs(median(t))).join(', ')}]  ${status}`);
        if (sample) console.log(`    sample err: ${sample.slice(0, 200)}`);
      }
    }
    console.log('');
  }

  // Final tables — Markdown for paste-into-doc.
  for (const model of MODELS) {
    console.log(`## Results — ${model.label}\n`);
    console.log('| Workload | Transport | Median total | Per-turn medians | Failures |');
    console.log('|---|---|---|---|---|');
    for (const r of rows.filter(r => r.model === model.label)) {
      const perTurn = r.medianPerTurn.map(fmtMs).join(', ');
      console.log(`| ${r.workload} | ${r.transport} | ${fmtMs(r.medianTotal)} | ${perTurn} | ${r.failures}/${TRIALS} |`);
    }

    // Per-model HTTP-RESP vs WS-RESP delta (only for models that support both).
    const supportsBoth = model.transports.includes('HTTP-RESP') && model.transports.includes('WS-RESP');
    if (supportsBoth) {
      console.log(`\n## ${model.label} — HTTP-RESP vs WS-RESP deltas (negative = WS faster)\n`);
      console.log('| Workload | HTTP-RESP | WS-RESP | Δ ms | Δ % |');
      console.log('|---|---|---|---|---|');
      for (const wl of WORKLOADS) {
        const http = rows.find(r => r.model === model.label && r.workload === wl.id && r.transport === 'HTTP-RESP')!;
        const ws = rows.find(r => r.model === model.label && r.workload === wl.id && r.transport === 'WS-RESP')!;
        if (http.failures === TRIALS || ws.failures === TRIALS) {
          console.log(`| ${wl.id} | ${http.failures === TRIALS ? 'FAIL' : fmtMs(http.medianTotal)} | ${ws.failures === TRIALS ? 'FAIL' : fmtMs(ws.medianTotal)} | — | — |`);
          continue;
        }
        const delta = ws.medianTotal - http.medianTotal;
        const deltaPct = (delta / http.medianTotal) * 100;
        console.log(`| ${wl.id} | ${fmtMs(http.medianTotal)} | ${fmtMs(ws.medianTotal)} | ${delta >= 0 ? '+' : ''}${fmtMs(delta)} | ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}% |`);
      }
    }
    console.log('');
  }

  // Cross-model summary — best per-workload across everything.
  console.log('\n## Cross-model summary (best transport per model)\n');
  for (const wl of WORKLOADS) {
    console.log(`### ${wl.id}\n`);
    console.log('| Model | Transport | Median total | Per-turn medians |');
    console.log('|---|---|---|---|');
    const wlRows = rows.filter(r => r.workload === wl.id && r.failures < TRIALS)
                       .sort((a, b) => a.medianTotal - b.medianTotal);
    for (const r of wlRows) {
      console.log(`| ${r.model} | ${r.transport} | ${fmtMs(r.medianTotal)} | ${r.medianPerTurn.map(fmtMs).join(', ')} |`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('bench failed:', err);
  process.exit(1);
});
