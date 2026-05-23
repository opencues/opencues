/**
 * Claude CLI provider bench — `claude -p` as a subscription-backed
 * Anthropic transport.
 *
 * Question this answers: "is `claude -p` fast enough to back our
 * latency-sensitive pipelines (cues, fluid-blank, transform-blank),
 * when the alternative is paying for an API key?"
 *
 * Spawns `claude --bare -p --model <m> --output-format stream-json
 * --include-partial-messages --no-session-persistence
 * --system-prompt <sys> --append-system-prompt "" "<user>"` and parses
 * the stream-json output to extract:
 *   - tSpawnToFirstByte: subprocess startup overhead (Node + CC init)
 *   - tFirstText:        ms from spawn to first text_delta
 *   - tComplete:         ms from spawn to process exit
 *   - ttftMsReported:    CC's own ttft_ms field from message_start
 *                        (their measure of API-side TTFT, not wall-clock)
 *
 * Modes (per case):
 *   - cold:  fresh spawn, first invocation of this system prompt
 *   - warm:  immediate re-run — Claude API prompt-cache should hit
 *            (cache TTL is 5min by default)
 *
 * Compare against the direct-API numbers from claude-cues-ttft.ts
 * (Haiku 4.5, buffered) — current production avg total ~807ms.
 *
 * Usage:
 *   npx tsx tests/benchmarks/thinking-budget/claude-cli-bench.ts
 *   MODEL=sonnet npx ...        # bigger model
 *   CASES=4 npx ...              # fewer cases (each runs 2× — cold + warm)
 */

import { spawn } from 'child_process';

const MODEL = process.env.MODEL ?? 'haiku';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

// Same spelling cue system prompt as claude-cues-ttft.ts — apples to
// apples comparison with the direct-API run.
const SYSTEM_PROMPT = `You are a spell-checker. Identify MISSPELLED words in the input and output their corrections.

Output format — one line per misspelling, nothing else:
INDEX:correct1[,correct2[,correct3]]

- INDEX is the 0-based word position from the input.
- Up to 3 corrections, most likely first. Single correction is fine.
- If NO misspellings, output nothing (empty response).

SKIP — do not flag:
- Correctly-spelled words.
- Proper nouns, place names, brand names, acronyms (assume intentional).
- Numbers, codes, hex, URLs, file paths.
- The literal underscore "_" (it's a placeholder, never a word).
- Single-letter words (a, I).

EXAMPLES:

INPUT: 0=the 1=boy 2=jumpved 3=over 4=the 5=dog
OUTPUT:
2:jumped

INPUT: 0=I 1=accomodate 2=many 3=guests
OUTPUT:
1:accommodate

INPUT: 0=this 1=is 2=spelt 3=correctly
OUTPUT:
2:spelled

Output ONLY index:alternatives format (e.g. 1:alt1,alt2,alt3). No prose, tables, or markdown.`;

const CASES: Array<{ id: string; input: string }> = [
  { id: 'single-typo',    input: '0=the 1=quick 2=brwon 3=fox 4=jumps' },
  { id: 'two-typos',      input: '0=she 1=recieved 2=an 3=acomodation 4=last 5=week' },
  { id: 'no-typo',        input: '0=the 1=team 2=is 3=ready 4=for 5=launch' },
  { id: 'three-typos',    input: '0=their 1=are 2=mispellings 3=throuout 4=this 5=sentance' },
  { id: 'tech-words',     input: '0=the 1=kubrenetes 2=cluster 3=needs 4=auto 5=scaleing 6=enabled' },
  { id: 'medical',        input: '0=the 1=patient 2=presented 3=with 4=tachicardia 5=and 6=arythmia' },
];

interface Sample {
  caseId: string;
  phase: 'cold' | 'warm';
  tSpawnToFirstByte: number | null;
  tFirstText: number | null;
  tComplete: number;
  ttftMsReported: number | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  outputText: string;
  errored: boolean;
}

function runClaude(input: string): Promise<Sample> {
  return new Promise((resolve) => {
    const args = [
      '--bare',
      '-p',
      '--model', MODEL,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--no-session-persistence',
      '--system-prompt', SYSTEM_PROMPT,
      input,
    ];
    const t0 = Date.now();
    const sample: Sample = {
      caseId: '',
      phase: 'cold',
      tSpawnToFirstByte: null,
      tFirstText: null,
      tComplete: 0,
      ttftMsReported: null,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      outputText: '',
      errored: false,
    };
    const child = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let textBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (sample.tSpawnToFirstByte === null) sample.tSpawnToFirstByte = Date.now() - t0;
      buf += chunk.toString('utf8');
      // stream-json is line-delimited (one JSON object per line)
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        // message_start carries ttft_ms + initial usage
        if (j.type === 'stream_event' && j.event?.type === 'message_start') {
          if (typeof j.ttft_ms === 'number') sample.ttftMsReported = j.ttft_ms;
          const u = j.event.message?.usage;
          if (u) {
            if (typeof u.cache_read_input_tokens === 'number') sample.cacheReadTokens = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number') sample.cacheCreationTokens = u.cache_creation_input_tokens;
          }
        } else if (j.type === 'stream_event' && j.event?.type === 'content_block_delta') {
          const d = j.event.delta;
          if (d?.type === 'text_delta') {
            if (sample.tFirstText === null) sample.tFirstText = Date.now() - t0;
            if (typeof d.text === 'string') textBuf += d.text;
          }
        } else if (j.type === 'stream_event' && j.event?.type === 'message_delta') {
          const u = j.event.message?.usage ?? j.event.usage;
          if (u && typeof u.output_tokens === 'number') sample.outputTokens = u.output_tokens;
        } else if (j.type === 'result') {
          // final summary; text also lives in `result`
          if (typeof j.result === 'string' && !textBuf) textBuf = j.result;
        }
      }
    });
    child.stderr.on('data', () => { /* swallow */ });
    child.on('error', () => { sample.errored = true; resolve({ ...sample, tComplete: Date.now() - t0 }); });
    child.on('close', () => {
      sample.tComplete = Date.now() - t0;
      sample.outputText = textBuf;
      if (!textBuf && sample.tFirstText === null) {
        // empty output is valid (no-typo case)
      }
      resolve(sample);
    });
  });
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

async function main() {
  const caseCount = parseInt(process.env.CASES ?? String(CASES.length), 10);
  const cases = CASES.slice(0, caseCount);

  console.log(`\nClaude CLI (\`claude -p\`) bench — word-cue spelling prompt`);
  console.log(`Model:  ${MODEL}`);
  console.log(`Cases:  ${cases.length} × {cold, warm}\n`);

  const samples: Sample[] = [];
  for (const c of cases) {
    // Cold: first invocation of this prompt (cache miss on the system prompt).
    process.stdout.write(`  [${c.id.padEnd(14)}] cold: `);
    const cold = await runClaude(c.input);
    cold.caseId = c.id;
    cold.phase = 'cold';
    samples.push(cold);
    process.stdout.write(
      cold.errored
        ? '✗ '
        : `spawn-fb=${String(cold.tSpawnToFirstByte).padStart(5)}ms  ttft-text=${String(cold.tFirstText ?? '?').padStart(5)}ms  total=${String(cold.tComplete).padStart(5)}ms  cache_read=${String(cold.cacheReadTokens).padStart(4)}`,
    );
    process.stdout.write('\n');

    // Warm: same prompt, immediate re-run — Anthropic 5-min cache should hit.
    process.stdout.write(`  [${c.id.padEnd(14)}] warm: `);
    const warm = await runClaude(c.input);
    warm.caseId = c.id;
    warm.phase = 'warm';
    samples.push(warm);
    process.stdout.write(
      warm.errored
        ? '✗ '
        : `spawn-fb=${String(warm.tSpawnToFirstByte).padStart(5)}ms  ttft-text=${String(warm.tFirstText ?? '?').padStart(5)}ms  total=${String(warm.tComplete).padStart(5)}ms  cache_read=${String(warm.cacheReadTokens).padStart(4)}`,
    );
    process.stdout.write('\n');
  }

  // ── Aggregates ────────────────────────────────────────────────────
  console.log(`\nAggregates (mean / p50 / p95) — excluding errors\n`);
  console.log(`phase   n   spawn→first-byte       TTFT-text              total                  cache_read`);
  console.log(`            mean   p50    p95      mean   p50    p95      mean   p50    p95      mean`);
  console.log(`─────────────────────────────────────────────────────────────────────────────────────────────`);
  for (const phase of ['cold', 'warm'] as const) {
    const cell = samples.filter(s => s.phase === phase && !s.errored);
    const fb = cell.map(s => s.tSpawnToFirstByte).filter((n): n is number => n !== null);
    const tt = cell.map(s => s.tFirstText).filter((n): n is number => n !== null);
    const total = cell.map(s => s.tComplete);
    const cr = cell.map(s => s.cacheReadTokens);
    const fmt = (n: number) => `${n}ms`.padStart(7);
    console.log(
      `${phase.padEnd(6)} ${String(cell.length).padStart(2)}   ` +
      `${fmt(mean(fb))} ${fmt(pct(fb, 0.5))} ${fmt(pct(fb, 0.95))}    ` +
      (tt.length > 0
        ? `${fmt(mean(tt))} ${fmt(pct(tt, 0.5))} ${fmt(pct(tt, 0.95))}    `
        : `   —       —       —      `) +
      `${fmt(mean(total))} ${fmt(pct(total, 0.5))} ${fmt(pct(total, 0.95))}    ` +
      `${String(mean(cr)).padStart(5)}`,
    );
  }

  console.log(`\nReference: direct Anthropic API (Haiku 4.5, buffered) — mean total ~807ms, p50 822ms.`);
  console.log(`           Direct API streaming TTFT-text: mean 1395ms, p50 701ms.\n`);

  const errs = samples.filter(s => s.errored).length;
  if (errs) console.log(`${errs} errored call(s) excluded.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
