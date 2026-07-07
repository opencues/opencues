/**
 * next-prompt-cues bench runner.
 *
 * For each case in cases.ts:
 *   1. Call the inference provider (set via OPENCUES_BENCH_PROVIDER)
 *      with the chosen prompt variant (--variant v1|v2|...)
 *   2. Parse the JSON output (schema check)
 *   3. If parse succeeds, ask the pinned-Groq judge to score
 *      distinct / relevant / advancing
 *   4. Print a per-case row + a summary table
 *
 * Usage:
 *   GROQ_API_KEY=... npx tsx tests/benchmarks/next-prompt-cues/run.ts --variant v1
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/next-prompt-cues/run.ts --variant v2
 *   --variant <v1|v2>     which prompt variant to test (default: v2)
 *   --parallel N           how many concurrent inference calls (default: 4)
 *   --case <id>            run only the one case with that id
 */

import { CASES, type NextPromptCase } from './cases';
import { PROMPT_V1, PROMPT_V2 } from './prompts';
import { chat, sysUser, MODEL } from './groq';
import { parseModelOutput, judge, type Score } from './judge';

type Variant = 'v1' | 'v2';

interface Args { variant: Variant; parallel: number; caseId?: string; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = { variant: 'v2', parallel: 4 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--variant' && a[i + 1]) { out.variant = a[++i] as Variant; }
    else if (a[i] === '--parallel' && a[i + 1]) { out.parallel = parseInt(a[++i], 10); }
    else if (a[i] === '--case' && a[i + 1]) { out.caseId = a[++i]; }
  }
  return out;
}

const PROMPTS: Record<Variant, string> = { v1: PROMPT_V1, v2: PROMPT_V2 };

interface CaseResult {
  case: NextPromptCase;
  rawOutput: string;
  parseOk: boolean;
  score: Score;
  latencyMs: number;
}

async function runOne(c: NextPromptCase, system: string): Promise<CaseResult> {
  const t0 = Date.now();
  let rawOutput = '';
  try {
    const r = await chat(sysUser(system, c.prompt), { maxTokens: 1500, seed: 42 });
    rawOutput = r.text;
  } catch (e) {
    const score: Score = { pass: false, schema: false, distinct: false, relevant: false, advancing: false, notes: `chat-error: ${(e as Error).message.slice(0, 200)}` };
    return { case: c, rawOutput, parseOk: false, score, latencyMs: Date.now() - t0 };
  }
  const parsed = parseModelOutput(rawOutput);
  const latencyMs = Date.now() - t0;
  if (!parsed) {
    const score: Score = { pass: false, schema: false, distinct: false, relevant: false, advancing: false, notes: `schema-fail: ${rawOutput.slice(0, 200)}` };
    return { case: c, rawOutput, parseOk: false, score, latencyMs };
  }
  const score = await judge(c.prompt, parsed);
  return { case: c, rawOutput, parseOk: true, score, latencyMs };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const system = PROMPTS[args.variant];
  const cases = args.caseId ? CASES.filter(c => c.id === args.caseId) : CASES;
  if (cases.length === 0) { console.error(`No cases match --case ${args.caseId}`); process.exit(2); }

  console.log(`\nnext-prompt-cues bench`);
  console.log(`  variant:  ${args.variant}`);
  console.log(`  model:    ${MODEL}  (provider: ${process.env.OPENCUES_BENCH_PROVIDER ?? 'groq'})`);
  console.log(`  cases:    ${cases.length}`);
  console.log(`  parallel: ${args.parallel}\n`);

  // Bounded-parallelism worker pool.
  const queue = [...cases];
  const results: CaseResult[] = [];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      const res = await runOne(c, system);
      results.push(res);
      const tag = res.score.pass ? '\x1b[32m●\x1b[0m' : '✗';
      const flags = [
        res.score.schema ? 'sch' : 'SCH',
        res.score.distinct ? 'dst' : 'DST',
        res.score.relevant ? 'rel' : 'REL',
        res.score.advancing ? 'adv' : 'ADV',
      ].join(' ');
      console.log(`${tag} ${c.id.padEnd(18)} ${c.category.padEnd(10)} ${res.latencyMs.toString().padStart(5)}ms  [${flags}]  ${res.score.notes.slice(0, 80)}`);
    }
  }
  await Promise.all(Array.from({ length: args.parallel }, () => worker()));

  // Restore case order for the summary (workers consume out-of-order).
  results.sort((a, b) => CASES.findIndex(c => c.id === a.case.id) - CASES.findIndex(c => c.id === b.case.id));

  // Per-category summary.
  const byCat = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const k = r.case.category;
    if (!byCat.has(k)) byCat.set(k, { pass: 0, total: 0 });
    const s = byCat.get(k)!; s.total++; if (r.score.pass) s.pass++;
  }
  const sub = (n: keyof Score) => results.filter(r => (r.score[n] as boolean) === true).length;
  const total = results.length;
  const passN = results.filter(r => r.score.pass).length;

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`Per-category:`);
  for (const [k, s] of byCat) {
    console.log(`  ${k.padEnd(10)} ${s.pass}/${s.total} (${(100 * s.pass / s.total).toFixed(0)}%)`);
  }
  console.log(`\nAggregate:`);
  console.log(`  schema    ${sub('schema')}/${total}  (output parses as JSON)`);
  console.log(`  distinct  ${sub('distinct')}/${total}  (three different directions)`);
  console.log(`  relevant  ${sub('relevant')}/${total}  (each cue connects to the answer)`);
  console.log(`  advancing ${sub('advancing')}/${total}  (each cue would advance the conversation)`);
  console.log(`──────────────────────────────────────────────────────────────`);
  console.log(`Overall:    ${passN}/${total} (${(100 * passN / total).toFixed(1)}%) pass all sub-checks`);

  const failed = results.filter(r => !r.score.pass);
  if (failed.length > 0) {
    console.log(`\nFailures (${failed.length}):`);
    for (const r of failed) {
      console.log(`  ${r.case.id}: ${r.score.notes.slice(0, 200)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
