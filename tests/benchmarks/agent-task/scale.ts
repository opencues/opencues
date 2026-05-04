/**
 * Scale benchmark — measures latency, output truncation, and accuracy
 * as document size grows.
 *
 * Each scale tier:
 *   - Generates a doc of N words with K seeded typos at known positions
 *   - Runs the agent ONCE with `correct spelling`
 *   - Reports: wall-clock latency, max_tokens used, # candidates, # edits
 *     applied, # seeded typos caught, # false-positive edits
 *
 * What we're watching for:
 *   - Latency growth (should be roughly linear w/ candidate count)
 *   - DECISIONS-format truncation (model drops trailing lines if max_tokens
 *     is exceeded — caught by counting how many DECISIONS lines came back
 *     vs candidates sent)
 *   - Recall on seeded typos at the END of the doc (the original
 *     "model misses last item" symptom)
 *
 * Usage:
 *   GROQ_API_KEY=… npx tsx tests/benchmarks/agent-task/scale.ts
 */

import { httpAdapter as realHttpAdapter, MODEL } from './groq';
import { AgentTaskState } from '../../../packages/opencues-runtime/src/state/agent-task';
import { DynDefs } from '../../../packages/opencues-runtime/src/state/dyn-defs';
import { AgentLoop } from '../../../packages/opencues-runtime/src/modules/agent-loop';
import { splitWords } from '../../../packages/opencues-runtime/src/modules/navigation';
import type { HostAdapter, RenderContext } from '../../../packages/opencues-runtime/src/adapter';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const FILLER_WORDS = [
  'the','quick','brown','fox','jumps','over','lazy','dog','and','runs','fast',
  'across','field','of','green','grass','while','sun','sets','behind','hills',
  'birds','sing','sweet','songs','in','trees','as','wind','blows','gently',
  'through','leaves','rustling','softly','clouds','drift','slowly','sky','above',
  'meadow','where','flowers','bloom','vibrant','colors','dance','butterflies',
  'flutter','past','golden','wheat','swaying','rhythm','peaceful','silence',
];

const TYPO_PAIRS: Array<[string, string]> = [
  ['recieved', 'received'],
  ['thier', 'their'],
  ['seperate', 'separate'],
  ['definately', 'definitely'],
  ['occured', 'occurred'],
  ['untill', 'until'],
  ['wierd', 'weird'],
  ['accomodate', 'accommodate'],
  ['begining', 'beginning'],
  ['concious', 'conscious'],
  ['existance', 'existence'],
  ['neccessary', 'necessary'],
  ['priviledge', 'privilege'],
  ['publically', 'publicly'],
  ['refered', 'referred'],
];

interface ScaleCase {
  totalWords: number;
  typoCount: number;
}

interface SeededDoc {
  text: string;
  typoIndices: number[];   // word indices where typos sit
  typoOriginals: string[]; // misspelled forms
  typoExpected: string[];  // correct forms
}

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function generateDoc(spec: ScaleCase, seed = 42): SeededDoc {
  const rand = seededRandom(seed);
  const words: string[] = [];
  for (let i = 0; i < spec.totalWords; i++) {
    words.push(FILLER_WORDS[Math.floor(rand() * FILLER_WORDS.length)]);
  }
  // Spread typos roughly evenly. Last typo intentionally near the end
  // so we can pin the "drops last item" behaviour.
  const typoIndices: number[] = [];
  const typoOriginals: string[] = [];
  const typoExpected: string[] = [];
  for (let k = 0; k < spec.typoCount; k++) {
    const pair = TYPO_PAIRS[k % TYPO_PAIRS.length];
    let idx: number;
    if (k === spec.typoCount - 1) {
      // Last typo placed in the final 10% of the doc — exercises the
      // "missing last item" failure mode.
      idx = spec.totalWords - Math.max(1, Math.floor(spec.totalWords * 0.05));
    } else {
      idx = Math.floor((k + 1) * (spec.totalWords / (spec.typoCount + 1)));
    }
    if (typoIndices.includes(idx)) idx = (idx + 1) % spec.totalWords;
    words[idx] = pair[0];
    typoIndices.push(idx);
    typoOriginals.push(pair[0]);
    typoExpected.push(pair[1]);
  }
  return { text: words.join(' '), typoIndices, typoOriginals, typoExpected };
}

interface CallRecord {
  candidateCount: number;
  responseLines: number;
  maxTokens: number;
  latencyMs: number;
}

function makeInstrumentedAdapter() {
  const calls: CallRecord[] = [];
  return {
    calls,
    adapter: {
      async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
        const parsed = JSON.parse(body);
        const userMsg: string = parsed.messages?.find((m: any) => m.role === 'user')?.content ?? '';
        const candMatch = userMsg.match(/Candidate word indices.*?\[([^\]]*)\]/);
        const candidateCount = candMatch
          ? candMatch[1].split(',').filter((s: string) => s.trim().length > 0).length
          : 0;
        const t0 = Date.now();
        const response = await realHttpAdapter.post(url, body, headers);
        const latencyMs = Date.now() - t0;
        let responseLines = 0;
        try {
          const out = JSON.parse(response).choices?.[0]?.message?.content ?? '';
          const block = out.match(/(?:DECISIONS|EDITS):\s*\n([\s\S]*?)(?:\n\s*END|$)/i);
          responseLines = block ? block[1].split('\n').filter((l: string) => l.trim().length > 0).length : 0;
        } catch { /* ignore */ }
        calls.push({
          candidateCount,
          responseLines,
          maxTokens: parsed.max_tokens ?? 0,
          latencyMs,
        });
        return response;
      },
    },
  };
}

function makeMockAdapter(initialText: string) {
  let text = initialText;
  let cursor = text.length + 1;
  const adapter = {
    capabilities: ['file-write', 'force-render'],
    cwd: '/tmp/agent-task-scale',
    getText: () => text,
    setText: (t: string) => { text = t; },
    pushText: (t: string, c: number) => { text = t; cursor = c; },
    getCursorOffset: () => cursor,
    setCursorOffset: (c: number) => { cursor = c; },
    forceRender: () => {},
    log: () => {},
    onTextChange: () => () => {},
    onRender: (_cb: (ctx: RenderContext) => unknown) => () => {},
  } as unknown as HostAdapter;
  return { adapter, getText: () => text };
}

const SPECS: ScaleCase[] = [
  { totalWords: 25,  typoCount: 3 },
  { totalWords: 50,  typoCount: 5 },
  { totalWords: 100, typoCount: 8 },
  { totalWords: 200, typoCount: 12 },
];

async function runOne(spec: ScaleCase) {
  const doc = generateDoc(spec);
  const state = new AgentTaskState(); state.arm('correct spelling');
  const dynDefs = new DynDefs();
  const { adapter, getText } = makeMockAdapter(doc.text);
  const http = makeInstrumentedAdapter();
  const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY!,
    defaultModel: MODEL,
    httpAdapter: http.adapter,
    log: () => {},
    promptFormat: (process.env.AGENT_FORMAT as 'DECISIONS' | 'EDITS' | undefined) ?? 'DECISIONS',
  });

  const t0 = Date.now();
  await loop.runOnce(doc.text);
  const wallMs = Date.now() - t0;

  // Inspect outcome via final text
  const finalText = getText();
  const finalWords = splitWords(finalText).map(w => w.word);

  // Score: how many seeded typos got corrected?
  let caught = 0;
  let missed: Array<{ idx: number; orig: string }> = [];
  for (let k = 0; k < doc.typoIndices.length; k++) {
    const idx = doc.typoIndices[k];
    const expected = doc.typoExpected[k];
    const actual = finalWords[idx] ?? '';
    if (actual.toLowerCase() === expected.toLowerCase()) caught++;
    else missed.push({ idx, orig: doc.typoOriginals[k] });
  }

  // False positives = words edited that were not in the seeded typo list
  const originalWords = splitWords(doc.text).map(w => w.word);
  let falsePositives = 0;
  for (let i = 0; i < originalWords.length; i++) {
    if (originalWords[i] !== finalWords[i] && !doc.typoIndices.includes(i)) {
      falsePositives++;
    }
  }

  const call = http.calls[0];
  const truncated = call ? call.responseLines < call.candidateCount : false;
  const recall = doc.typoIndices.length === 0 ? 1 : caught / doc.typoIndices.length;
  const lastTypoIdx = doc.typoIndices[doc.typoIndices.length - 1];
  const lastTypoCaught = !missed.find(m => m.idx === lastTypoIdx);

  return {
    spec, doc, wallMs, call, truncated, caught, missed, falsePositives, recall,
    lastTypoCaught,
  };
}

function fmtPct(n: number) { return `${(n * 100).toFixed(1)}%`; }

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error('Set GROQ_API_KEY');
    process.exit(1);
  }

  console.log(`${BOLD}agent-task scale benchmark${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log();

  const results: Awaited<ReturnType<typeof runOne>>[] = [];
  for (const spec of SPECS) {
    const r = await runOne(spec);
    results.push(r);
    const tag = r.recall === 1 ? `${GREEN}100%${RESET}` : r.recall > 0.7 ? `${YELLOW}${fmtPct(r.recall)}${RESET}` : `${RED}${fmtPct(r.recall)}${RESET}`;
    const truncTag = r.truncated ? `${RED}TRUNCATED${RESET}` : `${GREEN}complete${RESET}`;
    const lastTag = r.lastTypoCaught ? `${GREEN}YES${RESET}` : `${RED}NO${RESET}`;
    console.log('─'.repeat(78));
    console.log(`${BOLD}words=${spec.totalWords}  typos=${spec.typoCount}${RESET}`);
    console.log(`  ${DIM}wall:${RESET}      ${r.wallMs}ms`);
    console.log(`  ${DIM}max_tokens:${RESET} ${r.call?.maxTokens ?? '?'}  ${DIM}candidates:${RESET} ${r.call?.candidateCount ?? '?'}  ${DIM}response_lines:${RESET} ${r.call?.responseLines ?? '?'}  ${DIM}output:${RESET} ${truncTag}`);
    console.log(`  ${DIM}recall:${RESET}    ${tag}  (${r.caught}/${spec.typoCount} typos caught)`);
    console.log(`  ${DIM}last typo:${RESET} ${lastTag}  (idx ${r.doc.typoIndices.at(-1)} → "${r.doc.typoOriginals.at(-1)}")`);
    console.log(`  ${DIM}false-positives:${RESET} ${r.falsePositives}`);
    if (r.missed.length) {
      console.log(`  ${DIM}missed:${RESET}    ${r.missed.map(m => `${m.idx}:${m.orig}`).join(', ')}`);
    }
  }

  console.log('═'.repeat(78));
  console.log(`${BOLD}Summary table:${RESET}`);
  console.log('  words │ candidates │ wall(ms) │ ms/cand │ recall │ trunc │ last');
  console.log('  ──────┼────────────┼──────────┼─────────┼────────┼───────┼──────');
  for (const r of results) {
    const cand = r.call?.candidateCount ?? 0;
    const msPerCand = cand > 0 ? (r.wallMs / cand).toFixed(1) : 'n/a';
    const trunc = r.truncated ? 'YES' : 'no';
    const last = r.lastTypoCaught ? 'YES' : 'NO';
    console.log(`  ${String(r.spec.totalWords).padStart(5)} │ ${String(cand).padStart(10)} │ ${String(r.wallMs).padStart(8)} │ ${msPerCand.padStart(7)} │ ${fmtPct(r.recall).padStart(6)} │ ${trunc.padStart(5)} │ ${last.padStart(4)}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
