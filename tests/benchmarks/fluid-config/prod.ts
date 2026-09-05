/**
 * fluid-config PRODUCTION-prompt benchmark.
 *
 * Unlike fused.ts (which drives the bench's own settings-only 3-line
 * prompt), this runner drives the PRODUCTION `SYSTEM_PROMPT` +
 * `parseConfigIntentOutput` from @opencues/core — the exact strings and
 * parser the runtime dispatches. Any edit to the production prompt
 * (e.g. the July 2026 ACTION intent for undo/redo) is certified HERE:
 * run a same-session baseline first (phantom-regression discipline —
 * see feedback_bench_rate_limit_phantom_regression), judge the DELTA.
 *
 * Suites:
 *   --suite settings   the standard CASES (settings precision/recall)
 *   --suite undo       cases-undo.ts (ACTION classification, multilingual)
 *   --suite all        both (default)
 *   --holdout          swap settings suite for CASES_HOLDOUT
 *   --parallel N       worker pool (keep ≤4 — rate-limit bails read as
 *                      phantom regressions)
 *   --prompt-module P  dynamic-import an alternative module exporting
 *                      SYSTEM_PROMPT (baseline comparison: `git show
 *                      origin/master:...config-intent-source.ts` into
 *                      packages/opencues-core/src/sources/config-intent-source.baseline.ts
 *                      so its relative imports resolve, then pass that path)
 *
 * Usage:
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss CEREBRAS_API_KEY=... \
 *     npx tsx tests/benchmarks/fluid-config/prod.ts --suite all --parallel 4
 */

import { CASES, type FluidConfigCase } from './cases';
import { CASES_HOLDOUT } from './cases-holdout';
import { UNDO_CASES, type UndoActionCase } from './cases-undo';
import { judge, type Verdict } from './judge';
import type { FusedConfigResult } from './fused';
import { chat, sysUser, MODEL } from './groq';
import {
  SYSTEM_PROMPT as PROD_SYSTEM_PROMPT,
  parseConfigIntentOutput,
  validateAgainstRegistry,
  type ConfigIntentVerdict,
  matchDeterministicAction,
} from '../../../packages/opencues-core/src/sources/config-intent-source';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

interface Args {
  suite: 'settings' | 'undo' | 'all';
  holdout: boolean;
  parallel: number;
  promptModule?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { suite: 'all', holdout: false, parallel: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite') out.suite = args[++i] as Args['suite'];
    else if (args[i] === '--holdout') out.holdout = true;
    else if (args[i] === '--prompt-module') out.promptModule = args[++i];
    else if (args[i] === '--parallel') out.parallel = Math.max(1, parseInt(args[++i], 10) || 1);
  }
  return out;
}

async function classify(systemPrompt: string, input: string): Promise<{ verdict: ConfigIntentVerdict; raw: string; latencyMs: number }> {
  // Mirror the runtime: the deterministic undo/redo string matcher runs
  // BEFORE any LLM call (`tips-mode off redo _` never reaches the model).
  const det = matchDeterministicAction(input.replace(/_\s*$/, ''));
  if (det) return { verdict: { kind: 'action', action: det.action, count: det.count, confidence: 1 }, raw: '(deterministic)', latencyMs: 0 };
  const r = await chat(sysUser(systemPrompt, `INPUT: ${input}`), { maxTokens: 512 } /* the runtime floors gpt-oss at 2048 (reasoning + answer); 128 truncated ~5% of verdicts mid-line in the Sep 2026 sweep */);
  let verdict = parseConfigIntentOutput(r.text);
  // Mirror the runtime's defence-in-depth: an invalid verdict cedes.
  if (verdict.kind !== 'none' && !validateAgainstRegistry(verdict).ok) {
    verdict = { kind: 'none', confidence: null };
  }
  return { verdict, raw: r.text, latencyMs: r.latencyMs };
}

/** Map the production verdict onto the shape the deterministic settings
 *  judge understands. Provider verdicts map to the scalar they write;
 *  action verdicts map to a synthetic setting so they grade as FP /
 *  WRONG_SETTING on settings cases (they should never fire there). */
function toFusedShape(verdict: ConfigIntentVerdict, raw: string, latencyMs: number): FusedConfigResult {
  switch (verdict.kind) {
    case 'setting':  return { setting: verdict.setting, value: verdict.value, confidence: verdict.confidence, raw, latencyMs };
    case 'provider': return { setting: `${verdict.scope}-llm-provider`, value: verdict.provider, confidence: verdict.confidence, raw, latencyMs };
    case 'action':   return { setting: `(action:${verdict.action})`, value: String(verdict.count), confidence: verdict.confidence, raw, latencyMs };
    case 'none':     return { setting: null, value: null, confidence: verdict.confidence, raw, latencyMs };
  }
}

interface Outcome { id: string; suite: 'settings' | 'undo'; verdict: Verdict; pass: boolean; latencyMs: number }

function judgeUndo(c: UndoActionCase, verdict: ConfigIntentVerdict): { verdict: Verdict; pass: boolean; rationale: string } {
  const isReject = c.expected.action === null;
  if (isReject) {
    if (verdict.kind === 'none') return { verdict: 'TN', pass: true, rationale: 'correctly rejected' };
    return { verdict: 'FP', pass: false, rationale: `false-positive: classified as ${verdict.kind}` };
  }
  if (verdict.kind === 'none') return { verdict: 'FN', pass: false, rationale: `false-negative: expected ${c.expected.action}` };
  if (verdict.kind !== 'action') return { verdict: 'WRONG_SETTING', pass: false, rationale: `expected action, got ${verdict.kind}` };
  if (verdict.action !== c.expected.action) return { verdict: 'WRONG_SETTING', pass: false, rationale: `wrong action: got ${verdict.action}` };
  if ((c.expected.count ?? 1) !== verdict.count) return { verdict: 'WRONG_VALUE', pass: false, rationale: `wrong count: got ${verdict.count}, expected ${c.expected.count ?? 1}` };
  return { verdict: 'TP', pass: true, rationale: 'correct action + count' };
}

async function main(): Promise<void> {
  const args = parseArgs();
  let systemPrompt = PROD_SYSTEM_PROMPT;
  if (args.promptModule) {
    const mod = await import(args.promptModule) as { SYSTEM_PROMPT: string };
    systemPrompt = mod.SYSTEM_PROMPT;
    console.log(`${BOLD}BASELINE prompt loaded from ${args.promptModule}${RESET}`);
  }

  const settingsCases: FluidConfigCase[] = args.suite === 'undo' ? [] : (args.holdout ? CASES_HOLDOUT : CASES);
  const undoCases: UndoActionCase[] = args.suite === 'settings' ? [] : UNDO_CASES;

  console.log(`${BOLD}fluid-config PRODUCTION-prompt benchmark${RESET}`);
  console.log(`Model: ${MODEL}   Suite: ${args.suite}${args.holdout ? ' (holdout)' : ''}   Cases: ${settingsCases.length} settings + ${undoCases.length} undo`);
  console.log();

  type Job = { kind: 'settings'; c: FluidConfigCase } | { kind: 'undo'; c: UndoActionCase };
  const jobs: Job[] = [
    ...settingsCases.map(c => ({ kind: 'settings' as const, c })),
    ...undoCases.map(c => ({ kind: 'undo' as const, c })),
  ];
  const outcomes: Outcome[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(args.parallel, jobs.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      const { verdict, raw, latencyMs } = await classify(systemPrompt, job.c.input);
      let v: Verdict; let pass: boolean; let rationale: string;
      if (job.kind === 'settings') {
        const j = judge(job.c, toFusedShape(verdict, raw, latencyMs));
        v = j.verdict; pass = j.pass; rationale = j.rationale;
      } else {
        const j = judgeUndo(job.c, verdict);
        v = j.verdict; pass = j.pass; rationale = j.rationale;
      }
      const tag = pass ? `${GREEN}${v}${RESET}` : `${RED}${v}${RESET}`;
      console.log(`${tag}  ${BOLD}${job.c.id}${RESET}  ${DIM}${job.c.input}${RESET}  ${pass ? '' : `— ${rationale}`}`);
      if (!pass) console.log(`      ${DIM}RAW: ${raw.replace(/\n/g, ' / ').slice(0, 160)}${RESET}`);
      outcomes[i] = { id: job.c.id, suite: job.kind, verdict: v, pass, latencyMs };
    }
  });
  await Promise.all(workers);

  const summarize = (suite: 'settings' | 'undo'): void => {
    const rows = outcomes.filter(o => o.suite === suite);
    if (rows.length === 0) return;
    const counts: Record<Verdict, number> = { TP: 0, WRONG_SETTING: 0, WRONG_VALUE: 0, FN: 0, TN: 0, FP: 0 };
    for (const r of rows) counts[r.verdict]++;
    const hits = counts.TP + counts.WRONG_SETTING + counts.WRONG_VALUE + counts.FN;
    const rejects = counts.TN + counts.FP;
    const pct = (n: number, d: number) => d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
    console.log();
    console.log(`${BOLD}[${suite}]${RESET} precision ${counts.TN}/${rejects} = ${pct(counts.TN, rejects)}   recall ${counts.TP}/${hits} = ${pct(counts.TP, hits)}   pass ${counts.TP + counts.TN}/${rows.length}`);
    const fails = rows.filter(r => !r.pass);
    if (fails.length > 0) console.log(`  fails: ${fails.map(f => `${f.id}(${f.verdict})`).join(', ')}`);
  };
  summarize('settings');
  summarize('undo');

  const allPass = outcomes.every(o => o.pass);
  const settingsRows = outcomes.filter(o => o.suite === 'settings');
  const settingsRejects = settingsRows.filter(o => o.verdict === 'TN' || o.verdict === 'FP');
  const settingsPrecisionOk = settingsRejects.length === 0
    || settingsRejects.filter(o => o.verdict === 'TN').length / settingsRejects.length >= 0.98;
  process.exit(allPass || settingsPrecisionOk ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
