/**
 * Robustness benchmark — verifies the agent loop survives every
 * realistic failure mode from the LLM transport without crashing or
 * applying garbage edits.
 *
 * No real network calls — uses stubbed httpAdapters that simulate
 * each failure shape.
 *
 * Scenarios:
 *   1. empty-doc            Empty buffer → no candidates, no LLM call
 *   2. all-blanks-doc       "_ _ _" → no candidates (every word is _)
 *   3. single-word-cursor   1 word, cursor on it → 0 candidates
 *   4. all-owned            Every word owned by other source → 0 candidates
 *   5. empty-response       Transport returns "" → no edits, no throw
 *   6. malformed-json       Transport returns garbage → caught, no throw
 *   7. api-error            {error: {message: ...}} → caught, no throw
 *   8. rate-limit-error     429-shaped error → caught, no throw
 *   9. no-choices           Valid JSON but no .choices field → no edits
 *  10. empty-choice-content choices[0].message.content = "" → no edits
 *  11. malformed-edits      DECISIONS body with bogus lines → only valid edits applied
 *  12. edit-out-of-range    LLM proposes idx 99 in 5-word doc → defensive skip
 *  13. edit-stale-original  LLM uses wrong original word → defensive skip
 *  14. edit-noop            LLM proposes "x → x" → defensive skip
 *  15. edit-claimed-ix      LLM proposes idx now owned → defensive skip
 *  16. transport-throws     httpAdapter.post() throws → caught, no crash
 *
 * Each scenario asserts: (a) loop.runOnce resolves without throwing,
 * (b) the right number of edits got applied as DynDefs.
 */

import { AgentTaskState } from '../../../packages/opencues-runtime/src/state/agent-task';
import { DynDefs, WordDef } from '../../../packages/opencues-runtime/src/state/dyn-defs';
import { AgentLoop } from '../../../packages/opencues-runtime/src/modules/agent-loop';
import { splitWords } from '../../../packages/opencues-runtime/src/modules/navigation';
import type { HostAdapter, RenderContext } from '../../../packages/opencues-runtime/src/adapter';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface Scenario {
  id: string;
  description: string;
  run: () => Promise<{ pass: boolean; rationale: string }>;
}

function makeMockAdapter(initialText: string, cursor = -1) {
  let text = initialText;
  let cur = cursor === -1 ? text.length + 1 : cursor;
  const adapter = {
    capabilities: ['file-write', 'force-render'],
    cwd: '/tmp/agent-task-robustness',
    getText: () => text,
    setText: (t: string) => { text = t; },
    pushText: (t: string, c: number) => { text = t; cur = c; },
    getCursorOffset: () => cur,
    setCursorOffset: (c: number) => { cur = c; },
    forceRender: () => {},
    log: () => {},
    onTextChange: () => () => {},
    onRender: (_cb: (ctx: RenderContext) => unknown) => () => {},
  } as unknown as HostAdapter;
  return { adapter, getText: () => text };
}

function stubHttp(responder: (body: string) => Promise<string> | string) {
  return {
    async post(_url: string, body: string, _headers: Record<string, string>): Promise<string> {
      const r = responder(body);
      return typeof r === 'string' ? r : await r;
    },
  };
}

function buildLoop(adapter: HostAdapter, state: AgentTaskState, dynDefs: DynDefs, http: { post(url: string, body: string, headers: Record<string, string>): Promise<string> }) {
  return new AgentLoop(adapter, state, dynDefs, undefined, {
    endpoint: 'https://stub',
    apiKey: 'stub-key',
    defaultModel: 'stub-model',
    httpAdapter: http,
    log: () => {},
  });
}

function makeOpenAiResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function countAgentEdits(dynDefs: DynDefs, maxIdx: number): number {
  let n = 0;
  for (let i = 0; i < maxIdx + 5; i++) {
    const d = dynDefs.get(i);
    if (d && d.blankName === 'agent-task') n++;
  }
  return n;
}

let httpCallCount = 0;
function countingStub(stubFn: (body: string) => Promise<string> | string) {
  return {
    async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
      httpCallCount++;
      return await stubHttp(stubFn).post(url, body, headers);
    },
  };
}

const SCENARIOS: Scenario[] = [
  {
    id: 'empty-doc',
    description: 'Empty buffer → no LLM call, no throw',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('', -1);
      httpCallCount = 0;
      const loop = buildLoop(adapter, state, dynDefs, countingStub(() => makeOpenAiResponse('EDITS:\nnone\nEND')));
      await loop.runOnce('');
      const pass = httpCallCount === 0 && countAgentEdits(dynDefs, 0) === 0;
      return { pass, rationale: pass ? 'no LLM call, no edits' : `httpCalls=${httpCallCount} edits=${countAgentEdits(dynDefs, 0)}` };
    },
  },
  {
    id: 'all-blanks-doc',
    description: 'Doc is "_ _ _" → 0 candidates → 0 LLM calls',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('_ _ _', -1);
      httpCallCount = 0;
      const loop = buildLoop(adapter, state, dynDefs, countingStub(() => makeOpenAiResponse('EDITS:\nnone\nEND')));
      await loop.runOnce('_ _ _');
      const pass = httpCallCount === 0;
      return { pass, rationale: pass ? 'all-blank doc bypasses LLM' : `httpCalls=${httpCallCount}` };
    },
  },
  {
    id: 'single-word-cursor',
    description: 'Single-word doc with cursor on it → 0 candidates',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('hello', 3);
      httpCallCount = 0;
      const loop = buildLoop(adapter, state, dynDefs, countingStub(() => makeOpenAiResponse('EDITS:\nnone\nEND')));
      await loop.runOnce('hello');
      const pass = httpCallCount === 0;
      return { pass, rationale: pass ? 'cursor-occupied single word excluded' : `httpCalls=${httpCallCount}` };
    },
  },
  {
    id: 'all-owned',
    description: 'Every word owned by other source → 0 candidates',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const text = 'hello world';
      const wordSpans = splitWords(text);
      for (let i = 0; i < wordSpans.length; i++) {
        const w = wordSpans[i];
        const def: WordDef = {
          originalWord: w.word, alternatives: [w.word, 'x'], currentIndex: 0,
          spanStart: w.start, spanEnd: w.end, blankName: 'other-source',
        };
        dynDefs.set(i, def);
      }
      const { adapter } = makeMockAdapter(text, -1);
      httpCallCount = 0;
      const loop = buildLoop(adapter, state, dynDefs, countingStub(() => makeOpenAiResponse('EDITS:\nnone\nEND')));
      await loop.runOnce(text);
      const pass = httpCallCount === 0;
      return { pass, rationale: pass ? 'all-owned doc bypasses LLM' : `httpCalls=${httpCallCount}` };
    },
  },
  {
    id: 'empty-response',
    description: 'Transport returns "" → defensive skip, no throw',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter', -1);
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => ''));
      await loop.runOnce('thier letter');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'survived empty response' : `unexpected edits applied` };
    },
  },
  {
    id: 'malformed-json',
    description: 'Transport returns garbage → caught, no throw',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter', -1);
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => '<html>500 Internal</html>'));
      await loop.runOnce('thier letter');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'survived garbage response' : `unexpected edits applied` };
    },
  },
  {
    id: 'api-error',
    description: '{"error":{"message":"…"}} → caught, no edits',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter', -1);
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => JSON.stringify({ error: { message: 'invalid api key' } })));
      await loop.runOnce('thier letter');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'API error handled' : `unexpected edits applied` };
    },
  },
  {
    id: 'rate-limit-error',
    description: '429-shaped error → caught, no edits',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter', -1);
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => JSON.stringify({ error: { code: 429, type: 'rate_limit', message: 'Rate limit exceeded' } })));
      await loop.runOnce('thier letter');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'rate-limit handled' : `unexpected edits applied` };
    },
  },
  {
    id: 'no-choices',
    description: 'Valid JSON but no .choices → no edits',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter', -1);
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => JSON.stringify({ id: 'abc', model: 'foo' })));
      await loop.runOnce('thier letter');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'no-choices handled' : `unexpected edits applied` };
    },
  },
  {
    id: 'empty-choice-content',
    description: 'choices[0].message.content === "" → no edits',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter', -1);
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => makeOpenAiResponse('')));
      await loop.runOnce('thier letter');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'empty content handled' : `unexpected edits applied` };
    },
  },
  {
    id: 'malformed-edits',
    description: 'EDITS body with garbage lines → only valid lines parsed',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter today', -1);
      const garbage = 'EDITS:\ngibberish line\n0 | thier | their\n? | foo\n  bad |\n2 | today | KEEP\nEND';
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => makeOpenAiResponse(garbage)));
      await loop.runOnce('thier letter today');
      const editCount = countAgentEdits(dynDefs, 5);
      const pass = editCount === 1; // only "0 | thier | their" survives parse
      return { pass, rationale: pass ? '1 valid edit applied, garbage skipped' : `expected 1 edit, got ${editCount}` };
    },
  },
  {
    id: 'edit-out-of-range',
    description: 'LLM proposes index outside doc bounds → defensive skip',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('hello world', -1);
      const body = 'EDITS:\n99 | nonexistent | replaced\n0 | hello | hello\nEND';
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => makeOpenAiResponse(body)));
      await loop.runOnce('hello world');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'out-of-range index skipped' : `unexpected edits applied` };
    },
  },
  {
    id: 'edit-stale-original',
    description: 'LLM proposes wrong original word → defensive skip',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('hello world', -1);
      // Word 0 is "hello", but LLM thinks it's "stale"
      const body = 'EDITS:\n0 | stale | replacement\nEND';
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => makeOpenAiResponse(body)));
      await loop.runOnce('hello world');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'stale-original edit skipped' : `unexpected edits applied` };
    },
  },
  {
    id: 'edit-noop',
    description: 'LLM proposes x → x → parsed-out as no-op',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('hello world', -1);
      const body = 'EDITS:\n0 | hello | hello\nEND';
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => makeOpenAiResponse(body)));
      await loop.runOnce('hello world');
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'no-op edit skipped' : `unexpected edits applied` };
    },
  },
  {
    id: 'edit-claimed-ix',
    description: 'LLM proposes index claimed by another source → skip',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const text = 'thier letter';
      const wordSpans = splitWords(text);
      // Pre-claim index 0 ("thier")
      const w = wordSpans[0];
      dynDefs.set(0, {
        originalWord: w.word, alternatives: [w.word, 'their-other'], currentIndex: 0,
        spanStart: w.start, spanEnd: w.end, blankName: 'other-source',
      });
      const { adapter } = makeMockAdapter(text, -1);
      // LLM still tries to edit it — should be filtered out by candidateSet check
      const body = 'EDITS:\n0 | thier | their\nEND';
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => makeOpenAiResponse(body)));
      await loop.runOnce(text);
      const pass = countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'claimed-index edit skipped' : `agent overwrote claimed index` };
    },
  },
  {
    id: 'transport-throws',
    description: 'httpAdapter.post() throws → caught, no crash',
    async run() {
      const state = new AgentTaskState(); state.arm('correct spelling');
      const dynDefs = new DynDefs();
      const { adapter } = makeMockAdapter('thier letter', -1);
      const loop = buildLoop(adapter, state, dynDefs, stubHttp(() => { throw new Error('ECONNRESET'); }));
      let crashed = false;
      try { await loop.runOnce('thier letter'); } catch { crashed = true; }
      const pass = !crashed && countAgentEdits(dynDefs, 5) === 0;
      return { pass, rationale: pass ? 'transport throw caught gracefully' : crashed ? 'loop crashed' : `unexpected edits` };
    },
  },
];

async function main() {
  console.log(`${BOLD}agent-task robustness benchmark${RESET}`);
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log();

  let passed = 0;
  for (const s of SCENARIOS) {
    const t0 = Date.now();
    let result: { pass: boolean; rationale: string };
    try { result = await s.run(); }
    catch (err) { result = { pass: false, rationale: `THREW: ${err instanceof Error ? err.message : String(err)}` }; }
    const dt = Date.now() - t0;
    const tag = result.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    if (result.pass) passed++;
    console.log(`${tag}  ${BOLD}${s.id.padEnd(22)}${RESET} ${DIM}(${dt}ms)${RESET}  ${result.rationale}`);
  }

  console.log('═'.repeat(78));
  console.log(`${BOLD}Total:${RESET} ${passed}/${SCENARIOS.length} pass`);
  process.exit(passed === SCENARIOS.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
