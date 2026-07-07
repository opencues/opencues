// blank-context-recall — A/B runner.
//
// Usage:
//   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/blank-context-recall/run.ts
//
// Defaults to Groq if no provider env var is set. Runs both variants
// (baseline, examples) over all 30 cases sequentially, prints a
// per-class table + delta. Token emission is detected by regex over
// the ANSWER line — no LLM judge needed because emission is structural.

import { CASES, type RecallCase } from './cases';
import { SYSTEM_PROMPT, buildUserMessage, type Variant } from './prompts';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

const VARIANTS: ReadonlyArray<Variant> = [
  'baseline',
  'examples',
  'few-shot-heavy',
  'rule-first',
  'rule-first-multi',
  'chain-of-thought',
  'terse',
  'negative-heavy',
];

interface Result {
  caseId: string;
  klass: RecallCase['klass'];
  expectedLabel: string;
  rawAnswer: string;
  emittedTokens: string[];
  correct: boolean;
}

function parseAnswer(raw: string): string {
  const m = raw.match(/^ANSWER:\s*(.*)$/m);
  return m ? m[1].trim() : raw.trim();
}

/** Extract ALL bracket-tokens from the answer. The model may emit
 *  multiple (e.g. `[STOCKS NVDA] [STOCKS AAPL]`) and we want to count
 *  any-of-many for topic matching. */
function detectTokens(answer: string, validTokens: ReadonlyArray<string>): string[] {
  const found = answer.match(/\[[A-Z][A-Z 0-9_-]*\]/g) ?? [];
  // Only keep tokens actually in the catalog; invented tokens dropped
  // (the strict-mechanics rule + the post-processor strip would handle
  // them in production).
  return found.filter(t => validTokens.includes(t));
}

function expectedLabel(c: RecallCase): string {
  if (c.expected === null) return 'none';
  if (typeof c.expected === 'string') return c.expected;
  return `topic:${c.expected.topic}`;
}

async function runOne(c: RecallCase, variant: Variant): Promise<Result> {
  const userMsg = buildUserMessage(c, variant);
  const { text } = await chat(sysUser(SYSTEM_PROMPT, userMsg), { maxTokens: 256 });
  const answer = parseAnswer(text);
  const validTokens = c.catalog.map(t => t.token);
  const emitted = detectTokens(answer, validTokens);

  let correct: boolean;
  if (c.expected === null) {
    // Negative: no catalog token should appear.
    correct = emitted.length === 0;
  } else if (typeof c.expected === 'string') {
    // Specific token expected.
    correct = emitted.includes(c.expected);
  } else {
    // Topic predicate: at least one emitted token matches `[<TOPIC> ...]`.
    const prefix = `[${c.expected.topic} `;
    const exact = `[${c.expected.topic}]`;
    correct = emitted.some(t => t === exact || t.startsWith(prefix));
  }

  return {
    caseId: c.id,
    klass: c.klass,
    expectedLabel: expectedLabel(c),
    rawAnswer: answer,
    emittedTokens: emitted,
    correct,
  };
}

async function runVariant(variant: Variant): Promise<Result[]> {
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`Running variant: ${variant} (model: ${MODEL})`);
  console.log(`══════════════════════════════════════════════════════════════`);
  const results: Result[] = [];
  for (const c of CASES) {
    const r = await runOne(c, variant);
    results.push(r);
    const flag = r.correct ? '\x1b[32m●\x1b[0m' : '✗';
    const ans = r.rawAnswer.slice(0, 60).replace(/\s+/g, ' ');
    const got = r.emittedTokens.length === 0 ? '(prose)' : r.emittedTokens.join(',');
    console.log(`  ${flag} ${r.caseId} [${r.klass}] expected=${r.expectedLabel} got=${got}  → "${ans}"`);
  }
  return results;
}

function summarize(label: string, results: Result[]): void {
  const byKlass: Record<string, { pass: number; total: number }> = {
    positive: { pass: 0, total: 0 },
    negative: { pass: 0, total: 0 },
    ambiguous: { pass: 0, total: 0 },
  };
  for (const r of results) {
    byKlass[r.klass].total++;
    if (r.correct) byKlass[r.klass].pass++;
  }
  console.log(`\n${label}:`);
  for (const k of ['positive', 'negative', 'ambiguous'] as const) {
    const { pass, total } = byKlass[k];
    const pct = total === 0 ? '-' : ((pass / total) * 100).toFixed(1) + '%';
    console.log(`  ${k.padEnd(10)} ${pass}/${total} (${pct})`);
  }
  const overallPass = results.filter(r => r.correct).length;
  console.log(`  overall   ${overallPass}/${results.length} (${((overallPass / results.length) * 100).toFixed(1)}%)`);
}

async function main(): Promise<void> {
  const all: Record<string, Result[]> = {};
  for (const v of VARIANTS) {
    all[v] = await runVariant(v);
  }
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`SUMMARY (model: ${MODEL})`);
  console.log(`══════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) summarize(v, all[v]);
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`COMPACT TABLE`);
  console.log(`══════════════════════════════════════════════════════════════`);
  console.log(`variant            | positive | negative | ambiguous | overall`);
  console.log(`───────────────────|──────────|──────────|───────────|────────`);
  for (const v of VARIANTS) {
    const r = all[v];
    const byKlass: Record<string, { p: number; t: number }> = {
      positive: { p: 0, t: 0 }, negative: { p: 0, t: 0 }, ambiguous: { p: 0, t: 0 },
    };
    for (const x of r) { byKlass[x.klass].t++; if (x.correct) byKlass[x.klass].p++; }
    const pct = (k: string) => byKlass[k].t === 0 ? '   -  ' : ((byKlass[k].p / byKlass[k].t) * 100).toFixed(1).padStart(5) + '%';
    const overall = r.filter(x => x.correct).length;
    const overallPct = ((overall / r.length) * 100).toFixed(1).padStart(5) + '%';
    console.log(`${v.padEnd(18)} | ${pct('positive')}  | ${pct('negative')}  | ${pct('ambiguous')}   | ${overallPct} (${overall}/${r.length})`);
  }
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
