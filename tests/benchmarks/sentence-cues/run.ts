/**
 * sentence-cues benchmark — entry point.
 *
 * Per case:
 *   1. Segment the input into sentences (segment.ts).
 *   2. Run the FUSED prompt once (one LLM call per buffer).
 *   3. Match the model's output blocks against the case's expectations
 *      (by sentence-text equality, with normalisation tolerance).
 *   4. Per expectation:
 *        - expect: MORE_FORMAL — at least one alt must judge MORE_FORMAL
 *        - expect: SAME        — model should emit `ALT: NONE` OR zero alts
 *                                  (anything else counts as a precision miss,
 *                                  unless all emitted alts judge SAME — that's
 *                                  tolerated since it's not actively wrong)
 *        - expect: CEDE        — model MUST emit `ALT: NONE` or zero alts
 *                                  (emitting any alt is a precision failure)
 *
 * Headline metrics:
 *   RECALL    — among MORE_FORMAL expectations, fraction that got ≥1
 *               MORE_FORMAL alt. Target ≥ 80%.
 *   PRECISION — among CEDE expectations, fraction correctly ceded.
 *               Target ≥ 95% (technical/fragment misfires are user-visible
 *               clutter; should be rare).
 *
 * Per-bucket breakdown shows where misses concentrate (clean-informal
 * recall vs fuzzy-informal recall vs cede precision separately).
 *
 * Usage:
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/sentence-cues/run.ts --parallel 4
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/sentence-cues/run.ts --parallel 4
 */

import { CASES, SentenceCueCase } from './cases';
import { runFused, FusedSentenceResult, SentenceAltBlock } from './fused';
import { judgeAlt, AltVerdict } from './judge';
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
  parallel: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { parallel: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') out.caseId = args[++i];
    else if (args[i] === '--category') out.category = args[++i];
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

function filterCases(cases: SentenceCueCase[], filter: { caseId?: string; category?: string }): SentenceCueCase[] {
  return cases.filter(c => {
    if (filter.caseId && c.id !== filter.caseId) return false;
    if (filter.category && c.category !== filter.category) return false;
    return true;
  });
}

const sep = (ch = '─') => console.log(ch.repeat(78));
const normSentence = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();

type ExpVerdict = 'PASS_HIT' | 'PASS_CEDE' | 'PASS_SAME' | 'FAIL_RECALL' | 'FAIL_PRECISION' | 'FAIL_BROKEN' | 'FAIL_NO_BLOCK';

interface ExpOutcome {
  caseId: string;
  category: SentenceCueCase['category'];
  expectKind: 'MORE_FORMAL' | 'SAME' | 'CEDE';
  verdict: ExpVerdict;
  rationale: string;
  altVerdicts: AltVerdict[];
}

async function judgeExpectation(
  c: SentenceCueCase,
  expIdx: number,
  block: SentenceAltBlock | undefined,
): Promise<ExpOutcome> {
  const exp = c.expectations[expIdx];
  const head = { caseId: c.id, category: c.category, expectKind: exp.expect } as const;

  if (!block) {
    // Model emitted no block for this sentence at all — recall failure
    // for MORE_FORMAL, no-op for CEDE/SAME (cede is "don't produce
    // alts", which trivially holds when there's no block).
    if (exp.expect === 'CEDE' || exp.expect === 'SAME') {
      return { ...head, verdict: exp.expect === 'CEDE' ? 'PASS_CEDE' : 'PASS_SAME', rationale: 'no block emitted', altVerdicts: [] };
    }
    return { ...head, verdict: 'FAIL_NO_BLOCK', rationale: 'model emitted no block for this sentence', altVerdicts: [] };
  }

  if (block.alts.length === 0 || block.ceded) {
    // Model explicitly ceded (NONE) or emitted zero alts.
    if (exp.expect === 'CEDE') return { ...head, verdict: 'PASS_CEDE', rationale: 'model emitted NONE / no alts', altVerdicts: [] };
    if (exp.expect === 'SAME') return { ...head, verdict: 'PASS_SAME', rationale: 'model correctly ceded already-formal', altVerdicts: [] };
    return { ...head, verdict: 'FAIL_RECALL', rationale: 'model ceded on a MORE_FORMAL expectation', altVerdicts: [] };
  }

  // We have alts. Judge each against the original.
  const altVerdicts: AltVerdict[] = [];
  for (const alt of block.alts) {
    const j = await judgeAlt({ original: exp.originalSentence, alt, acceptableAlts: exp.acceptableAlts });
    altVerdicts.push(j.verdict);
  }
  const counts = altVerdicts.reduce((m, v) => { m[v] = (m[v] ?? 0) + 1; return m; }, {} as Record<AltVerdict, number>);

  if (exp.expect === 'MORE_FORMAL') {
    if ((counts.MORE_FORMAL ?? 0) >= 1) {
      return { ...head, verdict: 'PASS_HIT', rationale: `${counts.MORE_FORMAL} alt(s) judged MORE_FORMAL`, altVerdicts };
    }
    if ((counts.BROKEN ?? 0) > 0) {
      return { ...head, verdict: 'FAIL_BROKEN', rationale: `no MORE_FORMAL alt; ${counts.BROKEN} broken`, altVerdicts };
    }
    return { ...head, verdict: 'FAIL_RECALL', rationale: `no MORE_FORMAL alt (counts: ${JSON.stringify(counts)})`, altVerdicts };
  }

  if (exp.expect === 'CEDE') {
    // Hit on CEDE is precision failure regardless of formality.
    return { ...head, verdict: 'FAIL_PRECISION', rationale: `emitted ${block.alts.length} alt(s) on a CEDE expectation`, altVerdicts };
  }

  // expect: SAME. We accept SAME-flavoured alts (all alts SAME or
  // smaller MORE_FORMAL lifts are tolerable — the sentence was already
  // formal). Penalise if any alt is BROKEN or LESS_FORMAL.
  if ((counts.BROKEN ?? 0) > 0 || (counts.LESS_FORMAL ?? 0) > 0) {
    return { ...head, verdict: 'FAIL_BROKEN', rationale: `produced broken/less-formal alt on already-formal input`, altVerdicts };
  }
  return { ...head, verdict: 'PASS_SAME', rationale: 'alts preserve formality or improve it', altVerdicts };
}

async function runOne(c: SentenceCueCase): Promise<{ outcomes: ExpOutcome[]; fused: FusedSentenceResult }> {
  const fused = await runFused(c.input);
  // Map each expectation to its model block by sentence-text match.
  const findBlock = (originalSentence: string): SentenceAltBlock | undefined => {
    const norm = normSentence(originalSentence);
    return fused.blocks.find(b => normSentence(b.sentence) === norm);
  };
  const outcomes: ExpOutcome[] = [];
  for (let i = 0; i < c.expectations.length; i++) {
    const block = findBlock(c.expectations[i].originalSentence);
    outcomes.push(await judgeExpectation(c, i, block));
  }

  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${DIM}[${c.category}]${RESET}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}FUSED MS:${RESET} ${fused.latencyMs}`);
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    const exp = c.expectations[i];
    const tag = o.verdict.startsWith('PASS') ? `${GREEN}${o.verdict}${RESET}` : `${RED}${o.verdict}${RESET}`;
    console.log(`  ${DIM}exp ${i}  :${RESET} ${tag}  expect=${exp.expect}  rationale=${o.rationale}`);
    if (o.altVerdicts.length) {
      console.log(`    ${DIM}alts  :${RESET} ${o.altVerdicts.join(', ')}`);
    }
  }
  return { outcomes, fused };
}

async function main() {
  const filter = parseArgs();
  const selected = filterCases(CASES, filter);
  if (selected.length === 0) {
    console.error(`No cases matched filter ${JSON.stringify(filter)}`);
    process.exit(2);
  }

  console.log(`${BOLD}sentence-cues bench — more-formal classifier${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Cases: ${selected.length}/${CASES.length} (${selected.reduce((n, c) => n + c.expectations.length, 0)} expectations)`);
  console.log();

  // Worker-pool concurrency.
  const results: Array<{ outcomes: ExpOutcome[]; fused: FusedSentenceResult }> = new Array(selected.length);
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

  // Aggregate.
  const allOutcomes: ExpOutcome[] = [];
  let totalFusedMs = 0;
  for (let i = 0; i < results.length; i++) {
    allOutcomes.push(...results[i].outcomes);
    totalFusedMs += results[i].fused.latencyMs;
  }

  const expByKind = (kind: 'MORE_FORMAL' | 'SAME' | 'CEDE') => allOutcomes.filter(o => o.expectKind === kind);
  const moreFormal = expByKind('MORE_FORMAL');
  const same = expByKind('SAME');
  const cede = expByKind('CEDE');

  const recallNumerator = moreFormal.filter(o => o.verdict === 'PASS_HIT').length;
  const precisionNumerator = cede.filter(o => o.verdict === 'PASS_CEDE').length;
  const sameNumerator = same.filter(o => o.verdict === 'PASS_SAME').length;

  const pct = (n: number, d: number) => d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;

  const buckets: Array<SentenceCueCase['category']> = [
    'clean-informal', 'fuzzy-informal', 'already-formal',
    'multi-sentence', 'edge-short', 'edge-technical',
  ];
  const perBucket: Record<string, { pass: number; total: number }> = {};
  for (const o of allOutcomes) {
    const slot = perBucket[o.category] ?? { pass: 0, total: 0 };
    slot.total++;
    if (o.verdict.startsWith('PASS')) slot.pass++;
    perBucket[o.category] = slot;
  }

  sep('═');
  console.log(`${BOLD}Headline${RESET}`);
  console.log(`  ${BOLD}Recall${RESET}    (MORE_FORMAL → MORE_FORMAL alt):  ${recallNumerator}/${moreFormal.length} = ${pct(recallNumerator, moreFormal.length)}  ${DIM}[target ≥ 80%]${RESET}`);
  console.log(`  ${BOLD}Precision${RESET} (CEDE → no alt):                 ${precisionNumerator}/${cede.length} = ${pct(precisionNumerator, cede.length)}  ${DIM}[target ≥ 95%]${RESET}`);
  console.log(`  ${BOLD}Same-OK${RESET}   (already-formal preserved):       ${sameNumerator}/${same.length} = ${pct(sameNumerator, same.length)}`);
  const totalPass = recallNumerator + precisionNumerator + sameNumerator;
  console.log(`  ${BOLD}Total pass${RESET}: ${totalPass}/${allOutcomes.length} (${pct(totalPass, allOutcomes.length)})`);
  console.log();
  console.log(`${BOLD}Per-bucket${RESET}`);
  for (const b of buckets) {
    const slot = perBucket[b];
    if (!slot) continue;
    console.log(`  ${b.padEnd(20)}: ${slot.pass}/${slot.total} (${pct(slot.pass, slot.total)})`);
  }
  console.log();
  console.log(`Avg buffer latency: ${(totalFusedMs / selected.length).toFixed(0)}ms`);
  console.log(`Wall-clock total: ${(wallMs / 1000).toFixed(1)}s  (parallel=${filter.parallel}, ${selected.length} cases)`);
  console.log(`Throughput: ${(selected.length / (wallMs / 1000)).toFixed(2)} cases/sec`);

  // Exit gate.
  const recallMet = moreFormal.length === 0 || recallNumerator / moreFormal.length >= 0.80;
  const precisionMet = cede.length === 0 || precisionNumerator / cede.length >= 0.95;
  process.exit(recallMet && precisionMet ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
