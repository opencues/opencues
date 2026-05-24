/**
 * fluid-blank benchmark — entry point.
 *
 * Two modes:
 *   --mode segment (default) — P1 SEGMENT only + segmentation judge
 *   --mode answer            — P1 → P3 (skip P2), end-to-end answer judge
 *
 * Suite selection:
 *   (default)    — cases.ts, the curated 137-case suite
 *   --holdout    — cases-holdout.ts, stale synthetic suite
 *   --generated  — cases-generated.jsonl, output of `generate.ts`. Reads
 *                  whatever is in the file at startup. Run `generate.ts`
 *                  separately to grow the file.
 *
 * Usage:
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/fluid-blank/run.ts
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/fluid-blank/run.ts --mode answer
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/fluid-blank/run.ts --mode answer --generated
 */

import * as fs from 'fs';
import * as path from 'path';
import { CASES, FluidBlankCase } from './cases';
import { CASES_HOLDOUT } from './cases-holdout';
import { CASES_FACTUAL_BENCH } from './cases-factual-bench';
import { CASES_MATH_BENCH } from './cases-math-bench';
import { CASES_UNIT_BENCH } from './cases-unit-bench';
import { CASES_COLOR_BENCH } from './cases-color-bench';
import { CASES_HTTP_BENCH } from './cases-http-bench';
import { CASES_ROMAN_BENCH } from './cases-roman-bench';
import { CASES_TRANSLATION_BENCH } from './cases-translation-bench';
import { CASES_SPELLING_BENCH } from './cases-spelling-bench';
import { runP1Segment } from './pass1-segment';
import { judgeSegment } from './judge-segment';
import { runP3Answer } from './pass3-answer';
import { runFused } from './fused';
import { judgeAnswer } from './judge-answer';
import { runSpecializedFactual } from './specialized-factual';
import { runSpecializedMath } from './specialized-math';
import { runSpecializedUnit } from './specialized-unit';
import { runSpecializedColor } from './specialized-color';
import { runSpecializedHttp } from './specialized-http';
import { runSpecializedRoman } from './specialized-roman';
import { runSpecializedTranslation } from './specialized-translation';
import { runSpecializedSpelling } from './specialized-spelling';
import { classify } from './classify';
import { MODEL } from './groq';

function loadGenerated(): FluidBlankCase[] {
  const file = path.join(__dirname, 'cases-generated.jsonl');
  if (!fs.existsSync(file)) {
    console.error(`No generated cases at ${file}. Run generate.ts first.`);
    process.exit(2);
  }
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as FluidBlankCase);
}

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

type Mode = 'segment' | 'answer' | 'fused'
  | 'specialized-factual' | 'specialized-math' | 'specialized-unit' | 'specialized-color'
  | 'specialized-http' | 'specialized-roman' | 'specialized-translation' | 'specialized-spelling'
  | 'classified';

const VALID_MODES: Mode[] = [
  'segment', 'answer', 'fused',
  'specialized-factual', 'specialized-math', 'specialized-unit', 'specialized-color',
  'specialized-http', 'specialized-roman', 'specialized-translation', 'specialized-spelling',
  'classified',
];

interface Args {
  caseId?: string;
  category?: string;
  holdout?: boolean;
  generated?: boolean;
  bench?: 'factual' | 'math' | 'unit' | 'color' | 'http' | 'roman' | 'translation' | 'spelling';
  mode: Mode;
  parallel: number;
  /** Cap on cases to run (after filters). For directional sweeps against slow / throttled providers. */
  limit?: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { mode: 'segment', parallel: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--case') out.caseId = args[++i];
    else if (args[i] === '--category') out.category = args[++i];
    else if (args[i] === '--holdout') out.holdout = true;
    else if (args[i] === '--generated') out.generated = true;
    else if (args[i] === '--factual-bench') out.bench = 'factual';
    else if (args[i] === '--math-bench') out.bench = 'math';
    else if (args[i] === '--unit-bench') out.bench = 'unit';
    else if (args[i] === '--color-bench') out.bench = 'color';
    else if (args[i] === '--http-bench') out.bench = 'http';
    else if (args[i] === '--roman-bench') out.bench = 'roman';
    else if (args[i] === '--translation-bench') out.bench = 'translation';
    else if (args[i] === '--spelling-bench') out.bench = 'spelling';
    else if (args[i] === '--parallel') {
      const v = parseInt(args[++i], 10);
      if (Number.isNaN(v) || v < 1) {
        console.error(`--parallel must be a positive integer, got: ${args[i]}`);
        process.exit(2);
      }
      out.parallel = v;
    }
    else if (args[i] === '--limit') {
      const v = parseInt(args[++i], 10);
      if (Number.isNaN(v) || v < 1) {
        console.error(`--limit must be a positive integer, got: ${args[i]}`);
        process.exit(2);
      }
      out.limit = v;
    }
    else if (args[i] === '--mode') {
      const v = args[++i];
      if (!VALID_MODES.includes(v as Mode)) {
        console.error(`--mode must be one of ${VALID_MODES.join(' | ')}, got: ${v}`);
        process.exit(2);
      }
      out.mode = v as Mode;
    }
  }
  return out;
}

function filterCases(cases: FluidBlankCase[], filter: { caseId?: string; category?: string }): FluidBlankCase[] {
  return cases.filter(c => {
    if (filter.caseId && c.id !== filter.caseId) return false;
    if (filter.category && c.category !== filter.category) return false;
    return true;
  });
}

/**
 * Tag each case `realistic` (input ends at _ with no substantive trailing
 * text — matches real typing where _ fires before the user types more)
 * vs `synthetic` (text after _, or _ before the lookup, or _ in middle
 * — only happens if user mid-edits or stops typing past _).
 *
 * Realistic = primary user-facing path. Synthetic = robustness check.
 */
function classifyRealism(input: string): 'realistic' | 'synthetic' {
  const idx = input.lastIndexOf('_');
  if (idx === -1) return 'synthetic';
  const after = input.slice(idx + 1).trim();
  if (after === '' || /^[.!?,;]+$/.test(after)) return 'realistic';
  return 'synthetic';
}

const sep = (ch = '─') => console.log(ch.repeat(78));

async function runOneSegment(c: FluidBlankCase) {
  const seg = await runP1Segment(c.input);
  const judge = await judgeSegment({
    input: c.input,
    expectedSpan: c.expected.shouldFailSoft ? null : c.expected.span,
    actualSpan: seg.span,
  });

  const pass = judge.verdict === 'PASS';
  const realism = classifyRealism(c.input);
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const cat = `${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}`;

  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}EXPECTED:${RESET} ${c.expected.shouldFailSoft ? '(NONE — fail-soft)' : c.expected.span}`);
  console.log(`  ${DIM}ACTUAL  :${RESET} ${seg.span ?? '(NONE)'}`);
  console.log(`  ${DIM}CONTEXT :${RESET} ${seg.context || '(empty)'}`);
  console.log(`  ${DIM}JUDGE   :${RESET} ${judge.rationale}`);
  console.log(`  ${DIM}TIMING  :${RESET} P1=${seg.latencyMs}ms  judge=${judge.latencyMs}ms`);
  if (!pass) {
    console.log(`  ${YELLOW}RAW P1  :${RESET} ${seg.raw.replace(/\n/g, '\n           ')}`);
  }

  return { pass, p1Ms: seg.latencyMs, p3Ms: 0, judgeMs: judge.latencyMs, realism };
}

async function runOneClassified(c: FluidBlankCase) {
  const realism = classifyRealism(c.input);

  // Step 1: P1 segment
  const seg = await runP1Segment(c.input);
  if (!seg.span) {
    sep();
    console.log(`${BOLD}${c.id}${RESET}  ${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}  ${RED}FAIL${RESET}`);
    console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
    console.log(`  ${DIM}P1 SPAN :${RESET} (NONE — P1 bailed)`);
    console.log(`  ${DIM}EXP ANS :${RESET} ${c.expected.answer}`);
    console.log(`  ${DIM}TIMING  :${RESET} P1=${seg.latencyMs}ms`);
    return { pass: false, p1Ms: seg.latencyMs, p3Ms: 0, judgeMs: 0, realism };
  }

  // Step 2: classify the span
  const cls = await classify(seg.span);

  // Step 3: route to specialized OR fall through to P3
  let answer: string | null;
  let answerMs: number;
  let answerRaw: string;
  let routedTo: string;

  const specHandlers: Record<string, ((s: string) => Promise<{ answer: string | null; raw: string; latencyMs: number }>) | null> = {
    FACTUAL: runSpecializedFactual,
    MATH: runSpecializedMath,
    UNIT: runSpecializedUnit,
    COLOR: runSpecializedColor,
    HTTP: runSpecializedHttp,
    ROMAN: runSpecializedRoman,
    TRANSLATION: runSpecializedTranslation,
    SPELLING: runSpecializedSpelling,
    TIMEZONE: null,
    GRAMMAR: null,
  };
  const handler = specHandlers[cls.mode];
  if (handler) {
    const ans = await handler(seg.span);
    answer = ans.answer;
    answerMs = ans.latencyMs;
    answerRaw = ans.raw;
    routedTo = `specialized-${cls.mode.toLowerCase()}`;
  } else {
    const ans = await runP3Answer({ span: seg.span, context: seg.context });
    answer = ans.answer;
    answerMs = ans.latencyMs;
    answerRaw = ans.raw;
    routedTo = `P3 fallback (${cls.mode})`;
  }

  const judge = await judgeAnswer({
    question: c.expected.question,
    expectedAnswer: c.expected.answer,
    expectedAlternates: c.expected.answerAlternates,
    actualAnswer: answer,
  });

  const pass = judge.verdict === 'PASS';
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const cat = `${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}`;
  const expFull = c.expected.answerAlternates?.length
    ? `${c.expected.answer} ${DIM}(or: ${c.expected.answerAlternates.join(', ')})${RESET}`
    : c.expected.answer;

  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}P1 SPAN :${RESET} ${seg.span}`);
  console.log(`  ${DIM}MODE    :${RESET} ${cls.mode}  ${DIM}→ ${routedTo}${RESET}`);
  console.log(`  ${DIM}ANSWER  :${RESET} ${answer ?? '(empty)'}`);
  console.log(`  ${DIM}EXP ANS :${RESET} ${expFull}`);
  console.log(`  ${DIM}JUDGE   :${RESET} ${judge.rationale}`);
  console.log(`  ${DIM}TIMING  :${RESET} P1=${seg.latencyMs}ms  classify=${cls.latencyMs}ms  ans=${answerMs}ms  judge=${judge.latencyMs}ms`);
  if (!pass) {
    console.log(`  ${YELLOW}RAW ANS :${RESET} ${answerRaw.replace(/\n/g, '\n           ')}`);
  }

  return { pass, p1Ms: seg.latencyMs + cls.latencyMs, p3Ms: answerMs, judgeMs: judge.latencyMs, realism };
}

async function runOneSpecializedDirect(
  c: FluidBlankCase,
  handler: (input: string) => Promise<{ answer: string | null; raw: string; latencyMs: number }>,
  label: string,
) {
  const realism = classifyRealism(c.input);
  const ans = await handler(c.input);
  const judge = await judgeAnswer({
    question: c.expected.question,
    expectedAnswer: c.expected.answer,
    expectedAlternates: c.expected.answerAlternates,
    actualAnswer: ans.answer,
  });
  const pass = judge.verdict === 'PASS';
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}  ${tag}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}${label.toUpperCase().padEnd(8)}:${RESET} ${ans.answer ?? '(empty)'}`);
  console.log(`  ${DIM}EXP ANS :${RESET} ${c.expected.answer}`);
  console.log(`  ${DIM}JUDGE   :${RESET} ${judge.rationale}`);
  console.log(`  ${DIM}TIMING  :${RESET} ${label}=${ans.latencyMs}ms  judge=${judge.latencyMs}ms`);
  if (!pass) console.log(`  ${YELLOW}RAW     :${RESET} ${ans.raw.replace(/\n/g, '\n           ')}`);
  return { pass, p1Ms: 0, p3Ms: ans.latencyMs, judgeMs: judge.latencyMs, realism };
}

async function runOneSpecializedFactual(c: FluidBlankCase) {
  const realism = classifyRealism(c.input);

  const ans = await runSpecializedFactual(c.input);
  const judge = await judgeAnswer({
    question: c.expected.question,
    expectedAnswer: c.expected.answer,
    expectedAlternates: c.expected.answerAlternates,
    actualAnswer: ans.answer,
  });

  const pass = judge.verdict === 'PASS';
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const cat = `${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}`;
  const expFull = c.expected.answerAlternates?.length
    ? `${c.expected.answer} ${DIM}(or: ${c.expected.answerAlternates.join(', ')})${RESET}`
    : c.expected.answer;

  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}SPEC ANS:${RESET} ${ans.answer ?? '(empty)'}`);
  console.log(`  ${DIM}EXP ANS :${RESET} ${expFull}`);
  console.log(`  ${DIM}JUDGE   :${RESET} ${judge.rationale}`);
  console.log(`  ${DIM}TIMING  :${RESET} spec=${ans.latencyMs}ms  judge=${judge.latencyMs}ms`);
  if (!pass) {
    console.log(`  ${YELLOW}RAW SPEC:${RESET} ${ans.raw.replace(/\n/g, '\n           ')}`);
  }

  return { pass, p1Ms: 0, p3Ms: ans.latencyMs, judgeMs: judge.latencyMs, realism };
}

async function runOneFused(c: FluidBlankCase) {
  const realism = classifyRealism(c.input);
  const f = await runFused(c.input);

  if (!f.span) {
    // Fused bailed — score as failure unless the case is fail-soft.
    const fakeAnswer = c.expected.shouldFailSoft ? '(bailed)' : null;
    const judge = await judgeAnswer({
      question: c.expected.question,
      expectedAnswer: c.expected.answer,
      expectedAlternates: c.expected.answerAlternates,
      actualAnswer: fakeAnswer,
    });
    const pass = c.expected.shouldFailSoft ? true : judge.verdict === 'PASS';
    const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    sep();
    console.log(`${BOLD}${c.id}${RESET}  ${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}  ${tag}`);
    console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
    console.log(`  ${DIM}FUSED   :${RESET} (bailed — SPAN=NONE)`);
    console.log(`  ${DIM}EXP ANS :${RESET} ${c.expected.answer}`);
    console.log(`  ${DIM}TIMING  :${RESET} fused=${f.latencyMs}ms`);
    return { pass, p1Ms: f.latencyMs, p3Ms: 0, judgeMs: judge.latencyMs, realism };
  }

  const judge = await judgeAnswer({
    question: c.expected.question,
    expectedAnswer: c.expected.answer,
    expectedAlternates: c.expected.answerAlternates,
    actualAnswer: f.answer,
  });

  const pass = judge.verdict === 'PASS';
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const cat = `${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}`;
  const expFull = c.expected.answerAlternates?.length
    ? `${c.expected.answer} ${DIM}(or: ${c.expected.answerAlternates.join(', ')})${RESET}`
    : c.expected.answer;
  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}SPAN    :${RESET} ${f.span}`);
  console.log(`  ${DIM}ANSWER  :${RESET} ${f.answer ?? '(empty)'}`);
  console.log(`  ${DIM}EXP ANS :${RESET} ${expFull}`);
  console.log(`  ${DIM}JUDGE   :${RESET} ${judge.rationale}`);
  console.log(`  ${DIM}TIMING  :${RESET} fused=${f.latencyMs}ms  judge=${judge.latencyMs}ms`);
  if (!pass) {
    console.log(`  ${YELLOW}RAW     :${RESET} ${f.raw.replace(/\n/g, '\n           ')}`);
  }
  return { pass, p1Ms: f.latencyMs, p3Ms: 0, judgeMs: judge.latencyMs, realism };
}

async function runOneAnswer(c: FluidBlankCase) {
  // P1: segment first to get span + context
  const seg = await runP1Segment(c.input);
  const realism = classifyRealism(c.input);

  if (!seg.span) {
    // P1 bailed — score as failure (no answer can be produced)
    sep();
    console.log(`${BOLD}${c.id}${RESET}  ${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}  ${RED}FAIL${RESET}`);
    console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
    console.log(`  ${DIM}P1 SPAN :${RESET} (NONE — P1 bailed)`);
    console.log(`  ${DIM}EXP ANS :${RESET} ${c.expected.answer}`);
    console.log(`  ${DIM}TIMING  :${RESET} P1=${seg.latencyMs}ms`);
    return { pass: false, p1Ms: seg.latencyMs, p3Ms: 0, judgeMs: 0, realism };
  }

  // P3: answer the lookup
  const ans = await runP3Answer({ span: seg.span, context: seg.context });

  // Judge: did P3's answer match expected?
  const judge = await judgeAnswer({
    question: c.expected.question,
    expectedAnswer: c.expected.answer,
    expectedAlternates: c.expected.answerAlternates,
    actualAnswer: ans.answer,
  });

  const pass = judge.verdict === 'PASS';
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const cat = `${DIM}[${c.category}/${realism === 'realistic' ? 'r' : 's'}]${RESET}`;
  const expFull = c.expected.answerAlternates?.length
    ? `${c.expected.answer} ${DIM}(or: ${c.expected.answerAlternates.join(', ')})${RESET}`
    : c.expected.answer;

  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}P1 SPAN :${RESET} ${seg.span}`);
  console.log(`  ${DIM}P3 ANS  :${RESET} ${ans.answer ?? '(empty)'}`);
  console.log(`  ${DIM}EXP ANS :${RESET} ${expFull}`);
  console.log(`  ${DIM}JUDGE   :${RESET} ${judge.rationale}`);
  console.log(`  ${DIM}TIMING  :${RESET} P1=${seg.latencyMs}ms  P3=${ans.latencyMs}ms  judge=${judge.latencyMs}ms`);
  if (!pass) {
    console.log(`  ${YELLOW}RAW P3  :${RESET} ${ans.raw.replace(/\n/g, '\n           ')}`);
  }

  return { pass, p1Ms: seg.latencyMs, p3Ms: ans.latencyMs, judgeMs: judge.latencyMs, realism };
}

async function main() {
  const filter = parseArgs();
  const benchCases: Record<NonNullable<Args['bench']>, FluidBlankCase[]> = {
    factual: CASES_FACTUAL_BENCH,
    math: CASES_MATH_BENCH,
    unit: CASES_UNIT_BENCH,
    color: CASES_COLOR_BENCH,
    http: CASES_HTTP_BENCH,
    roman: CASES_ROMAN_BENCH,
    translation: CASES_TRANSLATION_BENCH,
    spelling: CASES_SPELLING_BENCH,
  };
  const allCases = filter.generated ? loadGenerated()
    : filter.bench ? benchCases[filter.bench]
    : filter.holdout ? CASES_HOLDOUT
    : CASES;
  const setName = filter.generated ? 'GENERATED'
    : filter.bench ? `${filter.bench.toUpperCase()}-BENCH (${benchCases[filter.bench].length})`
    : filter.holdout ? 'HOLDOUT'
    : 'main';
  const filtered = filterCases(allCases, filter);
  const selected = filter.limit ? filtered.slice(0, filter.limit) : filtered;
  if (selected.length === 0) {
    console.error(`No cases matched filter ${JSON.stringify(filter)}`);
    process.exit(2);
  }

  const modeLabel = filter.mode === 'answer' ? 'P1 → P3 (2-pass, end-to-end answer)'
    : filter.mode === 'fused' ? 'FUSED segment+answer (1 call, structured output)'
    : filter.mode === 'specialized-factual' ? 'SPECIALIZED FACTUAL (1 call, production prompt)'
    : filter.mode === 'classified' ? 'P1 → CLASSIFY → SPECIALIZED|P3 (3-call hybrid)'
    : 'P1 SEGMENT only';
  console.log(`${BOLD}fluid-blank benchmark — ${modeLabel}${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Suite: ${setName}`);
  console.log(`Cases: ${selected.length}/${allCases.length}`);
  console.log();

  let passed = 0;
  let totalP1 = 0;
  let totalP3 = 0;
  let totalJudge = 0;
  let passedR = 0, totalR = 0;
  let passedS = 0, totalS = 0;
  const specHandlerByMode: Partial<Record<Mode, [(s: string) => Promise<{ answer: string | null; raw: string; latencyMs: number }>, string]>> = {
    'specialized-factual': [runSpecializedFactual, 'factual'],
    'specialized-math': [runSpecializedMath, 'math'],
    'specialized-unit': [runSpecializedUnit, 'unit'],
    'specialized-color': [runSpecializedColor, 'color'],
    'specialized-http': [runSpecializedHttp, 'http'],
    'specialized-roman': [runSpecializedRoman, 'roman'],
    'specialized-translation': [runSpecializedTranslation, 'translation'],
    'specialized-spelling': [runSpecializedSpelling, 'spelling'],
  };
  const runOne = (c: FluidBlankCase) =>
    filter.mode === 'answer' ? runOneAnswer(c)
      : filter.mode === 'fused' ? runOneFused(c)
      : filter.mode === 'classified' ? runOneClassified(c)
      : filter.mode === 'segment' ? runOneSegment(c)
      : specHandlerByMode[filter.mode]
        ? runOneSpecializedDirect(c, specHandlerByMode[filter.mode]![0], specHandlerByMode[filter.mode]![1])
        : runOneSegment(c);

  // Worker-pool concurrency (mirrors transform-blank/run.ts). Per-case
  // output already streams to stdout from each runOne* helper; lines from
  // concurrent workers may interleave but the final summary is still
  // accurate (totals are computed from the returned RunOutcome objects).
  const results: Array<{ pass: boolean; p1Ms: number; p3Ms: number; judgeMs: number; realism: 'realistic' | 'synthetic' }>
    = new Array(selected.length);
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

  for (const r of results) {
    if (r.pass) passed++;
    totalP1 += r.p1Ms;
    totalP3 += r.p3Ms;
    totalJudge += r.judgeMs;
    if (r.realism === 'realistic') {
      totalR++;
      if (r.pass) passedR++;
    } else {
      totalS++;
      if (r.pass) passedS++;
    }
  }

  const pct = (n: number, d: number) => d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
  const avg = (total: number) => (total / selected.length).toFixed(0);

  sep('═');
  console.log(`${BOLD}Realistic:${RESET}  ${passedR}/${totalR} pass (${pct(passedR, totalR)})  ${DIM}— _ at end, primary user path${RESET}`);
  console.log(`${BOLD}Synthetic:${RESET}  ${passedS}/${totalS} pass (${pct(passedS, totalS)})  ${DIM}— text after _, robustness check${RESET}`);
  console.log(`${BOLD}Total:${RESET}      ${passed}/${selected.length} pass (${pct(passed, selected.length)})`);
  if (filter.mode === 'answer') {
    console.log(`Avg P1: ${avg(totalP1)}ms  Avg P3: ${avg(totalP3)}ms  Avg judge: ${avg(totalJudge)}ms  Avg total: ${avg(totalP1 + totalP3 + totalJudge)}ms`);
  } else {
    console.log(`Avg P1: ${avg(totalP1)}ms  Avg judge: ${avg(totalJudge)}ms`);
  }
  // Surface the per-case model latency (excluding judge) and wall-clock
  // in the same "Avg model (per case): Xms" / "Wall-clock total: Xs" /
  // "Throughput: X cases/sec" format as transform-blank so the shared
  // summarize.sh script can grep both benches identically.
  const totalModel = totalP1 + totalP3;
  console.log(`Avg model (per case): ${avg(totalModel)}ms  Avg judge: ${avg(totalJudge)}ms`);
  console.log(`Wall-clock total: ${(wallMs / 1000).toFixed(1)}s  (parallel=${filter.parallel}, ${selected.length} cases)`);
  console.log(`Throughput: ${(selected.length / (wallMs / 1000)).toFixed(2)} cases/sec`);
  process.exit(passed === selected.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
