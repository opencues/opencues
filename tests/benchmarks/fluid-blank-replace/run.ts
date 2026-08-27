/**
 * fluid-blank-replace benchmark — REPLACE-detection accuracy.
 *
 * Drives the SHIPPING detector prompt + parser + verifier from
 * @opencues/core (replace-detect.ts) — no bench-local prompt copy, so
 * editing the prompt and re-running this bench is the whole loop.
 *
 * Measures whether the model detects when a `_` ask is replacement-
 * shaped (the answer should replace an exact existing substring of the
 * buffer) versus a plain fill versus a placeholder — AND whether the
 * detection survives the runtime's deterministic acceptance gate
 * (verifyReplaceDetect: verbatim substrings, target uniqueness,
 * command/target non-overlap). Latency is recorded but is not the
 * question here — accuracy first.
 *
 * Grading is fully deterministic (no LLM judge):
 *   CLASS    — exact match against the labeled class.
 *   VERIFIED — (replace cases) verifyReplaceDetect accepts the output;
 *              this is the REAL gate: only a verified detection ever
 *              splices in production.
 *   TARGET   — (replace cases) verified target equals the expected
 *              target (or an alternate).
 *   VALUE    — informational only.
 *
 * Usage:
 *   npx tsx tests/benchmarks/fluid-blank-replace/run.ts
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/fluid-blank-replace/run.ts
 *   ... --parallel 4 (default 4)
 */

import { CASES, ReplaceDetectCase } from './cases';
import {
  REPLACE_DETECT_SYSTEM_PROMPT,
  REPLACE_DETECT_MAX_TOKENS,
  parseReplaceDetect,
  verifyReplaceDetect,
  type VerifiedReplace,
} from '../../../packages/opencues-core/src/sources/replace-detect';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

interface CaseResult {
  c: ReplaceDetectCase;
  cls: string;
  verified: VerifiedReplace | null;
  latencyMs: number;
  clsOk: boolean;
  verifiedOk: boolean | null;  // null = n/a (non-replace case)
  targetOk: boolean | null;
  valueOk: boolean | null;
  raw: string;
  error?: string;
}

async function runCase(c: ReplaceDetectCase): Promise<CaseResult> {
  try {
    const r = await chat(sysUser(REPLACE_DETECT_SYSTEM_PROMPT, `INPUT: ${c.input}`), { maxTokens: REPLACE_DETECT_MAX_TOKENS });
    if (!r.text.trim()) throw new Error('empty response (rate-limit backoff?)');
    const det = parseReplaceDetect(r.text);
    // Boundary cases (category boundary/*): the ask must reach the fused
    // path — NONE, FILL, and a REPLACE the gate rejects are all correct;
    // only a VERIFIED REPLACE is the failure (it would under-apply the
    // edit). Non-boundary cases grade class exact-match as before.
    const isBoundary = c.category.startsWith('boundary/');
    const clsOk = isBoundary
      ? !(det.cls === 'replace' && verifyReplaceDetect(c.input, det) !== null)
      : det.cls === c.expected.cls;
    const verified = det.cls === 'replace' ? verifyReplaceDetect(c.input, det) : null;

    let verifiedOk: boolean | null = null;
    let targetOk: boolean | null = null;
    let valueOk: boolean | null = null;
    if (c.expected.cls === 'replace') {
      verifiedOk = verified !== null;
      const accepted = [c.expected.target!, ...(c.expected.targetAlternates ?? [])];
      targetOk = verified !== null && accepted.includes(verified.target);
      if (c.expected.values?.length) {
        const norm = (s: string) => s.trim().toLowerCase();
        valueOk = verified !== null && c.expected.values.some(v => norm(v) === norm(verified.value));
      }
    }

    return { c, cls: det.cls, verified, latencyMs: r.latencyMs, clsOk, verifiedOk, targetOk, valueOk, raw: r.text };
  } catch (e: any) {
    return {
      c, cls: '', verified: null, latencyMs: 0,
      clsOk: false,
      verifiedOk: c.expected.cls === 'replace' ? false : null,
      targetOk: c.expected.cls === 'replace' ? false : null,
      valueOk: null, raw: '', error: String(e?.message ?? e),
    };
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function pct(n: number, d: number) { return d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`; }

async function main() {
  const parallelArg = process.argv.indexOf('--parallel');
  const parallel = parallelArg >= 0 ? Number(process.argv[parallelArg + 1]) : 4;

  console.log(`fluid-blank-replace detection bench (shipping prompt) — model: ${MODEL}, cases: ${CASES.length}, parallel: ${parallel}\n`);

  const results = await mapWithConcurrency(CASES, parallel, runCase);

  const classes = ['fill', 'replace', 'none'] as const;
  const confusion = new Map<string, Map<string, number>>();
  for (const exp of classes) confusion.set(exp, new Map());
  for (const r of results) {
    const row = confusion.get(r.c.expected.cls)!;
    const got = r.error ? 'ERROR' : (classes as readonly string[]).includes(r.cls) ? r.cls : `other(${r.cls || '∅'})`;
    row.set(got, (row.get(got) ?? 0) + 1);
  }

  console.log('CONFUSION (expected → got):');
  for (const exp of classes) {
    const row = confusion.get(exp)!;
    const parts = [...row.entries()].map(([k, v]) => `${k}=${v}`).join('  ');
    console.log(`  ${exp.padEnd(8)} ${parts}`);
  }

  const total = results.length;
  const clsCorrect = results.filter(r => r.clsOk).length;
  const boundary = results.filter(r => r.c.category.startsWith('boundary/'));
  const boundaryFPs = boundary.filter(r => !r.clsOk || r.error);
  const repl = results.filter(r => r.c.expected.cls === 'replace');
  const replVerified = repl.filter(r => r.verifiedOk === true);
  const replTargetOk = repl.filter(r => r.targetOk === true);
  const replValueGraded = repl.filter(r => r.valueOk !== null);
  const replValueOk = repl.filter(r => r.valueOk === true);
  const fills = results.filter(r => r.c.expected.cls === 'fill');
  // The safety metric. (In production a class FP would additionally
  // have to survive verifyReplaceDetect before touching the buffer, so
  // this counts the WORST case.)
  const fillFalseReplace = fills.filter(r => r.cls === 'replace');
  const latencies = results.filter(r => !r.error).map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;

  console.log('\nHEADLINE:');
  console.log(`  class accuracy (all)              ${clsCorrect}/${total}  ${pct(clsCorrect, total)}`);
  console.log(`  replace recall (class)            ${repl.filter(r => r.clsOk).length}/${repl.length}  ${pct(repl.filter(r => r.clsOk).length, repl.length)}`);
  console.log(`  replace VERIFIED (runtime gate)   ${replVerified.length}/${repl.length}  ${pct(replVerified.length, repl.length)}`);
  console.log(`  fill→replace class FPs            ${fillFalseReplace.length}/${fills.length}  ${pct(fillFalseReplace.length, fills.length)}  (the safety metric)`);
  console.log(`  boundary verified-splice FPs      ${boundaryFPs.length}/${boundary.length}  ${pct(boundaryFPs.length, boundary.length)}  (transform-vs-replace boundary — the under-application metric)`);
  console.log(`  target correct (incl alt)         ${replTargetOk.length}/${repl.length}  ${pct(replTargetOk.length, repl.length)}`);
  console.log(`  value correct (informational)     ${replValueOk.length}/${replValueGraded.length}  ${pct(replValueOk.length, replValueGraded.length)}`);
  console.log(`  p50 latency                       ${p50}ms`);

  const failures = results.filter(r =>
    r.error || !r.clsOk || (r.c.expected.cls === 'replace' && (r.verifiedOk === false || r.targetOk === false)));
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const r of failures) {
      console.log(`  [${r.c.id}] ${r.c.input}`);
      if (r.error) { console.log(`      ERROR: ${r.error}`); continue; }
      console.log(`      expected ${r.c.expected.cls}${r.c.expected.target ? ` target="${r.c.expected.target}"` : ''}`);
      const got = r.verified
        ? `replace VERIFIED target="${r.verified.target}" value="${r.verified.value}" instruction="${r.verified.instruction}"`
        : `${r.cls || '∅'}${r.cls === 'replace' ? ' (verification REJECTED)' : ''}`;
      console.log(`      got      ${got}`);
      if (!r.clsOk || (r.cls === 'replace' && !r.verified)) console.log(`      raw      ${r.raw.slice(0, 300).replace(/\n/g, ' | ')}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
