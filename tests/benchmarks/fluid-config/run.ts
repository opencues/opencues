/**
 * fluid-config benchmark — entry point.
 *
 * One mode (FUSED single-call classifier). Two metrics that matter:
 *
 *   PRECISION (gate)  — among REJECT cases, % correctly classified as NONE.
 *                       Routing "what's the weather _" to voice-mode is a
 *                       trust catastrophe. Target ≥ 98%.
 *   RECALL            — among HIT cases, % where setting AND value match.
 *                       Missing "make it loud _" is fine (FluidBlank still
 *                       answers). Target ≥ 80%.
 *
 * Plus a per-bucket breakdown so we can see *which* bucket is leaking.
 * The interesting failure modes are:
 *
 *   - FP (reject → setting)         — the precision killer
 *   - WRONG_SETTING (hit → other)   — silently flips the wrong scalar
 *   - WRONG_VALUE (hit → bad value) — known setting but wrong value
 *   - FN (hit → NONE)               — recoverable, fluid-blank takes over
 *
 * Usage:
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/fluid-config/run.ts
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/fluid-config/run.ts --parallel 8
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss CEREBRAS_API_KEY=xxx \
 *     npx tsx tests/benchmarks/fluid-config/run.ts --parallel 8
 *   --case <id>          run only one case
 *   --category <bucket>  filter by category (hit-clean, reject-fluid, etc.)
 */

import { CASES, FluidConfigCase } from './cases';
import { CASES_HOLDOUT } from './cases-holdout';
import { runFused } from './fused';
import { judge, Verdict } from './judge';
import { MODEL } from './groq';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface Args {
  caseId?: string;
  category?: string;
  holdout?: boolean;
  parallel: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { parallel: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') out.caseId = args[++i];
    else if (args[i] === '--category') out.category = args[++i];
    else if (args[i] === '--holdout') out.holdout = true;
    else if (args[i] === '--parallel') {
      const v = parseInt(args[++i], 10);
      if (Number.isNaN(v) || v < 1) {
        console.error(`--parallel must be a positive integer, got: ${args[i]}`);
        process.exit(2);
      }
      out.parallel = v;
    }
  }
  return out;
}

function filterCases(cases: FluidConfigCase[], filter: { caseId?: string; category?: string }): FluidConfigCase[] {
  return cases.filter(c => {
    if (filter.caseId && c.id !== filter.caseId) return false;
    if (filter.category && c.category !== filter.category) return false;
    return true;
  });
}

const sep = (ch = '─') => console.log(ch.repeat(78));

interface RunOutcome {
  caseId: string;
  category: FluidConfigCase['category'];
  verdict: Verdict;
  pass: boolean;
  latencyMs: number;
}

async function runOne(c: FluidConfigCase): Promise<RunOutcome> {
  const r = await runFused(c.input);
  const j = judge(c, r);

  const tag = j.pass ? `${GREEN}${j.verdict}${RESET}` : `${RED}${j.verdict}${RESET}`;
  const cat = `${DIM}[${c.category}]${RESET}`;
  const expFmt = c.expected.setting === null
    ? 'NONE'
    : `${c.expected.setting}=${c.expected.value}${c.expected.valueAlternates ? ` (or ${c.expected.valueAlternates.join('|')})` : ''}`;
  const actFmt = r.setting === null
    ? 'NONE'
    : `${r.setting}=${r.value ?? '(empty)'}`;
  const conf = r.confidence === null ? 'n/a' : r.confidence.toFixed(2);

  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  console.log(`  ${DIM}INPUT     :${RESET} ${c.input}`);
  console.log(`  ${DIM}EXPECTED  :${RESET} ${expFmt}`);
  console.log(`  ${DIM}ACTUAL    :${RESET} ${actFmt}  ${DIM}conf=${conf}${RESET}`);
  console.log(`  ${DIM}JUDGE     :${RESET} ${j.rationale}`);
  console.log(`  ${DIM}TIMING    :${RESET} ${r.latencyMs}ms`);
  if (!j.pass) {
    console.log(`  ${YELLOW}RAW       :${RESET} ${r.raw.replace(/\n/g, '\n              ')}`);
  }

  return { caseId: c.id, category: c.category, verdict: j.verdict, pass: j.pass, latencyMs: r.latencyMs };
}

async function main() {
  const filter = parseArgs();
  const allCases = filter.holdout ? CASES_HOLDOUT : CASES;
  const setName = filter.holdout ? 'HOLDOUT' : 'in-prompt';
  const selected = filterCases(allCases, filter);
  if (selected.length === 0) {
    console.error(`No cases matched filter ${JSON.stringify(filter)}`);
    process.exit(2);
  }

  console.log(`${BOLD}fluid-config benchmark — single FUSED classifier call${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Suite: ${setName}`);
  console.log(`Cases: ${selected.length}/${allCases.length}`);
  console.log();

  const results: RunOutcome[] = new Array(selected.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(filter.parallel, selected.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= selected.length) return;
      results[i] = await runOne(selected[i]);
    }
  });
  const wallStart = Date.now();
  await Promise.all(workers);
  const wallMs = Date.now() - wallStart;

  // ── Aggregates ──────────────────────────────────────────────────
  let totalLatency = 0;
  const verdictCounts: Record<Verdict, number> = {
    TP: 0, WRONG_SETTING: 0, WRONG_VALUE: 0, FN: 0, TN: 0, FP: 0,
  };
  const perCategory: Record<string, { total: number; pass: number; fail: Record<Verdict, number> }> = {};

  for (const r of results) {
    verdictCounts[r.verdict]++;
    totalLatency += r.latencyMs;
    const slot = perCategory[r.category] ?? { total: 0, pass: 0, fail: { TP: 0, WRONG_SETTING: 0, WRONG_VALUE: 0, FN: 0, TN: 0, FP: 0 } };
    slot.total++;
    if (r.pass) slot.pass++;
    if (!r.pass) slot.fail[r.verdict]++;
    perCategory[r.category] = slot;
  }

  const hits = verdictCounts.TP + verdictCounts.WRONG_SETTING + verdictCounts.WRONG_VALUE + verdictCounts.FN;
  const rejects = verdictCounts.TN + verdictCounts.FP;
  const recall = hits === 0 ? null : verdictCounts.TP / hits;
  const precision = rejects === 0 ? null : verdictCounts.TN / rejects;
  const passed = verdictCounts.TP + verdictCounts.TN;

  const pct = (v: number | null) => v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
  const fmtBuckets = (b: Record<Verdict, number>) =>
    (['FP', 'WRONG_SETTING', 'WRONG_VALUE', 'FN'] as Verdict[])
      .filter(v => b[v] > 0)
      .map(v => `${v}=${b[v]}`).join(' ');

  sep('═');
  console.log(`${BOLD}Headline metrics${RESET}`);
  console.log(`  ${BOLD}Precision${RESET} (rejects correctly = NONE): ${verdictCounts.TN}/${rejects} = ${pct(precision)}  ${DIM}[target ≥ 98%]${RESET}`);
  console.log(`  ${BOLD}Recall${RESET}    (hits correctly routed):    ${verdictCounts.TP}/${hits} = ${pct(recall)}  ${DIM}[target ≥ 80%]${RESET}`);
  console.log(`  ${BOLD}Total pass${RESET}: ${passed}/${selected.length} (${pct(passed / selected.length)})`);
  console.log();
  console.log(`${BOLD}Verdict breakdown${RESET}`);
  console.log(`  ${GREEN}TP${RESET} (hit → correct)              : ${verdictCounts.TP}`);
  console.log(`  ${GREEN}TN${RESET} (reject → NONE)              : ${verdictCounts.TN}`);
  console.log(`  ${RED}FP${RESET} (reject → some setting)      : ${verdictCounts.FP}  ${DIM}← precision killer${RESET}`);
  console.log(`  ${RED}WRONG_SETTING${RESET} (hit → wrong setting): ${verdictCounts.WRONG_SETTING}  ${DIM}← also bad${RESET}`);
  console.log(`  ${RED}WRONG_VALUE${RESET}   (hit → bad value)    : ${verdictCounts.WRONG_VALUE}`);
  console.log(`  ${YELLOW}FN${RESET} (hit → NONE)                 : ${verdictCounts.FN}  ${DIM}← recoverable (fluid-blank answers)${RESET}`);
  console.log();
  console.log(`${BOLD}Per-bucket${RESET}`);
  const bucketOrder: FluidConfigCase['category'][] = [
    'hit-clean', 'hit-fuzzy',
    'reject-user-blank', 'reject-fluid', 'reject-ambiguous', 'reject-out-of-scope',
  ];
  for (const b of bucketOrder) {
    const slot = perCategory[b];
    if (!slot) continue;
    const fails = fmtBuckets(slot.fail);
    const okPct = pct(slot.pass / slot.total);
    console.log(`  ${b.padEnd(22)}: ${slot.pass}/${slot.total}  (${okPct})  ${fails ? DIM + 'fails: ' + fails + RESET : ''}`);
  }
  console.log();
  console.log(`Avg latency: ${(totalLatency / selected.length).toFixed(0)}ms`);
  console.log(`Wall-clock total: ${(wallMs / 1000).toFixed(1)}s  (parallel=${filter.parallel}, ${selected.length} cases)`);
  console.log(`Throughput: ${(selected.length / (wallMs / 1000)).toFixed(2)} cases/sec`);

  // Exit 0 only if BOTH precision and recall hit their targets. Use the
  // strict gates so CI / sweeps fail loudly on regressions.
  const precisionMet = precision !== null && precision >= 0.98;
  const recallMet = recall !== null && recall >= 0.80;
  process.exit(precisionMet && recallMet ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
