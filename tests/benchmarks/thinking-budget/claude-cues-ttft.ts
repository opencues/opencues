/**
 * Claude Haiku 4.5 — TTFT probe for the word-cue pipeline.
 *
 * Question this answers: "how fast does the first cue alternative
 * become available if we stream, vs the total wait we have today?"
 *
 * The word-cue pipeline (ConfigSource via `defaults/cues/spelling/CUE.md`
 * etc.) is the most latency-sensitive surface — typing a sentence
 * triggers a resolve on EVERY change, and the user perceives any
 * delay between typing and a tip showing. Today we buffer the whole
 * response before parsing. Streaming would let us emit cues per-word
 * as they arrive (the output format is one INDEX:alts line per
 * misspelling — line-delimited, perfect for incremental parse).
 *
 * Workload mirrors the production spelling cue: same system prompt,
 * same "0=word 1=word ..." indexed input format, same expected
 * `INDEX:correct1[,correct2[,correct3]]` output shape. Run streaming
 * vs non-streaming, capture TTFT-text + total, compare.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... \
 *     npx tsx tests/benchmarks/thinking-budget/claude-cues-ttft.ts
 *
 *   CASES=20 npx ...     # override case count
 *   MODEL=claude-haiku-4-5 npx ...
 */

import * as https from 'https';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Set ANTHROPIC_API_KEY');
  process.exit(1);
}

const MODEL = process.env.MODEL ?? 'claude-haiku-4-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

// The system prompt is identical to defaults/cues/spelling/CUE.md
// (the catch-all source that fires on every plain-text resolve).
// Re-running this bench after editing the prompt re-measures latency
// changes that come purely from prompt length.
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

// Inputs in the same indexed shape that ConfigSource.formatInput produces.
// Mix of single-typo, multi-typo, no-typo (which should return empty —
// still useful to measure since the model still has to read + decide).
const CASES: Array<{ id: string; input: string }> = [
  { id: 'single-typo',    input: '0=the 1=quick 2=brwon 3=fox 4=jumps' },
  { id: 'two-typos',      input: '0=she 1=recieved 2=an 3=acomodation 4=last 5=week' },
  { id: 'no-typo',        input: '0=the 1=team 2=is 3=ready 4=for 5=launch' },
  { id: 'three-typos',    input: '0=their 1=are 2=mispellings 3=throuout 4=this 5=sentance' },
  { id: 'long-no-typo',   input: '0=the 1=advisory 2=committee 3=concluded 4=their 5=quarterly 6=review 7=before 8=submitting 9=the 10=final 11=report' },
  { id: 'long-with-typo', input: '0=after 1=extensive 2=delibration 3=the 4=council 5=acheived 6=consensus 7=on 8=the 9=new 10=policy 11=framework' },
  { id: 'tech-words',     input: '0=the 1=kubrenetes 2=cluster 3=needs 4=auto 5=scaleing 6=enabled' },
  { id: 'medical',        input: '0=the 1=patient 2=presented 3=with 4=tachicardia 5=and 6=arythmia' },
];

interface Sample {
  caseId: string;
  mode: 'stream' | 'buffer';
  tFirstText: number | null; // streaming only
  tComplete: number;
  outputTokens: number;
  outputText: string;
  errored: boolean;
}

function streamOnce(input: string): Promise<Sample> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      temperature: 0.3,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input }],
    });
    const sample: Sample = {
      caseId: '',
      mode: 'stream',
      tFirstText: null,
      tComplete: 0,
      outputTokens: 0,
      outputText: '',
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
        'Content-Length': Buffer.byteLength(body),
      },
      agent,
    }, (res) => {
      const blockType = new Map<number, string>();
      let textBuf = '';
      let sseBuf = '';
      res.on('data', (chunk: Buffer) => {
        sseBuf += chunk.toString('utf8');
        let split: number;
        while ((split = sseBuf.indexOf('\n\n')) >= 0) {
          const raw = sseBuf.slice(0, split);
          sseBuf = sseBuf.slice(split + 2);
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
            if (t === 'text') {
              if (sample.tFirstText === null) sample.tFirstText = Date.now() - t0;
              const d = json.delta?.text as string | undefined;
              if (d) textBuf += d;
            }
          } else if (eventName === 'message_delta') {
            const u = json.usage as { output_tokens?: number } | undefined;
            if (u && typeof u.output_tokens === 'number') sample.outputTokens = u.output_tokens;
          } else if (eventName === 'message_stop') {
            sample.tComplete = Date.now() - t0;
          } else if (eventName === 'error') {
            sample.errored = true;
          }
        }
      });
      res.on('end', () => {
        if (sample.tComplete === 0) sample.tComplete = Date.now() - t0;
        sample.outputText = textBuf;
        if (!textBuf && !sample.errored) {
          // Empty output is valid (no-typo cases) — not an error.
        }
        resolve(sample);
      });
    });
    req.on('error', () => {
      sample.errored = true;
      sample.tComplete = Date.now() - t0;
      resolve(sample);
    });
    req.write(body);
    req.end();
  });
}

function bufferOnce(input: string): Promise<Sample> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input }],
    });
    const sample: Sample = {
      caseId: '',
      mode: 'buffer',
      tFirstText: null,
      tComplete: 0,
      outputTokens: 0,
      outputText: '',
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
        'Content-Length': Buffer.byteLength(body),
      },
      agent,
    }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c; });
      res.on('end', () => {
        sample.tComplete = Date.now() - t0;
        try {
          const j = JSON.parse(buf);
          if (j.type === 'error') {
            sample.errored = true;
          } else {
            const blocks = (j.content ?? []) as Array<{ type: string; text?: string }>;
            sample.outputText = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
            if (j.usage?.output_tokens) sample.outputTokens = j.usage.output_tokens;
          }
        } catch {
          sample.errored = true;
        }
        resolve(sample);
      });
    });
    req.on('error', () => {
      sample.errored = true;
      sample.tComplete = Date.now() - t0;
      resolve(sample);
    });
    req.write(body);
    req.end();
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
  const cases = caseCount <= CASES.length
    ? CASES.slice(0, caseCount)
    : Array.from({ length: caseCount }, (_, i) => CASES[i % CASES.length]);

  console.log(`\nClaude Haiku — word-cue TTFT (stream vs buffer)`);
  console.log(`Model:   ${MODEL}`);
  console.log(`Cases:   ${cases.length} per mode (sequential — no parallelism)\n`);

  const samples: Sample[] = [];

  // Buffered (production-equivalent) first, then streaming. We run
  // them interleaved per case so transient network conditions cancel
  // between modes for the same input.
  process.stdout.write(`  buffer  `);
  for (const c of cases) {
    const s = await bufferOnce(c.input);
    s.caseId = c.id;
    samples.push(s);
    process.stdout.write(s.errored ? '✗ ' : `${s.tComplete}ms  `);
  }
  process.stdout.write('\n');
  process.stdout.write(`  stream  `);
  for (const c of cases) {
    const s = await streamOnce(c.input);
    s.caseId = c.id;
    samples.push(s);
    process.stdout.write(s.errored ? '✗ ' : `${s.tFirstText ?? '?'}|${s.tComplete}ms  `);
  }
  process.stdout.write('\n');

  // ── Aggregates ────────────────────────────────────────────────────
  console.log(`\nAggregates (mean / p50 / p95) — excluding errors\n`);
  console.log(`mode      n    TTFT-text              total                  out_tok`);
  console.log(`               mean   p50    p95      mean   p50    p95`);
  console.log(`────────────────────────────────────────────────────────────────────`);
  for (const mode of ['buffer', 'stream'] as const) {
    const cell = samples.filter(s => s.mode === mode && !s.errored);
    const ttft = cell.map(s => s.tFirstText).filter((n): n is number => n !== null);
    const total = cell.map(s => s.tComplete);
    const out = cell.map(s => s.outputTokens);
    const fmt = (n: number) => `${n}ms`.padStart(7);
    console.log(
      `${mode.padEnd(8)} ${String(cell.length).padStart(2)}  ` +
      (ttft.length > 0
        ? `${fmt(mean(ttft))} ${fmt(pct(ttft, 0.5))} ${fmt(pct(ttft, 0.95))}    `
        : `   —       —       —      `) +
      `${fmt(mean(total))} ${fmt(pct(total, 0.5))} ${fmt(pct(total, 0.95))}    ` +
      `${String(mean(out)).padStart(4)}`,
    );
  }

  // ── Per-case TTFT savings (stream first-text vs buffer total) ──────
  console.log(`\nPer-case: how much earlier does streaming deliver the FIRST visible token?\n`);
  console.log(`case                  buffer-total   stream-TTFT   savings`);
  console.log(`──────────────────────────────────────────────────────────────`);
  for (const c of cases) {
    const buf = samples.find(s => s.caseId === c.id && s.mode === 'buffer' && !s.errored);
    const str = samples.find(s => s.caseId === c.id && s.mode === 'stream' && !s.errored);
    if (!buf || !str || str.tFirstText === null) continue;
    const savings = buf.tComplete - str.tFirstText;
    const pctSaved = Math.round((savings / buf.tComplete) * 100);
    console.log(
      `${c.id.padEnd(22)}${String(buf.tComplete).padStart(7)}ms  ${String(str.tFirstText).padStart(8)}ms  ${String(savings).padStart(6)}ms (${pctSaved}%)`,
    );
  }

  // ── Sample outputs (sanity check that streaming + buffer agree) ────
  console.log(`\nSample outputs (sanity — buffer vs stream should match)\n`);
  for (const c of cases.slice(0, 3)) {
    const buf = samples.find(s => s.caseId === c.id && s.mode === 'buffer');
    const str = samples.find(s => s.caseId === c.id && s.mode === 'stream');
    console.log(`  [${c.id}]`);
    console.log(`    buffer: ${JSON.stringify(buf?.outputText ?? '').slice(0, 100)}`);
    console.log(`    stream: ${JSON.stringify(str?.outputText ?? '').slice(0, 100)}`);
  }

  const errs = samples.filter(s => s.errored).length;
  if (errs) console.log(`\n${errs} errored call(s) excluded.`);
}

main().catch(err => { console.error(err); process.exit(1); });
