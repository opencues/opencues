/**
 * Agent-task benchmark runner.
 *
 * For each case:
 *   1. Builds a fresh AgentTaskState armed with the case's prompt
 *   2. Builds a minimal mock adapter (text + cursor + log) and DynDefs
 *   3. Pre-claims any owned indices via dynDefs.set
 *   4. Pre-records evaluations for any already-evaluated indices
 *   5. Runs AgentLoop.runOnce(text)
 *   6. Inspects DynDefs to see what edits the agent applied
 *   7. Compares against case.expectedEdits / case.forbiddenIndices
 *
 * Uses real Groq calls — needs GROQ_API_KEY.
 *
 * Usage:
 *   GROQ_API_KEY=… npx tsx tests/benchmarks/agent-task/run.ts
 *   GROQ_API_KEY=… npx tsx tests/benchmarks/agent-task/run.ts --category spelling-task
 *   GROQ_API_KEY=… npx tsx tests/benchmarks/agent-task/run.ts --case spell-1
 *   GROQ_API_KEY=… npx tsx tests/benchmarks/agent-task/run.ts --parallel 4
 */

import { CASES, AgentTaskCase } from './cases';
import { httpAdapter, MODEL } from './groq';
import { AgentTaskState } from '../../../packages/opencues-runtime/src/state/agent-task';
import { DynDefs, WordDef } from '../../../packages/opencues-runtime/src/state/dyn-defs';
import { AgentLoop } from '../../../packages/opencues-runtime/src/modules/agent-loop';
import type { HostAdapter, RenderContext } from '../../../packages/opencues-runtime/src/adapter';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface Args {
  caseId?: string;
  category?: string;
  parallel: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { parallel: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') out.caseId = args[++i];
    else if (args[i] === '--category') out.category = args[++i];
    else if (args[i] === '--parallel') out.parallel = parseInt(args[++i], 10) || 1;
  }
  return out;
}

const sep = (ch = '─') => console.log(ch.repeat(78));

/**
 * Mock HostAdapter — minimal surface AgentLoop touches.
 */
function makeMockAdapter(initialText: string, cursorPos: number) {
  let text = initialText;
  // Default (cursorPos === -1): cursor PAST end of all words. The
  // benchmark default is "user is somewhere reading the doc, not
  // typing in any specific word". Tests that exercise cursor-adjacent
  // behavior set cursorPos explicitly. Otherwise the cursor falls
  // outside every word's [start, end] range and findCursorWordIdx
  // returns -1, making no word cursor-excluded.
  let cursor = cursorPos === -1 ? text.length + 1 : cursorPos;
  const logs: string[] = [];
  const onTextChangeListeners: Array<(e: { text: string; source: string }) => void> = [];

  const adapter = {
    capabilities: ['file-write', 'force-render'],
    cwd: '/tmp/agent-task-bench',
    getText: () => text,
    setText: (t: string) => { text = t; },
    pushText: (t: string, c: number) => { text = t; cursor = c; },
    getCursorOffset: () => cursor,
    setCursorOffset: (c: number) => { cursor = c; },
    forceRender: () => { /* no-op for benchmark */ },
    log: (level: string, msg: string, data?: unknown) => {
      logs.push(`[${level}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data).slice(0, 100) : ''}`);
    },
    onTextChange: (cb: (e: { text: string; source: string }) => void) => {
      onTextChangeListeners.push(cb);
      return () => {
        const idx = onTextChangeListeners.indexOf(cb);
        if (idx >= 0) onTextChangeListeners.splice(idx, 1);
      };
    },
    onRender: (_cb: (ctx: RenderContext) => unknown) => () => {},
  } as unknown as HostAdapter;

  return { adapter, getText: () => text, getCursor: () => cursor, getLogs: () => logs };
}

interface RunOutcome {
  pass: boolean;
  rationale: string;
  appliedEdits: Array<{ wordIndex: number; original: string; edited: string }>;
  output: string;
  latencyMs: number;
}

async function runCase(c: AgentTaskCase): Promise<RunOutcome> {
  const t0 = Date.now();

  // Build state + mock
  const state = new AgentTaskState();
  state.arm(c.prompt);
  const dynDefs = new DynDefs();
  const cursorPos = c.cursorPos ?? -1;
  const { adapter, getText, getLogs } = makeMockAdapter(c.text, cursorPos);

  // Pre-claim owned indices (simulating other source claims)
  if (c.ownedIndices) {
    const wordSpans = require('../../../packages/opencues-runtime/src/modules/navigation').splitWords(c.text);
    for (const i of c.ownedIndices) {
      const w = wordSpans[i];
      if (!w) continue;
      const def: WordDef = {
        originalWord: w.word,
        alternatives: [w.word, '<other-source-edit>'],
        currentIndex: 0,
        spanStart: w.start,
        spanEnd: w.end,
        blankName: 'mock-other-source',
      };
      dynDefs.set(i, def);
    }
  }

  // Pre-record cache hits
  if (c.alreadyEvaluatedIndices) {
    const wordSpans = require('../../../packages/opencues-runtime/src/modules/navigation').splitWords(c.text);
    const { hashWordText } = require('../../../packages/opencues-runtime/src/state/agent-task');
    for (const i of c.alreadyEvaluatedIndices) {
      const w = wordSpans[i];
      if (!w) continue;
      state.recordEvaluation(i, hashWordText(w.word));
    }
  }

  // Build agent loop
  const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY!,
    defaultModel: MODEL,
    httpAdapter,
    log: () => {},
  });

  // Run the agent
  await loop.runOnce(c.text);

  // Inspect DynDefs for agent edits
  const appliedEdits: Array<{ wordIndex: number; original: string; edited: string }> = [];
  // Iterate possible word indices
  const wordSpans = require('../../../packages/opencues-runtime/src/modules/navigation').splitWords(c.text);
  for (let i = 0; i < wordSpans.length + 5; i++) {
    const def = dynDefs.get(i);
    if (def && def.blankName === 'agent-task') {
      appliedEdits.push({
        wordIndex: i,
        original: def.originalWord,
        edited: def.alternatives[1] ?? '',
      });
    }
  }

  // Score
  let pass = true;
  const messages: string[] = [];

  // Check forbidden indices weren't touched
  if (c.forbiddenIndices) {
    for (const fi of c.forbiddenIndices) {
      const touched = appliedEdits.find(e => e.wordIndex === fi);
      if (touched) {
        pass = false;
        messages.push(`forbidden index ${fi} was edited (${touched.original} → ${touched.edited})`);
      }
    }
  }

  // Check expected edits
  const expected = c.expectedEdits ?? [];
  if (expected.length === 0) {
    // no-op case — we expect zero edits
    if (appliedEdits.length > 0) {
      pass = false;
      messages.push(`expected no edits, got ${appliedEdits.length}: ${JSON.stringify(appliedEdits)}`);
    }
  } else {
    // For each expected, find matching edit (strict on wordIndex; lenient on edited word via acceptable list)
    for (const exp of expected) {
      const got = appliedEdits.find(e => e.wordIndex === exp.wordIndex);
      if (!got) {
        pass = false;
        messages.push(`missing edit at index ${exp.wordIndex} (expected: ${exp.originalWord} → ${exp.acceptableEdits.join(' / ')})`);
        continue;
      }
      if (got.original !== exp.originalWord) {
        pass = false;
        messages.push(`edit at index ${exp.wordIndex}: original mismatch (got "${got.original}", expected "${exp.originalWord}")`);
        continue;
      }
      const acceptable = exp.acceptableEdits.map(s => s.toLowerCase());
      if (!acceptable.includes(got.edited.toLowerCase())) {
        pass = false;
        messages.push(`edit at index ${exp.wordIndex}: edited word "${got.edited}" not in acceptable list [${exp.acceptableEdits.join(', ')}]`);
      }
    }
    // Check no extra unexpected edits
    for (const got of appliedEdits) {
      const expected_ = expected.find(e => e.wordIndex === got.wordIndex);
      if (!expected_) {
        // Extra edit — could be acceptable (model finds something we didn't mark) or noisy
        messages.push(`extra unexpected edit at index ${got.wordIndex}: ${got.original} → ${got.edited}`);
        // Don't fail on extras unless forbidden
      }
    }
  }

  const latencyMs = Date.now() - t0;
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const cat = `${DIM}[${c.category}]${RESET}`;

  const lines: string[] = [];
  lines.push('─'.repeat(78));
  lines.push(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}  ${DIM}(${latencyMs}ms)${RESET}`);
  lines.push(`  ${DIM}PROMPT  :${RESET} ${c.prompt}`);
  lines.push(`  ${DIM}TEXT    :${RESET} ${JSON.stringify(c.text)}`);
  if (c.cursorPos !== undefined) lines.push(`  ${DIM}CURSOR  :${RESET} ${c.cursorPos}`);
  if (c.ownedIndices?.length) lines.push(`  ${DIM}OWNED   :${RESET} [${c.ownedIndices.join(', ')}]`);
  lines.push(`  ${DIM}EXPECTED:${RESET} ${expected.length === 0 ? '(no edits)' : expected.map(e => `${e.wordIndex}:${e.originalWord}→${e.acceptableEdits[0]}`).join(', ')}`);
  lines.push(`  ${DIM}APPLIED :${RESET} ${appliedEdits.length === 0 ? '(none)' : appliedEdits.map(e => `${e.wordIndex}:${e.original}→${e.edited}`).join(', ')}`);
  if (messages.length) {
    for (const m of messages) lines.push(`  ${YELLOW}↳${RESET} ${m}`);
  }

  return {
    pass,
    rationale: messages.join(' | '),
    appliedEdits,
    output: lines.join('\n'),
    latencyMs,
  };
}

async function runWithConcurrency<T, R>(items: T[], fn: (item: T) => Promise<R>, n: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs();
  let selected = CASES;
  if (args.category) selected = selected.filter(c => c.category === args.category);
  if (args.caseId) selected = selected.filter(c => c.id === args.caseId);
  if (selected.length === 0) {
    console.error(`No cases matched filter ${JSON.stringify(args)}`);
    process.exit(2);
  }

  console.log(`${BOLD}agent-task benchmark${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Cases: ${selected.length}/${CASES.length}  (parallel=${args.parallel})`);
  console.log();

  const wallStart = Date.now();
  const outcomes = await runWithConcurrency(selected, runCase, args.parallel);
  const wallMs = Date.now() - wallStart;

  for (const r of outcomes) console.log(r.output);

  let passed = 0;
  let totalLatency = 0;
  const byCategory = new Map<string, { pass: number; total: number }>();
  for (let i = 0; i < outcomes.length; i++) {
    const r = outcomes[i];
    const c = selected[i];
    if (r.pass) passed++;
    totalLatency += r.latencyMs;
    const slot = byCategory.get(c.category) ?? { pass: 0, total: 0 };
    slot.total++;
    if (r.pass) slot.pass++;
    byCategory.set(c.category, slot);
  }

  const pct = (n: number, d: number) => d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
  const avg = (total: number) => (total / selected.length).toFixed(0);

  sep('═');
  for (const [cat, s] of byCategory) {
    console.log(`${BOLD}${cat.padEnd(22)}${RESET} ${s.pass}/${s.total} pass (${pct(s.pass, s.total)})`);
  }
  sep('─');
  console.log(`${BOLD}Total:${RESET}      ${passed}/${selected.length} pass (${pct(passed, selected.length)})`);
  console.log(`Avg per case: ${avg(totalLatency)}ms`);
  console.log(`${BOLD}Wall-clock total:${RESET} ${(wallMs / 1000).toFixed(1)}s  (parallel=${args.parallel})`);
  console.log(`Throughput: ${(selected.length / (wallMs / 1000)).toFixed(2)} cases/sec`);

  process.exit(passed === selected.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
