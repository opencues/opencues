/**
 * Ambient-context bench runner.
 *
 * Drives each prompt variant through the synthetic cases. Each call
 * is a single LLM hop (no P1 segmentation needed — we provide SPAN
 * directly). Judge is pinned to Groq gpt-oss-120b (same as the rest
 * of the fluid-blank harness) so cross-variant comparisons are
 * apples-to-apples.
 *
 * Usage:
 *   GROQ_API_KEY=... CEREBRAS_API_KEY=... \
 *     npx tsx tests/benchmarks/fluid-blank-ambient/run.ts \
 *       [--variant A_baseline|B_strong|...] [--klass ambient-helps|...]
 *
 * Provider: same OPENCUES_BENCH_PROVIDER switch as the rest of the
 * benchmarks (default groq). Set OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss
 * for the speed-king path that this benchmark was originally designed
 * around.
 */

import { CASES, AmbientCase } from './cases';
import { HOLDOUT_CASES } from './cases-holdout';
import { VARIANTS } from './prompts';
import { chat, sysUser, type ChatMessage, MODEL } from '../fluid-blank/groq';
import { judgeAnswer } from '../fluid-blank/judge-answer';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

type VariantKey = keyof typeof VARIANTS;

interface Args {
  variant?: VariantKey;
  klass?: AmbientCase['klass'];
  parallel: number;
  holdout: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = { parallel: 4, holdout: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--variant') out.variant = a[++i] as VariantKey;
    else if (a[i] === '--klass') out.klass = a[++i] as AmbientCase['klass'];
    else if (a[i] === '--parallel') out.parallel = parseInt(a[++i], 10) || 4;
    else if (a[i] === '--holdout') out.holdout = true;
  }
  return out;
}

async function runWithConcurrency<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, conc: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

function parseAnswer(raw: string): string {
  const m = raw.match(/ANSWER:\s*([\s\S]*?)\s*$/i);
  return m ? m[1].trim() : raw.trim();
}

interface Outcome {
  caseId: string;
  klass: AmbientCase['klass'];
  variant: VariantKey;
  pass: boolean;
  actual: string;
  expected: string;
  alternates: string[];
  latencyMs: number;
  judgeMs: number;
  judgeRationale: string;
}

async function runOne(c: AmbientCase, variantKey: VariantKey): Promise<Outcome> {
  const v = VARIANTS[variantKey];
  const system = typeof v.system === 'function' ? v.system(c.ambient) : v.system;

  let messages: ChatMessage[];
  if ('twoMessage' in v && v.twoMessage) {
    // Variant C: send ambient as a separate user turn BEFORE the SPAN.
    const blockOnly = (() => {
      const fakeUser = v.user(c.span, c.context, c.ambient);
      void fakeUser;
      // Build the block as a standalone message via renderAmbient.
      // Imported lazily to avoid a top-level cycle.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { renderAmbient } = require('./prompts');
      const r = renderAmbient(c.ambient);
      return r.startsWith('\n\n') ? r.slice(2) : r;
    })();
    messages = [
      { role: 'system', content: system },
      ...(blockOnly ? [{ role: 'user' as const, content: blockOnly }] : []),
      { role: 'user', content: `SPAN: ${c.span}\nCONTEXT: ${c.context || 'none'}` },
    ];
  } else {
    messages = sysUser(system, v.user(c.span, c.context, c.ambient));
  }

  const t0 = Date.now();
  const r = await chat(messages, { maxTokens: 200, temperature: 0, seed: 42 });
  const latencyMs = Date.now() - t0;
  const actual = parseAnswer(r.text);

  const j = await judgeAnswer({
    question: c.span,
    expectedAnswer: c.expected.answer,
    expectedAlternates: c.expected.alternates,
    actualAnswer: actual,
  });

  return {
    caseId: c.id,
    klass: c.klass,
    variant: variantKey,
    pass: j.verdict === 'PASS',
    actual,
    expected: c.expected.answer,
    alternates: c.expected.alternates ?? [],
    latencyMs,
    judgeMs: j.latencyMs,
    judgeRationale: j.rationale,
  };
}

async function main() {
  const args = parseArgs();
  const variants = args.variant ? [args.variant] : (Object.keys(VARIANTS) as VariantKey[]);
  const allCases = args.holdout ? HOLDOUT_CASES : CASES;
  const cases = args.klass ? allCases.filter(c => c.klass === args.klass) : allCases;

  console.log(`${BOLD}fluid-blank ambient-context bench${RESET}`);
  console.log(`Inference model: ${MODEL}  (set OPENCUES_BENCH_PROVIDER to swap)`);
  console.log(`Judge: pinned Groq gpt-oss-120b`);
  console.log(`Variants: ${variants.join(', ')}`);
  console.log(`Cases: ${cases.length}/${CASES.length}  parallel=${args.parallel}\n`);

  const allOutcomes: Outcome[] = [];
  const wall0 = Date.now();

  for (const variantKey of variants) {
    console.log(`${BOLD}── Variant ${variantKey} ──${RESET}`);
    const tStart = Date.now();
    const outcomes = await runWithConcurrency(cases, c => runOne(c, variantKey), args.parallel);
    const tEnd = Date.now();

    for (const o of outcomes) {
      const tag = o.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      const cat = `${DIM}[${o.klass}]${RESET}`;
      const exp = o.alternates.length
        ? `${o.expected} ${DIM}(or: ${o.alternates.join(' | ')})${RESET}`
        : o.expected;
      console.log(`  ${tag}  ${BOLD}${o.caseId.padEnd(30)}${RESET}  ${cat}  ${DIM}${o.latencyMs}ms${RESET}`);
      console.log(`    ${DIM}expected:${RESET} ${exp}`);
      console.log(`    ${DIM}actual  :${RESET} ${o.actual}`);
      if (!o.pass) console.log(`    ${YELLOW}judge   :${RESET} ${o.judgeRationale}`);
    }
    allOutcomes.push(...outcomes);

    const passed = outcomes.filter(o => o.pass).length;
    const avgMs = Math.round(outcomes.reduce((a, o) => a + o.latencyMs, 0) / outcomes.length);
    console.log(`  ${BOLD}${variantKey}:${RESET} ${passed}/${outcomes.length} pass (${((passed / outcomes.length) * 100).toFixed(1)}%)  avg ${avgMs}ms  wall ${((tEnd - tStart) / 1000).toFixed(1)}s\n`);
  }

  const wallMs = Date.now() - wall0;

  // ── Summary matrix ──────────────────────────────────────────────────
  console.log(`${BOLD}═══ SUMMARY ═══${RESET}`);
  const klasses: AmbientCase['klass'][] = ['ambient-helps', 'ambient-neutral', 'ambient-anti'];
  const header = ['variant', ...klasses, 'total', 'avg ms'].map(s => s.padEnd(18)).join('');
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const variantKey of variants) {
    const row = [variantKey.padEnd(18)];
    let tot = 0; let totN = 0;
    let latSum = 0;
    for (const k of klasses) {
      const subset = allOutcomes.filter(o => o.variant === variantKey && o.klass === k);
      if (subset.length === 0) { row.push(`-`.padEnd(18)); continue; }
      const p = subset.filter(o => o.pass).length;
      row.push(`${p}/${subset.length} (${((p / subset.length) * 100).toFixed(0)}%)`.padEnd(18));
      tot += p; totN += subset.length;
    }
    const variantAll = allOutcomes.filter(o => o.variant === variantKey);
    latSum = variantAll.reduce((a, o) => a + o.latencyMs, 0);
    row.push(`${tot}/${totN} (${totN ? ((tot / totN) * 100).toFixed(0) : 0}%)`.padEnd(18));
    row.push(`${variantAll.length ? Math.round(latSum / variantAll.length) : 0}ms`.padEnd(18));
    console.log(row.join(''));
  }
  console.log(`\nWall-clock total: ${(wallMs / 1000).toFixed(1)}s  (${args.parallel} parallel, ${variants.length} variants × ${cases.length} cases = ${variants.length * cases.length} calls)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
