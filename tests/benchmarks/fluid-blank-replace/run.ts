/**
 * fluid-blank-replace benchmark — REPLACE-detection accuracy.
 *
 * Measures whether a model can detect when a `_` ask is replacement-shaped
 * (the answer should replace an exact existing substring of the buffer)
 * versus a plain fill versus a placeholder. Latency is recorded but is
 * NOT the question here — accuracy first.
 *
 * Grading is fully deterministic (no LLM judge):
 *   CLASS  — exact match against the labeled class.
 *   TARGET — (replace cases) must be an exact contiguous substring of the
 *            input AND equal the expected target (or an alternate).
 *   VALUE  — informational only; case-insensitive membership in the
 *            expected values list when one is declared.
 *
 * Usage:
 *   npx tsx tests/benchmarks/fluid-blank-replace/run.ts
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/fluid-blank-replace/run.ts
 *   ... --parallel 4 (default 4)
 */

import { CASES, ReplaceDetectCase } from './cases';
import { DETECT_SYSTEM_PROMPT } from './prompt';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

interface CaseResult {
  c: ReplaceDetectCase;
  cls: string;
  target: string;
  value: string;
  latencyMs: number;
  clsOk: boolean;
  targetOk: boolean | null;   // null = n/a (non-replace case)
  targetSubstring: boolean | null;
  valueOk: boolean | null;
  raw: string;
  error?: string;
}

function parseOutput(text: string): { cls: string; target: string; value: string } {
  const grab = (label: string) => {
    const m = text.match(new RegExp(`^${label}:\\s*(.*)$`, 'mi'));
    return m ? m[1].trim() : '';
  };
  return { cls: grab('CLASS').toLowerCase(), target: grab('TARGET'), value: grab('VALUE') };
}

async function runCase(c: ReplaceDetectCase): Promise<CaseResult> {
  try {
    const r = await chat(sysUser(DETECT_SYSTEM_PROMPT, `INPUT: ${c.input}`), { maxTokens: 900 });
    const { cls, target, value } = parseOutput(r.text);
    const clsOk = cls === c.expected.cls;

    let targetOk: boolean | null = null;
    let targetSubstring: boolean | null = null;
    if (c.expected.cls === 'replace') {
      targetSubstring = target !== '' && target.toUpperCase() !== 'NONE' && c.input.includes(target);
      const accepted = [c.expected.target!, ...(c.expected.targetAlternates ?? [])];
      targetOk = targetSubstring && accepted.includes(target);
    }

    let valueOk: boolean | null = null;
    if (c.expected.cls === 'replace' && c.expected.values?.length) {
      const norm = (s: string) => s.trim().toLowerCase();
      valueOk = c.expected.values.some(v => norm(v) === norm(value));
    }

    return { c, cls, target, value, latencyMs: r.latencyMs, clsOk, targetOk, targetSubstring, valueOk, raw: r.text };
  } catch (e: any) {
    return {
      c, cls: '', target: '', value: '', latencyMs: 0,
      clsOk: false, targetOk: c.expected.cls === 'replace' ? false : null,
      targetSubstring: null, valueOk: null, raw: '', error: String(e?.message ?? e),
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

  console.log(`fluid-blank-replace detection bench — model: ${MODEL}, cases: ${CASES.length}, parallel: ${parallel}\n`);

  const results = await mapWithConcurrency(CASES, parallel, runCase);

  // Per-class confusion counts
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
  const repl = results.filter(r => r.c.expected.cls === 'replace');
  const replDetected = repl.filter(r => r.clsOk);
  const replTargetSub = repl.filter(r => r.targetSubstring === true);
  const replTargetOk = repl.filter(r => r.targetOk === true);
  const replValueGraded = repl.filter(r => r.valueOk !== null);
  const replValueOk = repl.filter(r => r.valueOk === true);
  const fills = results.filter(r => r.c.expected.cls === 'fill');
  const fillFalseReplace = fills.filter(r => r.cls === 'replace');
  const latencies = results.filter(r => !r.error).map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;

  console.log('\nHEADLINE:');
  console.log(`  class accuracy (all)            ${clsCorrect}/${total}  ${pct(clsCorrect, total)}`);
  console.log(`  replace recall                  ${replDetected.length}/${repl.length}  ${pct(replDetected.length, repl.length)}`);
  console.log(`  fill→replace false positives    ${fillFalseReplace.length}/${fills.length}  ${pct(fillFalseReplace.length, fills.length)}  (the safety metric)`);
  console.log(`  target is exact substring       ${replTargetSub.length}/${repl.length}  ${pct(replTargetSub.length, repl.length)}`);
  console.log(`  target correct (incl alt)       ${replTargetOk.length}/${repl.length}  ${pct(replTargetOk.length, repl.length)}`);
  console.log(`  value correct (informational)   ${replValueOk.length}/${replValueGraded.length}  ${pct(replValueOk.length, replValueGraded.length)}`);
  console.log(`  p50 latency                     ${p50}ms`);

  const failures = results.filter(r =>
    r.error || !r.clsOk || (r.c.expected.cls === 'replace' && r.targetOk === false));
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const r of failures) {
      console.log(`  [${r.c.id}] ${r.c.input}`);
      if (r.error) { console.log(`      ERROR: ${r.error}`); continue; }
      console.log(`      expected ${r.c.expected.cls}${r.c.expected.target ? ` target="${r.c.expected.target}"` : ''}`);
      console.log(`      got      ${r.cls || '∅'}${r.target && r.target.toUpperCase() !== 'NONE' ? ` target="${r.target}"` : ''}${r.value ? ` value="${r.value}"` : ''}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
