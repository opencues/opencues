/**
 * Probe: does a persistent `claude -p --input-format stream-json` process
 * sustain low per-call latency across N sequential prompts?
 *
 * Send-one-then-wait protocol: write prompt #i to stdin, wait for
 * `result` event, then write #i+1. Matches how a real daemon would
 * serialise interactive calls (CLI doesn't pipeline turns).
 *
 * Usage:
 *   npx tsx tests/benchmarks/thinking-budget/claude-cli-daemon-probe.ts
 *   N=10 MODEL=haiku npx ...
 */

import { spawn } from 'child_process';

const MODEL = process.env.MODEL ?? 'haiku';
const N = parseInt(process.env.N ?? '6', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

const SYSTEM_PROMPT = 'You are a spell-checker. Output ONE line with the single corrected misspelled word, or nothing if no misspellings. No explanation.';

const PROMPTS = [
  'the brwon fox',
  'she recieved a letter',
  'good spelling here',
  'patient with tachicardia',
  'acomodation needed',
  'their are mispellings',
  'kubrenetes cluster',
  'auto scaleing enabled',
  'no errors in this one',
  'arythmia detected',
];

interface PerCall {
  promptIdx: number;
  tSentMs: number;
  tResultMs: number;
  elapsedMs: number;
  apiMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputText: string;
}

async function probe(): Promise<void> {
  const args = [
    '--bare', '-p',
    '--model', MODEL,
    '--no-session-persistence',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt', SYSTEM_PROMPT,
  ];
  const t0 = Date.now();
  const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let firstByteAt: number | null = null;
  const perCall: PerCall[] = [];
  let buf = '';

  // Per-prompt promise: resolves with the result event for that turn.
  let pendingResolve: ((r: any) => void) | null = null;

  child.stdout.on('data', (chunk: Buffer) => {
    if (firstByteAt === null) firstByteAt = Date.now() - t0;
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'result' && j.subtype === 'success' && pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r(j);
      }
    }
  });
  child.stderr.on('data', () => { /* swallow */ });
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
  child.on('error', (e) => { console.error('spawn error', e); process.exit(2); });

  for (let i = 0; i < N; i++) {
    const prompt = PROMPTS[i % PROMPTS.length];
    const sentAt = Date.now() - t0;
    const waitForResult = new Promise<any>((res) => { pendingResolve = res; });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    const j = await waitForResult;
    const tResult = Date.now() - t0;
    perCall.push({
      promptIdx: i,
      tSentMs: sentAt,
      tResultMs: tResult,
      elapsedMs: tResult - sentAt,
      apiMs: typeof j.duration_api_ms === 'number' ? j.duration_api_ms : 0,
      cacheReadTokens: j.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: j.usage?.cache_creation_input_tokens ?? 0,
      outputText: typeof j.result === 'string' ? j.result : '',
    });
  }
  child.stdin.end();
  await closed;

  const totalMs = Date.now() - t0;
  console.log(`\nDaemon probe — model=${MODEL}, N=${N}`);
  console.log(`Startup (spawn → first byte): ${firstByteAt}ms`);
  console.log(`Total wall time:              ${totalMs}ms`);
  console.log(`Per-call avg (excl startup):  ${Math.round((totalMs - (firstByteAt ?? 0)) / N)}ms\n`);
  console.log(`#  sent(ms) result(ms)  elapsed  api_ms  cache_read  cache_create  output`);
  console.log(`────────────────────────────────────────────────────────────────────────────`);
  for (const pc of perCall) {
    console.log(
      `${String(pc.promptIdx).padStart(2)}  ${String(pc.tSentMs).padStart(7)}  ${String(pc.tResultMs).padStart(8)}  ${String(pc.elapsedMs).padStart(6)}ms  ${String(pc.apiMs).padStart(6)}  ${String(pc.cacheReadTokens).padStart(10)}  ${String(pc.cacheCreationTokens).padStart(12)}  ${JSON.stringify(pc.outputText).slice(0, 30)}`,
    );
  }

  const elapsedMs = perCall.map(p => p.elapsedMs);
  const sorted = [...elapsedMs].sort((a, b) => a - b);
  const mean = Math.round(elapsedMs.reduce((a, b) => a + b, 0) / elapsedMs.length);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  console.log(`\nelapsed per call: mean=${mean}ms  p50=${p50}ms  p95=${p95}ms`);
  console.log(`(elapsed = ms from sending the prompt to receiving the result event)`);
}

probe().catch(e => { console.error(e); process.exit(1); });
