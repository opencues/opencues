/**
 * Blank-sentinels matrix bench harness.
 *
 * Sweep dimensions:
 *   method (5) × count (5) × kind (3) × cases (variable per cell)
 *
 * Each cell builds a catalog, materializes templates against it, calls
 * the LLM once per case, and grades the output. Output is a per-cell
 * pass-rate table that surfaces:
 *
 *   - Does verbatim-fidelity degrade as catalog grows?
 *   - Does hallucination rate jump at a specific count threshold?
 *   - Do parameterised blank tokens (multi-segment names) cost
 *     reliability vs single-segment sentinels?
 *   - Does raw-inline / facts-only beat safe-tokens by enough to
 *     reconsider the privacy/reliability trade?
 *
 * The bench uses fluid-blank's provider router so OPENCUES_BENCH_PROVIDER
 * works the same way as the rest of the suite.
 *
 * Usage:
 *   npx tsx tests/benchmarks/blank-sentinels-matrix/run.ts
 *
 *   # restrict the sweep for fast iteration:
 *   npx tsx ... --method safe-tokens --count 16 --kind pure-sentinels
 *   npx tsx ... --parallel 8
 *   npx tsx ... --dry-run            # print the matrix, no LLM calls
 */

import { chat, sysUser, MODEL } from '../fluid-blank/groq';
import { buildCatalog, reorderForExpected, SUPPORTED_COUNTS, type CatalogKind, type MatrixToken, type SupportedCount, type OrderStrategy } from './tokens';
import { METHODS, type Method, buildSystemPrompt } from './methods';
import { materializeForCatalog, type MaterializedCase } from './cases';
import { grade, type Grade } from './grade';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

interface Args {
  method?: Method;
  count?: SupportedCount;
  kind?: CatalogKind;
  order: OrderStrategy;
  parallel: number;
  dryRun: boolean;
  jsonOut?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { parallel: 6, dryRun: false, order: 'natural' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--method')   out.method = argv[++i] as Method;
    else if (a === '--count') out.count = parseInt(argv[++i], 10) as SupportedCount;
    else if (a === '--kind')  out.kind = argv[++i] as CatalogKind;
    else if (a === '--order') out.order = argv[++i] as OrderStrategy;
    else if (a.startsWith('--parallel=')) out.parallel = parseInt(a.split('=')[1], 10);
    else if (a === '--parallel') out.parallel = parseInt(argv[++i], 10);
    else if (a === '--dry-run' || a === '--dry') out.dryRun = true;
    else if (a === '--json-out') out.jsonOut = argv[++i];
  }
  return out;
}

const KINDS: CatalogKind[] = ['pure-sentinels', 'pure-blank', 'mixed'];

interface CellResult {
  method: Method;
  count: SupportedCount;
  kind: CatalogKind;
  total: number;
  passed: number;
  axes: { correctToken: number; verbatim: number; hallucination: number; rawLeak: number };
  perCase: Array<{
    id: string;
    pipeline: string;
    pass: boolean;
    reasons: string[];
    latencyMs: number;
    output: string;
  }>;
}

async function runCase(
  c: MaterializedCase,
  catalog: MatrixToken[],
  method: Method,
  order: OrderStrategy,
  seed: number,
): Promise<{ grade: Grade; latencyMs: number; output: string }> {
  const expectedSet = new Set(c.expectTokens.map(t => t.token));
  const reorderedCatalog = reorderForExpected(catalog, expectedSet, order, seed);
  const system = buildSystemPrompt(reorderedCatalog, method);
  const userMsg = `INPUT: ${c.input}`;
  const res = await chat(sysUser(system, userMsg), { maxTokens: 512, temperature: 0 });
  // Extract ANSWER line. Tolerate missing prefix — some models drop it.
  let answer = res.text;
  const m = res.text.match(/ANSWER:\s*([\s\S]*?)$/);
  if (m) answer = m[1].trim();
  const g = grade(c, catalog, method, answer);
  return { grade: g, latencyMs: res.latencyMs, output: answer };
}

async function runWithLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

async function runCell(
  method: Method,
  count: SupportedCount,
  kind: CatalogKind,
  order: OrderStrategy,
  parallel: number,
  dryRun: boolean,
): Promise<CellResult> {
  const catalog = buildCatalog(kind, count);
  const cases = materializeForCatalog(catalog);
  const seed = count * 1000 + (kind === 'pure-sentinels' ? 1 : kind === 'pure-blank' ? 2 : 3);
  const result: CellResult = {
    method, count, kind,
    total: cases.length,
    passed: 0,
    axes: { correctToken: 0, verbatim: 0, hallucination: 0, rawLeak: 0 },
    perCase: [],
  };
  if (dryRun) {
    process.stdout.write(`${DIM}[dry] ${method} × ${count} × ${kind} (order=${order}): ${cases.length} cases${RESET}\n`);
    return result;
  }
  await runWithLimit(cases, parallel, async (c) => {
    try {
      const { grade: g, latencyMs, output } = await runCase(c, catalog, method, order, seed);
      if (g.pass) result.passed++;
      if (g.axes.correctToken) result.axes.correctToken++;
      if (g.axes.verbatim) result.axes.verbatim++;
      if (g.axes.hallucination) result.axes.hallucination++;
      if (g.axes.rawLeak) result.axes.rawLeak++;
      result.perCase.push({
        id: c.id,
        pipeline: c.pipeline,
        pass: g.pass,
        reasons: g.reasons,
        latencyMs,
        output,
      });
    } catch (err: any) {
      result.perCase.push({
        id: c.id,
        pipeline: c.pipeline,
        pass: false,
        reasons: [`exception: ${err?.message ?? String(err)}`],
        latencyMs: 0,
        output: '',
      });
    }
  });
  return result;
}

function pct(n: number, d: number): string {
  if (d === 0) return ' n/a ';
  const v = (n / d) * 100;
  return v.toFixed(1).padStart(5, ' ');
}

function colour(passRate: number): string {
  if (passRate >= 0.9) return GREEN;
  if (passRate >= 0.7) return YELLOW;
  return RED;
}

function renderTable(results: CellResult[]) {
  // One table per method. Rows = kind, columns = count.
  const byMethod = new Map<Method, CellResult[]>();
  for (const r of results) {
    if (!byMethod.has(r.method)) byMethod.set(r.method, []);
    byMethod.get(r.method)!.push(r);
  }
  for (const method of METHODS) {
    const rows = byMethod.get(method);
    if (!rows || rows.length === 0) continue;
    process.stdout.write(`\n${BOLD}${CYAN}═══ method: ${method} ═══${RESET}\n`);
    const counts = SUPPORTED_COUNTS;
    const header = `${'kind'.padEnd(16)} │ ` + counts.map(c => `n=${String(c).padStart(2)}`).join('  ') + '  │ axes';
    process.stdout.write(`${DIM}${header}${RESET}\n`);
    for (const kind of KINDS) {
      const cells = rows.filter(r => r.kind === kind);
      if (cells.length === 0) continue;
      let line = `${kind.padEnd(16)} │ `;
      for (const c of counts) {
        const cell = cells.find(x => x.count === c);
        if (!cell || cell.total === 0) { line += '   -   '; continue; }
        const rate = cell.passed / cell.total;
        line += `${colour(rate)}${pct(cell.passed, cell.total)}${RESET} `;
      }
      // Compact per-axis summary across all counts for this row
      const sum = cells.reduce(
        (acc, c) => ({
          total: acc.total + c.total,
          correctToken: acc.correctToken + c.axes.correctToken,
          verbatim: acc.verbatim + c.axes.verbatim,
          hallucination: acc.hallucination + c.axes.hallucination,
          rawLeak: acc.rawLeak + c.axes.rawLeak,
        }),
        { total: 0, correctToken: 0, verbatim: 0, hallucination: 0, rawLeak: 0 },
      );
      line += ` │ tok ${pct(sum.correctToken, sum.total)} · vbt ${pct(sum.verbatim, sum.total)} · halluc-clean ${pct(sum.hallucination, sum.total)} · leak-clean ${pct(sum.rawLeak, sum.total)}`;
      process.stdout.write(line + '\n');
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sweepMethods = args.method ? [args.method] : METHODS;
  const sweepCounts = args.count ? [args.count] : SUPPORTED_COUNTS;
  const sweepKinds = args.kind ? [args.kind] : KINDS;
  const totalCells = sweepMethods.length * sweepCounts.length * sweepKinds.length;
  process.stdout.write(`${BOLD}blank-sentinels matrix${RESET}\n`);
  process.stdout.write(`provider: ${process.env.OPENCUES_BENCH_PROVIDER ?? 'groq (default)'} · model: ${MODEL}\n`);
  process.stdout.write(`sweep:    ${sweepMethods.length} methods × ${sweepCounts.length} counts × ${sweepKinds.length} kinds = ${totalCells} cells\n`);
  process.stdout.write(`order:    ${args.order}\n`);
  process.stdout.write(`parallel: ${args.parallel}${args.dryRun ? '  (dry-run — no LLM calls)' : ''}\n\n`);
  const results: CellResult[] = [];
  let done = 0;
  for (const method of sweepMethods) {
    for (const kind of sweepKinds) {
      for (const count of sweepCounts) {
        done++;
        process.stdout.write(`${DIM}[${done}/${totalCells}] ${method} × ${count} × ${kind} (order=${args.order}) …${RESET}\r`);
        const r = await runCell(method, count, kind, args.order, args.parallel, args.dryRun);
        results.push(r);
      }
    }
  }
  process.stdout.write('\n');
  renderTable(results);
  if (args.jsonOut) {
    const fs = await import('node:fs');
    fs.writeFileSync(args.jsonOut, JSON.stringify(results, null, 2));
    process.stdout.write(`\n${DIM}json written to ${args.jsonOut}${RESET}\n`);
  }
}

main().catch(err => {
  process.stderr.write(`\n${RED}error: ${err?.stack ?? err}${RESET}\n`);
  process.exit(1);
});
