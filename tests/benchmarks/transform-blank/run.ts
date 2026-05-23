/**
 * transform-blank benchmark — entry point.
 *
 * Three pipeline modes:
 *   --mode rewrite              — 1-pass: input → full rewritten text (default)
 *   --mode extract-apply        — 2-pass: P1 EXTRACT(instruction, target) → P2 APPLY
 *   --mode extract-apply-verify — 3-pass: 2-pass + P3 VERIFY (consistency repair)
 *
 * Filters:
 *   --case <id>          — run a single case
 *   --category <cat>     — run only one category (literal, multi-span,
 *                          concept, transform, negative)
 *
 * Usage:
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/transform-blank/run.ts
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/transform-blank/run.ts --mode extract-apply
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/transform-blank/run.ts --mode extract-apply-verify
 *   GROQ_API_KEY=xxx npx tsx tests/benchmarks/transform-blank/run.ts --category negative
 */

import { CASES, TransformCase } from './cases';
import { runRewrite } from './pass1-rewrite';
import { runExtract } from './pass1-extract';
import { runApply } from './pass2-apply';
import { runVerify } from './pass3-verify';
import { runSingleCall } from './single-call';
import { runFused } from './fused-extract-apply';
import { runFusedFull } from './fused-full';
import { runMinimalExtract, runMinimalApply, runMinimalVerify } from './minimal-prompts';
import { judge, JudgeInput } from './judge';
import { MODEL } from './groq';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

type Mode = 'rewrite' | 'extract-apply' | 'extract-apply-verify' | 'extract-apply-verify-skip-easy' | 'single-call'
  | 'fused' | 'fused-verify' | 'fused-full'
  | 'minimal-extract' | 'minimal-apply' | 'minimal-verify' | 'minimal-all'
  | 'skip-never' | 'skip-conservative' | 'skip-current' | 'skip-aggressive' | 'skip-always';
const VALID_MODES: Mode[] = [
  'rewrite', 'extract-apply', 'extract-apply-verify', 'extract-apply-verify-skip-easy', 'single-call',
  'fused', 'fused-verify', 'fused-full',
  'minimal-extract', 'minimal-apply', 'minimal-verify', 'minimal-all',
  'skip-never', 'skip-conservative', 'skip-current', 'skip-aggressive', 'skip-always',
];

interface Args {
  mode: Mode;
  caseId?: string;
  category?: string;
  parallel: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { mode: 'rewrite', parallel: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') {
      const v = args[++i];
      if (!VALID_MODES.includes(v as Mode)) {
        console.error(`--mode must be one of ${VALID_MODES.join(' | ')}, got: ${v}`);
        process.exit(2);
      }
      out.mode = v as Mode;
    } else if (args[i] === '--case') out.caseId = args[++i];
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

/**
 * Worker-pool concurrency. Returns results IN ORIGINAL ORDER even though
 * the actual execution is interleaved. Each worker pulls the next item
 * from a shared cursor, processes it, and writes to the result slot at
 * its original index — so the printed output reads sequentially while
 * `concurrency` cases run in parallel under the hood.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const sep = (ch = '─') => console.log(ch.repeat(78));

/**
 * Repair is suspiciously shorter than the draft AND target — model
 * truncated mid-sentence rather than emitting a real correction.
 */
function repairLooksTruncated(repair: string, draft: string, target: string): boolean {
  return repair.length < draft.length * 0.5 && repair.length < target.length * 0.5;
}

/**
 * Repair has telltale signs of model going off the rails mid-rewrite:
 * runs of whitespace, hidden zero-width chars, mid-sentence ellipsis used
 * as omission marker, repeated dash separators, or stray "END" tokens.
 */
function repairLooksGarbled(repair: string): boolean {
  // Long horizontal-whitespace runs (4+ spaces/tabs) — model emitted
  // padding. Newlines are legitimate in multi-paragraph rewrites, so
  // exclude \n from this check.
  if (/[ \t]{4,}/.test(repair)) return true;
  // Zero-width / hidden control chars
  if (/[\u200B-\u200F\uFEFF\u2028\u2029]/.test(repair)) return true;
  // Mid-sentence ellipsis-of-omission (3+ ASCII dots, OR any U+2026 …,
  // OR multiple U+2026 chars in sequence)
  if (/\.{3,}\s*\S/.test(repair)) return true;
  if (/…/.test(repair)) return true;
  // Repeated non-ASCII separator dashes (model uses ‑ ‑ ‑ between fragments)
  const dashes = repair.match(/[‑–—]/g) ?? [];
  if (dashes.length >= 3) return true;
  // Stray "END" tokens model sometimes emits when it loses structure
  if (/\?END\?|END\?\s*END|END\s+END/.test(repair)) return true;
  return false;
}

interface RunOutcome {
  pass: boolean;
  modelMs: number;     // total model latency for the pipeline (excl. judge)
  judgeMs: number;
  output: string;      // formatted per-case lines (printed by main after parallel workers finish)
}

async function runCaseRewrite(c: TransformCase): Promise<RunOutcome> {
  const r = await runRewrite(c.input);
  const judgeInput: JudgeInput = {
    input: c.input,
    expected: c.expected.finalText ?? null,
    alternates: c.expected.finalTextAlternates ?? [],
    actual: r.verdict === 'TRANSFORM' ? r.rewrite : null,
    actualBail: r.verdict === 'NONE',
    expectedBail: !!c.expected.shouldFailSoft,
  };
  const j = await judge(judgeInput);
  return printAndScore(c, j, [{ label: 'pass1', latencyMs: r.latencyMs }], {
    'VERDICT': r.verdict,
    'REWRITE': r.verdict === 'TRANSFORM' ? r.rewrite : '(bailed)',
  }, r.raw);
}

/**
 * "Easy" instructions don't typically benefit from VERIFY's consistency
 * checks — literal swaps ("change X to Y", "replace X with Y") have no
 * agreement/coverage subtleties to repair. Skipping VERIFY on these
 * saves ~300-500ms per case at no accuracy cost.
 */
function isEasyInstruction(instruction: string): boolean {
  const i = instruction.toLowerCase().trim();
  if (/^(change|replace|swap|rename)\s+\S+\s+(to|with|for)\s+\S+$/.test(i)) return true;
  return false;
}

// ============================================================================
// Skip-VERIFY rule variants for Experiment 4 — find the sweet spot
// between accuracy and latency
// ============================================================================

type SkipMode = 'never' | 'conservative' | 'current' | 'aggressive' | 'always';

function isSimpleLiteralSwap(instruction: string): boolean {
  return /^(change|replace|swap|rename)\s+\S+\s+(to|with|for)\s+\S+$/.test(instruction.toLowerCase().trim());
}

function isBrEAmE(instruction: string): boolean {
  return /^make\s+it\s+(british|american)\s+english$/.test(instruction.toLowerCase().trim());
}

function isCaseChange(instruction: string): boolean {
  return /^(uppercase|lowercase|capitalize|title.case)/.test(instruction.toLowerCase().trim());
}

function isSimpleTense(instruction: string): boolean {
  return /^make\s+(it\s+)?(past|present|future)\s+tense$/.test(instruction.toLowerCase().trim());
}

/**
 * Decide whether to skip VERIFY based on the chosen rule mode.
 * All modes (except 'never' and 'always') first require: no \n\n,
 * single-instruction (no `|`), and draft length within window of target.
 */
function shouldSkipByMode(
  mode: SkipMode,
  instruction: string,
  target: string,
  draft: string,
): boolean {
  if (mode === 'never') return false;
  // Common pre-filters — multi-paragraph and composed always need VERIFY
  if (target.includes('\n\n') || draft.includes('\n\n')) return false;
  if (instruction.includes('|')) return false;
  if (mode === 'always') return true;

  // Length sanity by mode
  const targetLen = target.length || 1;
  const ratio = draft.length / targetLen;

  if (mode === 'aggressive') {
    // Any single-instruction case with length ratio in 0.9-1.1
    return ratio >= 0.9 && ratio <= 1.1;
  }

  // 'conservative' and 'current' both require ±15% length
  if (ratio < 0.85 || ratio > 1.15) return false;

  if (mode === 'conservative') {
    // ONLY literal swaps + BrE/AmE — the truly mechanical edits
    return isSimpleLiteralSwap(instruction) || isBrEAmE(instruction);
  }

  // 'current' = what's deployed: literal + case + simple tense + BrE/AmE
  return isSimpleLiteralSwap(instruction) ||
         isCaseChange(instruction) ||
         isSimpleTense(instruction) ||
         isBrEAmE(instruction);
}

/**
 * VERIFY is suspected-useful when the rewrite either (a) involved a
 * composed instruction (pipe-joined), (b) spans paragraphs (\n\n), or
 * (c) the rewrite length deviates >25% from target (likely truncation /
 * overrun). This is the gate used by `fused-verify` to decide whether
 * to spend a second LLM call. Cheap heuristic — no LLM call.
 */
function shouldRunVerifyOnFused(instruction: string, target: string, rewrite: string): boolean {
  if (instruction.includes('|')) return true;
  if (target.includes('\n\n') || rewrite.includes('\n\n')) return true;
  const tLen = target.length || 1;
  const ratio = rewrite.length / tLen;
  if (ratio < 0.75 || ratio > 1.25) return true;
  return false;
}

async function runCaseFused(c: TransformCase, withVerify: boolean): Promise<RunOutcome> {
  const f = await runFused(c.input);

  if (f.verdict === 'NONE') {
    const judgeInput: JudgeInput = {
      input: c.input,
      expected: c.expected.finalText ?? null,
      alternates: c.expected.finalTextAlternates ?? [],
      actual: null,
      actualBail: true,
      expectedBail: !!c.expected.shouldFailSoft,
    };
    const j = await judge(judgeInput);
    return printAndScore(c, j, [{ label: 'fused', latencyMs: f.latencyMs }], {
      'VERDICT': 'NONE',
      'INSTRUCTION': '(none)',
      'TARGET': '(none)',
      'REWRITE': '(bailed)',
    }, f.raw);
  }

  let finalRewrite = f.rewrite;
  let verifyVerdict = '';
  let verifyMs = 0;
  let verifyRaw = '';

  if (withVerify && shouldRunVerifyOnFused(f.instruction, f.target, f.rewrite)) {
    const verifyInstruction = f.instruction.split('|').map(s => s.trim()).filter(Boolean).join(' and ');
    const ver = await runVerify(verifyInstruction, f.target, f.rewrite);
    if (ver.verdict === 'OK' || !ver.rewrite) {
      finalRewrite = f.rewrite;
    } else {
      const isBadRepair = repairLooksTruncated(ver.rewrite, f.rewrite, f.target)
        || repairLooksGarbled(ver.rewrite);
      finalRewrite = isBadRepair ? f.rewrite : ver.rewrite;
    }
    verifyVerdict = ver.verdict;
    verifyMs = ver.latencyMs;
    verifyRaw = ver.raw;
  }

  const judgeInput: JudgeInput = {
    input: c.input,
    expected: c.expected.finalText ?? null,
    alternates: c.expected.finalTextAlternates ?? [],
    actual: finalRewrite,
    actualBail: false,
    expectedBail: !!c.expected.shouldFailSoft,
  };
  const j = await judge(judgeInput);

  const steps = [{ label: 'fused', latencyMs: f.latencyMs }];
  if (withVerify && verifyMs > 0) steps.push({ label: 'verify', latencyMs: verifyMs });

  const fields: Record<string, string> = {
    'INSTRUCTION': f.instruction,
    'TARGET': f.target,
    'DRAFT': f.rewrite,
  };
  if (withVerify && verifyMs > 0) {
    fields['VERIFY'] = verifyVerdict;
    fields['REWRITE'] = finalRewrite;
  } else {
    fields['REWRITE'] = f.rewrite;
    delete fields['DRAFT'];
  }

  const rawForFail = withVerify && verifyMs > 0
    ? `${f.raw}\n---VERIFY---\n${verifyRaw}`
    : f.raw;
  return printAndScore(c, j, steps, fields, rawForFail);
}

async function runCaseFusedFull(c: TransformCase): Promise<RunOutcome> {
  const f = await runFusedFull(c.input);
  const judgeInput: JudgeInput = {
    input: c.input,
    expected: c.expected.finalText ?? null,
    alternates: c.expected.finalTextAlternates ?? [],
    actual: f.verdict === 'TRANSFORM' ? f.fullRewrite : null,
    actualBail: f.verdict === 'NONE',
    expectedBail: !!c.expected.shouldFailSoft,
  };
  const j = await judge(judgeInput);
  return printAndScore(c, j, [{ label: 'fused-full', latencyMs: f.latencyMs }], {
    'VERDICT': f.verdict,
    'INSTRUCTION': f.instruction || '(none)',
    'TARGET': f.target || '(none)',
    'FULL_REWRITE': f.verdict === 'TRANSFORM' ? f.fullRewrite : '(bailed)',
  }, f.raw);
}

async function runCaseSingleCall(c: TransformCase): Promise<RunOutcome> {
  const r = await runSingleCall(c.input);
  const judgeInput: JudgeInput = {
    input: c.input,
    expected: c.expected.finalText ?? null,
    alternates: c.expected.finalTextAlternates ?? [],
    actual: r.verdict === 'TRANSFORM' ? r.rewrite : null,
    actualBail: r.verdict === 'NONE',
    expectedBail: !!c.expected.shouldFailSoft,
  };
  const j = await judge(judgeInput);
  return printAndScore(c, j, [{ label: 'single', latencyMs: r.latencyMs }], {
    'VERDICT': r.verdict,
    'REWRITE': r.verdict === 'TRANSFORM' ? r.rewrite : '(bailed)',
  }, r.raw);
}

interface PromptOverrides {
  extract?: typeof runExtract;
  apply?: typeof runApply;
  verify?: typeof runVerify;
}

async function runCaseExtractApply(
  c: TransformCase,
  withVerify: boolean,
  skipEasy = false,
  prompts: PromptOverrides = {},
  skipMode: SkipMode = 'never',
): Promise<RunOutcome> {
  const extractFn = prompts.extract ?? runExtract;
  const applyFn = prompts.apply ?? runApply;
  const verifyFn = prompts.verify ?? runVerify;
  const ext = await extractFn(c.input);

  if (ext.verdict === 'NONE') {
    const judgeInput: JudgeInput = {
      input: c.input,
      expected: c.expected.finalText ?? null,
      alternates: c.expected.finalTextAlternates ?? [],
      actual: null,
      actualBail: true,
      expectedBail: !!c.expected.shouldFailSoft,
    };
    const j = await judge(judgeInput);
    return printAndScore(c, j, [{ label: 'extract', latencyMs: ext.latencyMs }], {
      'VERDICT': 'NONE',
      'INSTRUCTION': '(none)',
      'TARGET': '(none)',
    }, ext.raw);
  }

  // Composed instructions ("X | Y") run APPLY twice — output of first
  // feeds target of second. Single instructions take one APPLY call.
  const instructionParts = ext.instruction.split('|').map(s => s.trim()).filter(Boolean);
  let lastApplyRaw = '';
  let totalApplyMs = 0;
  let currentTarget = ext.target;
  let lastApplyRewrite = '';
  for (const inst of instructionParts) {
    const stepApp = await applyFn(inst, currentTarget);
    totalApplyMs += stepApp.latencyMs;
    lastApplyRaw = lastApplyRaw ? `${lastApplyRaw}\n---STEP---\n${stepApp.raw}` : stepApp.raw;
    lastApplyRewrite = stepApp.rewrite;
    if (!stepApp.rewrite) break;       // bail if any step returns empty
    currentTarget = stepApp.rewrite;   // chain output → next target
  }
  const app = { rewrite: lastApplyRewrite, raw: lastApplyRaw, latencyMs: totalApplyMs };

  let finalRewrite = app.rewrite;
  let verifyVerdict = '';
  let verifyMs = 0;
  let verifyRaw = '';

  // Skip-easy mode: literal swaps don't need consistency repair.
  const easySkipApplies = withVerify && skipEasy && instructionParts.length === 1
    && isEasyInstruction(instructionParts[0]);

  // Skip-mode (Experiment 4 — variant skip rules). Composed-instruction
  // case is already gated by shouldSkipByMode.
  const verifyInstructionForSkip = instructionParts.join(' and ');
  const modeSkipApplies = withVerify && skipMode !== 'never' &&
    shouldSkipByMode(skipMode, verifyInstructionForSkip, ext.target, app.rewrite);

  if (withVerify && !easySkipApplies && !modeSkipApplies) {
    // VERIFY sees the composed instruction in the original "X and Y" form
    // (not pipe-joined) and the ORIGINAL target — so it can check both
    // transforms were applied to the correct starting text.
    const verifyInstruction = instructionParts.join(' and ');
    const ver = await verifyFn(verifyInstruction, ext.target, app.rewrite);
    // OK = trust the draft (don't re-trust verify's echo, which sometimes
    // mangles good drafts). REPAIR = use verify's correction, BUT only if
    // the repair looks plausible. The model occasionally emits two kinds
    // of bad repair: TRUNCATED ("water" instead of full sentence) and
    // GARBLED (right length, but full of separator dashes, ellipsis-of-
    // omission, zero-width chars, or stray "END" markers). Both indicate
    // the model lost its place; in either case fall back to the draft.
    if (ver.verdict === 'OK' || !ver.rewrite) {
      finalRewrite = app.rewrite;
    } else {
      const isBadRepair = repairLooksTruncated(ver.rewrite, app.rewrite, ext.target)
        || repairLooksGarbled(ver.rewrite);
      finalRewrite = isBadRepair ? app.rewrite : ver.rewrite;
    }
    verifyVerdict = ver.verdict;
    verifyMs = ver.latencyMs;
    verifyRaw = ver.raw;
  }

  const judgeInput: JudgeInput = {
    input: c.input,
    expected: c.expected.finalText ?? null,
    alternates: c.expected.finalTextAlternates ?? [],
    actual: finalRewrite,
    actualBail: false,
    expectedBail: !!c.expected.shouldFailSoft,
  };
  const j = await judge(judgeInput);

  const steps = [
    { label: 'extract', latencyMs: ext.latencyMs },
    { label: 'apply', latencyMs: app.latencyMs },
  ];
  if (withVerify) steps.push({ label: 'verify', latencyMs: verifyMs });

  const fields: Record<string, string> = {
    'INSTRUCTION': ext.instruction,
    'TARGET': ext.target,
    'DRAFT': app.rewrite,
  };
  if (withVerify) {
    fields['VERIFY'] = verifyVerdict;
    fields['REWRITE'] = finalRewrite;
  } else {
    fields['REWRITE'] = app.rewrite;
    delete fields['DRAFT'];
  }

  const rawForFail = withVerify
    ? `${ext.raw}\n---APPLY---\n${app.raw}\n---VERIFY---\n${verifyRaw}`
    : `${ext.raw}\n---\n${app.raw}`;

  return printAndScore(c, j, steps, fields, rawForFail);
}

function printAndScore(
  c: TransformCase,
  j: { verdict: 'PASS' | 'FAIL'; rationale: string; latencyMs: number },
  steps: Array<{ label: string; latencyMs: number }>,
  fields: Record<string, string>,
  rawOnFail: string,
): RunOutcome {
  const pass = j.verdict === 'PASS';
  const tag = pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const cat = `${DIM}[${c.category}]${RESET}`;

  const expFull = c.expected.shouldFailSoft
    ? '(NONE — should bail)'
    : c.expected.finalTextAlternates?.length
      ? `${c.expected.finalText} ${DIM}(or: ${c.expected.finalTextAlternates.join(' | ')})${RESET}`
      : c.expected.finalText;

  // Buffer all output for this case into a string array so concurrent
  // workers don't interleave their lines. The caller decides when to
  // flush via console.log(lines.join('\n')).
  const lines: string[] = [];
  lines.push('─'.repeat(78));
  lines.push(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  lines.push(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  lines.push(`  ${DIM}EXPECTED:${RESET} ${expFull}`);
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`  ${DIM}${k.padEnd(8)}:${RESET} ${v}`);
  }
  lines.push(`  ${DIM}JUDGE   :${RESET} ${j.rationale}`);
  const stepStr = steps.map(s => `${s.label}=${s.latencyMs}ms`).join('  ');
  lines.push(`  ${DIM}TIMING  :${RESET} ${stepStr}  judge=${j.latencyMs}ms`);
  if (!pass) {
    lines.push(`  ${YELLOW}RAW     :${RESET} ${rawOnFail.replace(/\n/g, '\n           ')}`);
  }

  const modelMs = steps.reduce((a, s) => a + s.latencyMs, 0);
  return { pass, modelMs, judgeMs: j.latencyMs, output: lines.join('\n') };
}

function filterCases(cases: TransformCase[], filter: { caseId?: string; category?: string }): TransformCase[] {
  return cases.filter(c => {
    if (filter.caseId && c.id !== filter.caseId) return false;
    if (filter.category && c.category !== filter.category) return false;
    return true;
  });
}

async function main() {
  const args = parseArgs();
  const selected = filterCases(CASES, args);
  if (selected.length === 0) {
    console.error(`No cases matched filter ${JSON.stringify(args)}`);
    process.exit(2);
  }

  const modeLabel = args.mode === 'extract-apply-verify-skip-easy'
    ? 'EXTRACT → APPLY → VERIFY [skip-on-literal] (speed variant)'
    : args.mode === 'single-call'
      ? 'SINGLE-CALL (one prompt does extract+apply+verify)'
      : args.mode === 'fused'
        ? 'FUSED extract+apply (1 call, structured output)'
        : args.mode === 'fused-verify'
          ? 'FUSED extract+apply + conditional VERIFY (1-2 calls)'
          : args.mode === 'extract-apply-verify'
            ? 'EXTRACT → APPLY → VERIFY (3-pass pipeline)'
            : args.mode === 'extract-apply'
              ? 'EXTRACT → APPLY (2-pass pipeline)'
              : 'REWRITE (1-pass pipeline)';
  console.log(`${BOLD}transform-blank benchmark — ${modeLabel}${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Cases: ${selected.length}/${CASES.length}  (parallel=${args.parallel})`);
  console.log();

  const wallStart = Date.now();
  const outcomes = await runWithConcurrency(selected, async (c) => {
    if (args.mode === 'extract-apply') return runCaseExtractApply(c, false);
    if (args.mode === 'extract-apply-verify') return runCaseExtractApply(c, true);
    if (args.mode === 'extract-apply-verify-skip-easy') return runCaseExtractApply(c, true, /*skipEasy*/ true);
    if (args.mode === 'single-call') return runCaseSingleCall(c);
    if (args.mode === 'fused') return runCaseFused(c, false);
    if (args.mode === 'fused-verify') return runCaseFused(c, true);
    if (args.mode === 'fused-full') return runCaseFusedFull(c);
    if (args.mode === 'minimal-extract')
      return runCaseExtractApply(c, true, false, { extract: runMinimalExtract });
    if (args.mode === 'minimal-apply')
      return runCaseExtractApply(c, true, false, { apply: runMinimalApply });
    if (args.mode === 'minimal-verify')
      return runCaseExtractApply(c, true, false, { verify: runMinimalVerify });
    if (args.mode === 'minimal-all')
      return runCaseExtractApply(c, true, false, {
        extract: runMinimalExtract,
        apply: runMinimalApply,
        verify: runMinimalVerify,
      });
    // Skip-VERIFY rule variants (Experiment 4)
    if (args.mode === 'skip-never') return runCaseExtractApply(c, true, false, {}, 'never');
    if (args.mode === 'skip-conservative') return runCaseExtractApply(c, true, false, {}, 'conservative');
    if (args.mode === 'skip-current') return runCaseExtractApply(c, true, false, {}, 'current');
    if (args.mode === 'skip-aggressive') return runCaseExtractApply(c, true, false, {}, 'aggressive');
    if (args.mode === 'skip-always') return runCaseExtractApply(c, true, false, {}, 'always');
    return runCaseRewrite(c);
  }, args.parallel);
  const wallMs = Date.now() - wallStart;

  // Print all per-case output in original order (workers stored results
  // at their original index, so this reads sequentially even though the
  // actual API calls were interleaved across workers).
  for (const r of outcomes) console.log(r.output);

  let passed = 0;
  let totalModel = 0;
  let totalJudge = 0;
  const byCategory = new Map<string, { pass: number; total: number }>();
  for (let i = 0; i < outcomes.length; i++) {
    const r = outcomes[i];
    const c = selected[i];
    if (r.pass) passed++;
    totalModel += r.modelMs;
    totalJudge += r.judgeMs;
    const slot = byCategory.get(c.category) ?? { pass: 0, total: 0 };
    slot.total++;
    if (r.pass) slot.pass++;
    byCategory.set(c.category, slot);
  }

  const pct = (n: number, d: number) => d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
  const avg = (total: number) => (total / selected.length).toFixed(0);

  sep('═');
  for (const [cat, s] of byCategory) {
    console.log(`${BOLD}${cat.padEnd(20)}${RESET} ${s.pass}/${s.total} pass (${pct(s.pass, s.total)})`);
  }
  sep('─');
  console.log(`${BOLD}Total:${RESET}      ${passed}/${selected.length} pass (${pct(passed, selected.length)})`);
  console.log(`Avg model (per case): ${avg(totalModel)}ms  Avg judge: ${avg(totalJudge)}ms`);
  console.log(`${BOLD}Wall-clock total:${RESET} ${(wallMs / 1000).toFixed(1)}s  (parallel=${args.parallel}, ${selected.length} cases)`);
  console.log(`Throughput: ${(selected.length / (wallMs / 1000)).toFixed(2)} cases/sec`);

  process.exit(passed === selected.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
