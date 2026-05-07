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
  format?: 'DECISIONS' | 'EDITS';
  /** When true, fall back to the LLM judge for cases that the
   *  hand-authored acceptable list rejects. Catches stylistic-prompt
   *  variance (`gonna → "going to"` etc.). Costs 1 extra LLM call per
   *  unmatched edit so we leave it opt-in. */
  judge: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { parallel: 1, judge: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') out.caseId = args[++i];
    else if (args[i] === '--category') out.category = args[++i];
    else if (args[i] === '--parallel') out.parallel = parseInt(args[++i], 10) || 1;
    else if (args[i] === '--judge') out.judge = true;
    else if (args[i] === '--format') {
      const f = args[++i];
      if (f !== 'DECISIONS' && f !== 'EDITS') {
        console.error(`--format must be DECISIONS or EDITS, got ${f}`);
        process.exit(2);
      }
      out.format = f;
    }
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

let RUN_FORMAT: 'DECISIONS' | 'EDITS' | undefined;
let RUN_JUDGE = false;
// Per-run judge call counters — surfaces extra LLM cost in the report.
let JUDGE_CALLS = 0;
let JUDGE_RESCUED = 0;
let JUDGE_LATENCY_MS = 0;

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
    promptFormat: RUN_FORMAT,
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
    // Match expected ↔ applied by ORIGINAL WORD CONTENT (shift-tolerant).
    // When the LLM emits a multi-word edit upstream (e.g. "gonna →
    // going to"), every downstream word's index shifts right by N-1.
    // The runtime correctly stores the def at the post-splice index,
    // so a strict idx match would fail the assertion even when the
    // edit landed where it should. We match by original word and
    // tie-break on idx-distance to pick the closest candidate.
    const usedAppliedIndices = new Set<number>();
    for (const exp of expected) {
      // Match either:
      //   (a) exact single-word match — applied.original === expected.original
      //   (b) range edit covering the expected word — applied.original
      //       (a space-joined span like "just wanna") contains the
      //       expected word as one of its tokens. This handles the LLM
      //       choosing a range edit (e.g. "0-1 | just wanna | I would
      //       like to") when our case authored a single-word expectation.
      //
      // A SINGLE applied range edit can satisfy MULTIPLE expected edits
      // (one applied for "any way" → "anyway" satisfies both
      // expected[any] and expected[way]). We don't deduplicate by
      // appliedIdx for matching — only for "extras" reporting at the
      // end. Single-word applied edits naturally only match one
      // expected because their `original` is a single token.
      const candidates = appliedEdits
        .map((e, i) => ({ e, i }))
        .filter(({ e }) =>
          (e.original === exp.originalWord ||
            e.original.split(/\s+/).includes(exp.originalWord)),
        );
      if (candidates.length === 0) {
        pass = false;
        messages.push(`missing edit for "${exp.originalWord}" (expected at idx ${exp.wordIndex} → ${exp.acceptableEdits.join(' / ')})`);
        continue;
      }
      candidates.sort((a, b) =>
        Math.abs(a.e.wordIndex - exp.wordIndex) - Math.abs(b.e.wordIndex - exp.wordIndex),
      );
      const { e: got, i: gotIdx } = candidates[0];
      usedAppliedIndices.add(gotIdx);

      const acceptable = exp.acceptableEdits.map(s => s.toLowerCase());
      if (!acceptable.includes(got.edited.toLowerCase())) {
        if (RUN_JUDGE) {
          // Fall back to the LLM judge: did the edit semantically
          // fulfill the prompt? Catches stylistic-prompt variance
          // where the hand-authored acceptable list is just one of
          // many fine answers.
          const t = Date.now();
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { judgeAgentEdit } = require('./judge') as typeof import('./judge');
          // Note: this is the only async call in this otherwise
          // synchronous block; the runner's outer concurrency keeps
          // throughput high.
          // eslint-disable-next-line no-await-in-loop
          const verdict = await judgeAgentEdit({
            task: c.prompt,
            originalWord: got.original,
            editedWord: got.edited,
            acceptableHints: exp.acceptableEdits,
            context: c.text,
          });
          JUDGE_CALLS += 1;
          JUDGE_LATENCY_MS += verdict.latencyMs;
          if (verdict.verdict === 'PASS') {
            JUDGE_RESCUED += 1;
            messages.push(`judge rescue: "${got.original}" → "${got.edited}" — ${verdict.rationale}`);
          } else {
            pass = false;
            messages.push(`edit "${got.original}" at idx ${got.wordIndex}: "${got.edited}" not in [${exp.acceptableEdits.join(', ')}]; judge: ${verdict.rationale}`);
          }
          void t;
        } else {
          pass = false;
          messages.push(`edit "${got.original}" at idx ${got.wordIndex}: "${got.edited}" not in [${exp.acceptableEdits.join(', ')}]`);
        }
      } else if (got.wordIndex !== exp.wordIndex) {
        messages.push(`note: "${exp.originalWord}" edited at idx ${got.wordIndex} (expected ${exp.wordIndex}; shifted by upstream multi-word expansion — not a failure)`);
      }
    }
    // Anything unmatched in appliedEdits is a true extra.
    for (let i = 0; i < appliedEdits.length; i += 1) {
      if (usedAppliedIndices.has(i)) continue;
      const got = appliedEdits[i];
      messages.push(`extra unexpected edit at index ${got.wordIndex}: ${got.original} → ${got.edited}`);
      // Don't fail on extras unless they hit a forbidden idx (already checked above).
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

  RUN_FORMAT = args.format;
  RUN_JUDGE = args.judge;

  console.log(`${BOLD}agent-task benchmark${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Format: ${args.format ?? 'DECISIONS (default)'}`);
  console.log(`Judge:  ${args.judge ? 'ON (LLM-as-judge fallback for failed acceptable-list matches)' : 'OFF'}`);
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
  console.log();

  // Accuracy vs cost report — separate the two concerns so a regression
  // in either is easy to spot in CI output.
  console.log(`${BOLD}── Accuracy ──${RESET}`);
  console.log(`  pass rate:                    ${pct(passed, selected.length)} (${passed}/${selected.length})`);
  if (RUN_JUDGE) {
    console.log(`  judge calls:                  ${JUDGE_CALLS}`);
    console.log(`  judge rescues (FAIL → PASS):  ${JUDGE_RESCUED}`);
  }
  console.log();
  console.log(`${BOLD}── Cost ──${RESET}`);
  console.log(`  avg primary call latency:     ${avg(totalLatency)}ms`);
  if (RUN_JUDGE) {
    console.log(`  total judge LLM calls:        ${JUDGE_CALLS}`);
    console.log(`  total judge LLM time:         ${JUDGE_LATENCY_MS}ms`);
    console.log(`  judge throughput share:       ${pct(JUDGE_LATENCY_MS, totalLatency + JUDGE_LATENCY_MS)} of all LLM time`);
  }
  console.log(`  ${BOLD}wall-clock total:${RESET}            ${(wallMs / 1000).toFixed(1)}s  (parallel=${args.parallel})`);
  console.log(`  throughput:                   ${(selected.length / (wallMs / 1000)).toFixed(2)} cases/sec`);

  process.exit(passed === selected.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
