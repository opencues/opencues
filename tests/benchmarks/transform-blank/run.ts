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
import { judge, JudgeInput } from './judge';
import { MODEL } from './groq';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

type Mode = 'rewrite' | 'extract-apply' | 'extract-apply-verify';
const VALID_MODES: Mode[] = ['rewrite', 'extract-apply', 'extract-apply-verify'];

interface Args {
  mode: Mode;
  caseId?: string;
  category?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { mode: 'rewrite' };
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
  }
  return out;
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
  // Long whitespace runs (4+) — model emitted padding instead of words
  if (/\s{4,}/.test(repair)) return true;
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

async function runCaseExtractApply(c: TransformCase, withVerify: boolean): Promise<RunOutcome> {
  const ext = await runExtract(c.input);

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
    const stepApp = await runApply(inst, currentTarget);
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

  if (withVerify) {
    // VERIFY sees the composed instruction in the original "X and Y" form
    // (not pipe-joined) and the ORIGINAL target — so it can check both
    // transforms were applied to the correct starting text.
    const verifyInstruction = instructionParts.join(' and ');
    const ver = await runVerify(verifyInstruction, ext.target, app.rewrite);
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

  sep();
  console.log(`${BOLD}${c.id}${RESET}  ${cat}  ${tag}`);
  console.log(`  ${DIM}INPUT   :${RESET} ${c.input}`);
  console.log(`  ${DIM}EXPECTED:${RESET} ${expFull}`);
  for (const [k, v] of Object.entries(fields)) {
    console.log(`  ${DIM}${k.padEnd(8)}:${RESET} ${v}`);
  }
  console.log(`  ${DIM}JUDGE   :${RESET} ${j.rationale}`);
  const stepStr = steps.map(s => `${s.label}=${s.latencyMs}ms`).join('  ');
  console.log(`  ${DIM}TIMING  :${RESET} ${stepStr}  judge=${j.latencyMs}ms`);
  if (!pass) {
    console.log(`  ${YELLOW}RAW     :${RESET} ${rawOnFail.replace(/\n/g, '\n           ')}`);
  }

  const modelMs = steps.reduce((a, s) => a + s.latencyMs, 0);
  return { pass, modelMs, judgeMs: j.latencyMs };
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

  const modeLabel = args.mode === 'extract-apply-verify'
    ? 'EXTRACT → APPLY → VERIFY (3-pass pipeline)'
    : args.mode === 'extract-apply'
      ? 'EXTRACT → APPLY (2-pass pipeline)'
      : 'REWRITE (1-pass pipeline)';
  console.log(`${BOLD}transform-blank benchmark — ${modeLabel}${RESET}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Cases: ${selected.length}/${CASES.length}`);
  console.log();

  let passed = 0;
  let totalModel = 0;
  let totalJudge = 0;
  const byCategory = new Map<string, { pass: number; total: number }>();

  for (const c of selected) {
    const r = args.mode === 'extract-apply' ? await runCaseExtractApply(c, false)
      : args.mode === 'extract-apply-verify' ? await runCaseExtractApply(c, true)
      : await runCaseRewrite(c);
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
    console.log(`${BOLD}${cat.padEnd(12)}${RESET} ${s.pass}/${s.total} pass (${pct(s.pass, s.total)})`);
  }
  sep('─');
  console.log(`${BOLD}Total:${RESET}      ${passed}/${selected.length} pass (${pct(passed, selected.length)})`);
  console.log(`Avg model: ${avg(totalModel)}ms  Avg judge: ${avg(totalJudge)}ms  Avg total: ${avg(totalModel + totalJudge)}ms`);

  process.exit(passed === selected.length ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
