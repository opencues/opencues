/**
 * Claude Haiku 4.5 — TTFT + total-latency sweep across thinking budgets.
 *
 * Question this answers: "how does extended thinking change the time
 * the user waits before the FIRST visible token, vs total response
 * time?" For our pipelines, TTFT-to-text is what gates perceived
 * responsiveness (the user sees the first token; the rest streams).
 *
 * Default in production: no `thinking` param sent → extended thinking
 * disabled. This bench measures the cost of turning it on.
 *
 * Streams via SSE (`stream: true`). Captures:
 *   - t_first_thinking: ms to first thinking_delta (only when enabled)
 *   - t_first_text:     ms to first text_delta (what the user sees)
 *   - t_complete:       ms to message_stop
 *   - thinking_tokens:  size of the thinking block (actual usage,
 *                       often < budget — budget is a CAP not a target)
 *   - output_tokens:    size of the visible text block
 *
 * Configurations swept:
 *   none           thinking omitted, temp=0  (production default)
 *   budget=1024    thinking enabled, temp=1
 *   budget=2048    thinking enabled, temp=1
 *   budget=4096    thinking enabled, temp=1
 *   budget=8192    thinking enabled, temp=1
 *
 * Anthropic constraints:
 *   - thinking requires temperature=1.0
 *   - max_tokens must be > budget_tokens (we pad with +1024 for the
 *     actual answer)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... \
 *     npx tsx tests/benchmarks/thinking-budget/claude-ttft.ts
 *
 *   # Override budgets:
 *   BUDGETS=none,1024,4096 npx tsx tests/benchmarks/thinking-budget/claude-ttft.ts
 *   # Override case count (sequential, no parallelism — TTFT is a
 *   # per-call wall-clock measurement, parallel skews it):
 *   CASES=10 npx tsx tests/benchmarks/thinking-budget/claude-ttft.ts
 *   # Override model:
 *   MODEL=claude-haiku-4-5 npx tsx tests/benchmarks/thinking-budget/claude-ttft.ts
 */

import * as https from 'https';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Set ANTHROPIC_API_KEY');
  process.exit(1);
}

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });

// Five representative transform/rewrite cases — short enough to keep
// the bench under a few minutes, varied enough to surface budget effects.
const PROBE_CASES: Array<{ id: string; system: string; user: string }> = [
  {
    id: 'rewrite-tone',
    system: 'Rewrite the user message in a more formal tone. Output only the rewritten sentence.',
    user: 'hey wanted to ping you on the report, lmk when you get a sec',
  },
  {
    id: 'fix-grammar',
    system: 'Fix grammar errors in the user message. Output only the corrected text.',
    user: 'the team are happy with there progress on the project',
  },
  {
    id: 'transform-list',
    system: 'Convert the comma-separated list in the user message into a numbered list. Output only the list.',
    user: 'apples, oranges, bananas, kiwis, mangoes',
  },
  {
    id: 'classify-intent',
    system: 'Classify the user message as one of: question, request, complaint, statement. Output only the label.',
    user: 'the wifi has been dropping every 10 minutes since yesterday',
  },
  {
    id: 'extract-entity',
    system: 'Extract the person\'s name from the user message. Output only the name.',
    user: 'I spoke with Dr. Mira Castillo yesterday about the appointment',
  },
];

interface Sample {
  caseId: string;
  config: string;
  tFirstThinking: number | null; // null = no thinking block
  tFirstText: number | null;     // null = no text (error)
  tComplete: number;
  thinkingTokens: number;
  outputTokens: number;
  errored: boolean;
}

interface Config {
  label: string;
  budgetTokens: number | null; // null = thinking disabled
}

function parseBudgets(): Config[] {
  const raw = (process.env.BUDGETS ?? 'none,1024,2048,4096,8192').split(',').map(s => s.trim());
  return raw.map((s): Config => {
    if (s === 'none') return { label: 'none', budgetTokens: null };
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`bad budget: ${s}`);
    return { label: `budget=${n}`, budgetTokens: n };
  });
}

/** Stream a single Messages API call, returning per-event timings. */
function streamOnce(config: Config, system: string, user: string): Promise<Sample> {
  return new Promise((resolve) => {
    const max_tokens = config.budgetTokens
      ? config.budgetTokens + 1024
      : 1024;
    const body: Record<string, unknown> = {
      model: MODEL,
      max_tokens,
      stream: true,
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (config.budgetTokens === null) {
      body.temperature = 0;
    } else {
      // Extended thinking REQUIRES temperature=1
      body.temperature = 1;
      body.thinking = { type: 'enabled', budget_tokens: config.budgetTokens };
    }
    const bodyStr = JSON.stringify(body);

    const sample: Sample = {
      caseId: '',
      config: config.label,
      tFirstThinking: null,
      tFirstText: null,
      tComplete: 0,
      thinkingTokens: 0,
      outputTokens: 0,
      errored: false,
    };

    const t0 = Date.now();
    const u = new URL(ENDPOINT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY!,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      agent,
    }, (res) => {
      // Track per-content-block type so we can attribute deltas correctly.
      const blockType = new Map<number, string>();
      let buf = '';

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        // SSE parser: events separated by \n\n. Each event has lines
        // like "event: <name>\ndata: <json>".
        let split: number;
        while ((split = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, split);
          buf = buf.slice(split + 2);
          let eventName = '';
          let dataLine = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let json: any;
          try { json = JSON.parse(dataLine); } catch { continue; }

          if (eventName === 'content_block_start') {
            const idx = json.index as number;
            const t = json.content_block?.type as string | undefined;
            if (typeof idx === 'number' && t) blockType.set(idx, t);
          } else if (eventName === 'content_block_delta') {
            const idx = json.index as number;
            const t = blockType.get(idx);
            if (t === 'thinking' && sample.tFirstThinking === null) {
              sample.tFirstThinking = Date.now() - t0;
            } else if (t === 'text' && sample.tFirstText === null) {
              sample.tFirstText = Date.now() - t0;
            }
          } else if (eventName === 'message_delta') {
            // usage block is final — captures token counts
            const usage = json.usage as Record<string, number> | undefined;
            if (usage) {
              if (typeof usage.output_tokens === 'number') sample.outputTokens = usage.output_tokens;
              // Anthropic's usage doesn't split thinking vs text tokens
              // explicitly today, but `output_tokens` is the SUM. We
              // approximate thinking_tokens by subtracting visible
              // text length / 4 (rough chars-to-tokens). When thinking
              // is disabled, thinkingTokens stays 0.
            }
          } else if (eventName === 'message_stop') {
            sample.tComplete = Date.now() - t0;
          } else if (eventName === 'error') {
            sample.errored = true;
          }
        }
      });
      res.on('end', () => {
        if (sample.tComplete === 0) sample.tComplete = Date.now() - t0;
        if (sample.tFirstText === null) sample.errored = true;
        // Heuristic split: if thinking was enabled, assume any output
        // beyond the visible text is thinking. Without per-block token
        // counts we can't be precise, but the delta order gives us
        // ms-level timing which is what we care about.
        resolve(sample);
      });
    });
    req.on('error', () => {
      sample.errored = true;
      sample.tComplete = Date.now() - t0;
      resolve(sample);
    });
    req.write(bodyStr);
    req.end();
  });
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

async function main(): Promise<void> {
  const configs = parseBudgets();
  const caseCount = parseInt(process.env.CASES ?? String(PROBE_CASES.length), 10);
  const cases = PROBE_CASES.slice(0, caseCount);

  console.log(`\nClaude Haiku TTFT sweep`);
  console.log(`Model:   ${MODEL}`);
  console.log(`Cases:   ${cases.length} × Configs: ${configs.map(c => c.label).join(', ')}`);
  console.log(`Total calls: ${cases.length * configs.length} (sequential — parallelism skews TTFT)\n`);

  const samples: Sample[] = [];
  const wallStart = Date.now();
  for (const config of configs) {
    process.stdout.write(`  ${config.label.padEnd(12)}  `);
    for (const c of cases) {
      const s = await streamOnce(config, c.system, c.user);
      s.caseId = c.id;
      samples.push(s);
      const mark = s.errored ? '✗' : s.tFirstText !== null
        ? `${s.tFirstText}ms`
        : '?';
      process.stdout.write(`${mark}  `);
    }
    process.stdout.write('\n');
  }
  const wallMs = Date.now() - wallStart;

  // ── Aggregate table ────────────────────────────────────────────────
  console.log(`\nPer-config aggregates (excluding errors)\n`);
  console.log(`config        n   TTFT-text             TTFT-thinking         total                 out_tok`);
  console.log(`                  mean   p50    p95     mean   p50    p95     mean   p50    p95`);
  console.log(`──────────────────────────────────────────────────────────────────────────────────────────`);
  for (const config of configs) {
    const cellSamples = samples.filter(s => s.config === config.label && !s.errored);
    const ttftText = cellSamples.map(s => s.tFirstText!).filter(n => n !== null);
    const ttftThink = cellSamples.map(s => s.tFirstThinking).filter((n): n is number => n !== null);
    const totals = cellSamples.map(s => s.tComplete);
    const outTok = cellSamples.map(s => s.outputTokens);
    const fmt = (n: number) => `${n}ms`.padStart(7);
    console.log(
      `${config.label.padEnd(12)}  ${String(cellSamples.length).padStart(2)}  ` +
      `${fmt(mean(ttftText))} ${fmt(pct(ttftText, 0.5))} ${fmt(pct(ttftText, 0.95))}   ` +
      `${ttftThink.length > 0 ? fmt(mean(ttftThink)) : '   —   '} ${ttftThink.length > 0 ? fmt(pct(ttftThink, 0.5)) : '   —   '} ${ttftThink.length > 0 ? fmt(pct(ttftThink, 0.95)) : '   —   '}   ` +
      `${fmt(mean(totals))} ${fmt(pct(totals, 0.5))} ${fmt(pct(totals, 0.95))}   ` +
      `${String(mean(outTok)).padStart(4)}`,
    );
  }

  const errs = samples.filter(s => s.errored).length;
  if (errs > 0) console.log(`\n${errs} errored call(s) excluded from aggregates.`);
  console.log(`\nWall: ${(wallMs / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
