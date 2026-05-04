/**
 * Convergence benchmark — verifies the agent doesn't redundantly
 * re-evaluate words it already looked at.
 *
 * The cache contract (see state/agent-task.ts):
 *   - Per (taskId, textHash) — same task on unchanged word ⇒ skip.
 *   - taskId regenerates on arm() and appendToPrompt() ⇒ full re-eval.
 *   - DynDef ownership ⇒ skip (whether agent's own edit or another source).
 *
 * Scenarios pinned here:
 *   1. idempotent-noop      Clean doc + spelling task → 1st: 1 call, 2nd: 0 calls
 *   2. idempotent-fixed     Doc with typos → 1st: 1 call (fixes), 2nd: 0 calls
 *   3. incremental-append   Run, append new word, run → 2nd: 1 call but only new word in candidates
 *   4. task-switch          Run, appendToPrompt → 2nd: cache invalidated, full re-eval
 *   5. dyn-def-owns         Pre-claim a typo via DynDef → agent never asks about it
 *   6. cursor-rotation      Same text, cursor moves between runs → no re-asking already-cached words
 *
 * Each scenario asserts (a) LLM call count, (b) that the candidate set
 * sent to the LLM is what we expect.
 *
 * Usage:
 *   GROQ_API_KEY=… npx tsx tests/benchmarks/agent-task/convergence.ts
 */

import { httpAdapter as realHttpAdapter, MODEL } from './groq';
import { AgentTaskState } from '../../../packages/opencues-runtime/src/state/agent-task';
import { DynDefs, WordDef } from '../../../packages/opencues-runtime/src/state/dyn-defs';
import { AgentLoop } from '../../../packages/opencues-runtime/src/modules/agent-loop';
import { splitWords } from '../../../packages/opencues-runtime/src/modules/navigation';
import type { HostAdapter, RenderContext } from '../../../packages/opencues-runtime/src/adapter';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface CallRecord {
  candidateIndices: number[];
  candidateWords: string[];
  responseLen: number;
}

function makeCountingAdapter() {
  const calls: CallRecord[] = [];
  return {
    calls,
    adapter: {
      async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
        const parsed = JSON.parse(body);
        const userMsg: string = parsed.messages?.find((m: any) => m.role === 'user')?.content ?? '';
        const candMatch = userMsg.match(/Candidate word indices.*?\[([^\]]*)\]/);
        const candidateIndices = candMatch
          ? candMatch[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n))
          : [];
        const docMatch = userMsg.match(/DOC: (.+?)\n/);
        const docLine = docMatch?.[1] ?? '';
        const candidateWords: string[] = candidateIndices.map(i => {
          const m = docLine.match(new RegExp(`\\[${i}\\](\\S+)`));
          return m?.[1] ?? '?';
        });
        const response = await realHttpAdapter.post(url, body, headers);
        const out = (() => {
          try { return JSON.parse(response).choices?.[0]?.message?.content ?? ''; }
          catch { return ''; }
        })();
        calls.push({ candidateIndices, candidateWords, responseLen: out.length });
        return response;
      },
    },
  };
}

function makeMockAdapter(initialText: string, cursorPos: number) {
  let text = initialText;
  let cursor = cursorPos === -1 ? text.length + 1 : cursorPos;
  const adapter = {
    capabilities: ['file-write', 'force-render'],
    cwd: '/tmp/agent-task-convergence',
    getText: () => text,
    setText: (t: string) => { text = t; },
    pushText: (t: string, c: number) => { text = t; cursor = c; },
    getCursorOffset: () => cursor,
    setCursorOffset: (c: number) => { cursor = c; },
    forceRender: () => {},
    log: () => {},
    onTextChange: (_cb: (e: { text: string; source: string }) => void) => () => {},
    onRender: (_cb: (ctx: RenderContext) => unknown) => () => {},
  } as unknown as HostAdapter;
  return {
    adapter,
    setText: (t: string) => { text = t; },
    setCursor: (c: number) => { cursor = c; },
    getText: () => text,
  };
}

interface Scenario {
  id: string;
  description: string;
  run: () => Promise<{ pass: boolean; rationale: string; calls: CallRecord[] }>;
}

function buildLoop(adapter: HostAdapter, state: AgentTaskState, dynDefs: DynDefs, http: ReturnType<typeof makeCountingAdapter>['adapter']) {
  return new AgentLoop(adapter, state, dynDefs, undefined, {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY!,
    defaultModel: MODEL,
    httpAdapter: http,
    log: () => {},
  });
}

const SCENARIOS: Scenario[] = [
  {
    id: 'idempotent-noop',
    description: 'Clean doc + spelling task → 1st: 1 call, 2nd: 0 calls',
    async run() {
      const text = 'the quick brown fox jumps over the lazy dog';
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter(text, -1);
      const http = makeCountingAdapter();
      const loop = buildLoop(adapter, state, dynDefs, http.adapter);

      await loop.runOnce(text);
      const c1 = http.calls.length;
      await loop.runOnce(text);
      const c2 = http.calls.length;

      const pass = c1 === 1 && c2 === 1; // total stays at 1 → no redundant call on 2nd run
      return {
        pass,
        rationale: pass
          ? `1st run: 1 LLM call as expected; 2nd run: 0 additional calls (cached)`
          : `Expected 1 then 0 (cumulative 1→1). Got cumulative ${c1} → ${c2}`,
        calls: http.calls,
      };
    },
  },
  {
    id: 'idempotent-fixed',
    description: 'Doc with typos → 1st: 1 call (fixes), 2nd: 0 calls',
    async run() {
      const text = 'i recieved thier letter yesteday';
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter, getText } = makeMockAdapter(text, -1);
      const http = makeCountingAdapter();
      const loop = buildLoop(adapter, state, dynDefs, http.adapter);

      await loop.runOnce(text);
      const c1 = http.calls.length;
      const liveText = getText();
      await loop.runOnce(liveText);
      const c2 = http.calls.length;

      const pass = c1 === 1 && c2 === 1;
      return {
        pass,
        rationale: pass
          ? `1st run: 1 call; 2nd run on edited text: 0 additional. Final text: ${JSON.stringify(liveText)}`
          : `Expected 1 then 1 (cumulative). Got ${c1} → ${c2}. Final text: ${JSON.stringify(liveText)}`,
        calls: http.calls,
      };
    },
  },
  {
    id: 'incremental-append',
    description: 'Run, append a new word, run → 2nd run candidates contains only new word',
    async run() {
      const text = 'the quick brown fox';
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter, setText, setCursor } = makeMockAdapter(text, -1);
      const http = makeCountingAdapter();
      const loop = buildLoop(adapter, state, dynDefs, http.adapter);

      await loop.runOnce(text);
      const c1 = http.calls.length;

      // User appends a typo. Re-park cursor past new end (mirrors the
      // benchmark default — user is reading, not typing in the new word).
      const text2 = 'the quick brown fox jumpd';
      setText(text2);
      setCursor(text2.length + 1);
      await loop.runOnce(text2);
      const c2 = http.calls.length;

      // 2nd LLM call (if any) should ONLY contain the new word ("jumpd" at index 4)
      const secondCall = http.calls[1];
      const onlyNewWord = secondCall?.candidateIndices.length === 1 && secondCall.candidateIndices[0] === 4;

      const pass = c1 === 1 && c2 === 2 && onlyNewWord;
      return {
        pass,
        rationale: pass
          ? `1st run candidates: ${http.calls[0].candidateIndices.length}; 2nd run candidates: only [4] (new word)`
          : `Expected 1→2 calls with 2nd containing only new word. Got ${c1}→${c2}. 2nd cand: ${secondCall ? `[${secondCall.candidateIndices.join(',')}]` : 'no 2nd call'}`,
        calls: http.calls,
      };
    },
  },
  {
    id: 'task-switch',
    description: 'Run, then appendToPrompt (new taskId) → 2nd run re-evaluates everything',
    async run() {
      const text = 'i work on monday and friday';
      const state = new AgentTaskState(); state.arm('capitalize the days');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter(text, -1);
      const http = makeCountingAdapter();
      const loop = buildLoop(adapter, state, dynDefs, http.adapter);

      await loop.runOnce(text);
      const c1 = http.calls.length;
      const cand1 = http.calls[0]?.candidateIndices.length ?? 0;

      // Append a new sub-task → new taskId, cache cleared
      state.appendToPrompt('correct spelling');
      await loop.runOnce(text);
      const c2 = http.calls.length;
      const cand2 = http.calls[1]?.candidateIndices.length ?? 0;

      // Cache cleared → 2nd run should re-ask. But agent-edited words from
      // run 1 are now owned by DynDefs and excluded. So cand2 should be
      // (cand1 - number of edits applied in run 1).
      const fired2 = c2 === 2;
      const cand2NonZero = cand2 > 0; // at least some words re-evaluated

      const pass = c1 === 1 && fired2 && cand2NonZero;
      return {
        pass,
        rationale: pass
          ? `1st run cand=${cand1}; appendToPrompt → cache cleared; 2nd run cand=${cand2} (re-evaluated)`
          : `Expected cache invalidation to fire 2nd LLM call. Got cumulative ${c1}→${c2}, cand1=${cand1} cand2=${cand2}`,
        calls: http.calls,
      };
    },
  },
  {
    id: 'dyn-def-owns',
    description: 'Pre-claim a typo via DynDef → agent skips it (no edit, no eval)',
    async run() {
      const text = 'i recieved thier letter';
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();

      // Pre-claim index 1 ("recieved") for another source
      const wordSpans = splitWords(text);
      const w = wordSpans[1];
      const def: WordDef = {
        originalWord: w.word,
        alternatives: [w.word, 'received-by-other'],
        currentIndex: 0,
        spanStart: w.start,
        spanEnd: w.end,
        blankName: 'mock-other-source',
      };
      dynDefs.set(1, def);

      const { adapter } = makeMockAdapter(text, -1);
      const http = makeCountingAdapter();
      const loop = buildLoop(adapter, state, dynDefs, http.adapter);

      await loop.runOnce(text);
      const c1 = http.calls.length;
      const cand1 = http.calls[0]?.candidateIndices ?? [];
      const includesOwned = cand1.includes(1);

      const pass = c1 === 1 && !includesOwned;
      return {
        pass,
        rationale: pass
          ? `Owned index 1 correctly excluded from candidates [${cand1.join(',')}]`
          : `Expected owned index 1 to be excluded. Got candidates [${cand1.join(',')}], calls=${c1}`,
        calls: http.calls,
      };
    },
  },
  {
    id: 'cursor-rotation',
    description: 'Cursor moves between runs → cached words still skip',
    async run() {
      const text = 'i recieved thier letter yesteday today';
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter, setCursor } = makeMockAdapter(text, -1);
      const http = makeCountingAdapter();
      const loop = buildLoop(adapter, state, dynDefs, http.adapter);

      // Run 1 with cursor parked outside
      await loop.runOnce(text);
      const c1 = http.calls.length;
      const cand1Count = http.calls[0]?.candidateIndices.length ?? 0;

      // Move cursor onto word 0 ("i") and re-run with same text
      setCursor(0);
      await loop.runOnce(text);
      const c2 = http.calls.length;

      // 2nd run: cursor word excluded but everything else cached → 0 candidates
      // → no LLM call should fire.
      const pass = c1 === 1 && c2 === 1 && cand1Count > 0;
      return {
        pass,
        rationale: pass
          ? `1st run cand=${cand1Count}; cursor moved + re-run: 0 new calls (all cached)`
          : `Expected cumulative 1→1. Got ${c1}→${c2}, cand1=${cand1Count}`,
        calls: http.calls,
      };
    },
  },
];

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.error('Set GROQ_API_KEY');
    process.exit(1);
  }

  console.log(`${BOLD}agent-task convergence benchmark${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log();

  const wallStart = Date.now();
  let passed = 0;
  for (const s of SCENARIOS) {
    const t0 = Date.now();
    let result: { pass: boolean; rationale: string; calls: CallRecord[] };
    try {
      result = await s.run();
    } catch (err) {
      result = { pass: false, rationale: `THREW: ${err instanceof Error ? err.message : String(err)}`, calls: [] };
    }
    const dt = Date.now() - t0;
    const tag = result.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    if (result.pass) passed++;
    console.log('─'.repeat(78));
    console.log(`${BOLD}${s.id}${RESET}  ${tag}  ${DIM}(${dt}ms)${RESET}`);
    console.log(`  ${DIM}desc:${RESET}      ${s.description}`);
    console.log(`  ${DIM}rationale:${RESET} ${result.rationale}`);
    console.log(`  ${DIM}llm-calls:${RESET} ${result.calls.length}`);
    for (let i = 0; i < result.calls.length; i++) {
      const c = result.calls[i];
      console.log(`    ${DIM}call ${i + 1}:${RESET} candidates=[${c.candidateIndices.join(',')}] words=[${c.candidateWords.join(',')}]`);
    }
  }
  const wallMs = Date.now() - wallStart;

  console.log('═'.repeat(78));
  console.log(`${BOLD}Total:${RESET} ${passed}/${SCENARIOS.length} pass`);
  console.log(`Wall-clock: ${(wallMs / 1000).toFixed(1)}s`);

  process.exit(passed === SCENARIOS.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
