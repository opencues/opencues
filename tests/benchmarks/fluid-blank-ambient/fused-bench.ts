/**
 * Drives the candidate AMBIENT-AWARE FUSED prompt through:
 *   - standard 137-case fluid-blank suite (no ambient)
 *   - 18 in-prompt ambient cases
 *   - 21 held-out ambient cases
 *
 * Single LLM call per case, mirroring what production will do after
 * the P1+P3 → fused swap.
 *
 * Usage:
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
 *     npx tsx tests/benchmarks/fluid-blank-ambient/fused-bench.ts
 */

import { CASES as STD_CASES } from '../fluid-blank/cases';
import { CASES as AMB_CASES } from './cases';
import { HOLDOUT_CASES } from './cases-holdout';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';
import { judgeAnswer } from '../fluid-blank/judge-answer';
// Import from production so this bench validates the live prompt.
import { FUSED_SYSTEM_PROMPT as FUSED_AMBIENT_SYSTEM_PROMPT } from '../../../packages/opencues-core/src/sources/fluid-blank-source';
import { renderAmbientMinimal } from './prompts';
import type { AmbientCase } from './cases';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PARALLEL = parseInt(process.env.PARALLEL ?? '8', 10);

interface Outcome {
  suite: string;
  id: string;
  pass: boolean;
  actual: string;
  expected: string;
  latencyMs: number;
  rationale: string;
}

async function runOne(
  suite: string,
  id: string,
  input: string,
  ambient: AmbientCase['ambient'] | undefined,
  expectedAnswer: string,
  alternates: string[] = [],
): Promise<Outcome> {
  const ambBlock = renderAmbientMinimal(ambient);
  // Ambient stays in user message — the LLM must bind it tightly to
  // the INPUT (`paris _` in a Postcode field → SW1A 1AA). Earlier
  // attempt to move ambient to system regressed the bench from 175 →
  // 166. Identity + blank-context catalogs DO move to system in
  // production for cerebras prefix-cache hits, but those are tested
  // by separate suites (transform-blank-sentinels, transform-blank-
  // blank-context).
  const userMsg = `INPUT: ${input}${ambBlock}`;
  const t0 = Date.now();
  const r = await chat(sysUser(FUSED_AMBIENT_SYSTEM_PROMPT, userMsg), { maxTokens: 512, temperature: 0, seed: 42 });
  const latencyMs = Date.now() - t0;
  const answerMatch = r.text.match(/^ANSWER:\s*([\s\S]*?)\s*$/im);
  const actual = answerMatch ? answerMatch[1].trim() : r.text.trim();
  const j = await judgeAnswer({ question: input, expectedAnswer, expectedAlternates: alternates, actualAnswer: actual });
  return { suite, id, pass: j.verdict === 'PASS', actual, expected: expectedAnswer, latencyMs, rationale: j.rationale };
}

async function runConc<T, R>(items: T[], fn: (x: T) => Promise<R>, conc: number): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; res[idx] = await fn(items[idx]); }
  }));
  return res;
}

function summary(label: string, out: Outcome[]) {
  const pass = out.filter(o => o.pass).length;
  const avg = out.length ? Math.round(out.reduce((a, o) => a + o.latencyMs, 0) / out.length) : 0;
  console.log(`${BOLD}${label}${RESET}: ${pass}/${out.length} (${out.length ? ((pass / out.length) * 100).toFixed(1) : 0}%)  avg ${avg}ms`);
  for (const f of out.filter(o => !o.pass)) {
    console.log(`  ${RED}FAIL${RESET}  ${f.id}`);
    console.log(`    ${DIM}expected:${RESET} ${f.expected}`);
    console.log(`    ${DIM}actual  :${RESET} ${f.actual}`);
    console.log(`    ${DIM}judge   :${RESET} ${f.rationale}`);
  }
}

async function main() {
  console.log(`${BOLD}AMBIENT-AWARE FUSED candidate vs (standard 137 + ambient 18 + holdout 21)${RESET}`);
  console.log(`Model: ${MODEL}   parallel: ${PARALLEL}\n`);

  const wall0 = Date.now();

  const stdOut = await runConc(STD_CASES, c => runOne('std', c.id, c.input, undefined, c.expected.answer, c.expected.answerAlternates ?? []), PARALLEL);
  summary('standard 137', stdOut);

  // Ambient bench cases use SPAN (not raw input). For the fused prompt
  // we pass span as INPUT (the user's typed buffer + _).
  const ambOut = await runConc(AMB_CASES, c => runOne('amb', c.id, c.span, c.ambient, c.expected.answer, c.expected.alternates ?? []), PARALLEL);
  summary('ambient in-prompt 18', ambOut);

  const holdOut = await runConc(HOLDOUT_CASES, c => runOne('hold', c.id, c.span, c.ambient, c.expected.answer, c.expected.alternates ?? []), PARALLEL);
  summary('ambient holdout 21', holdOut);

  const all = [...stdOut, ...ambOut, ...holdOut];
  const pass = all.filter(o => o.pass).length;
  console.log(`\n${BOLD}TOTAL${RESET}: ${GREEN}${pass}/${all.length}${RESET} (${((pass / all.length) * 100).toFixed(1)}%)  wall ${((Date.now() - wall0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
