/**
 * Bench runner.
 *
 *   npx tsx tests/benchmarks/typed-sentinel-language/run.ts \
 *     --provider cerebras --language bare --parallel 8
 *
 * Defaults: provider=cerebras, language=bare, parallel=8, --all-languages on.
 *
 * Output: pretty per-language summary table + per-case audit log written
 * to `tests/results/typed-sentinel-language/<run-id>/<language>.log`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CATALOG } from './catalog';
import { CASES, type Case } from './cases';
import { LANGUAGES, LANGUAGE_IDS, type Language, type LanguageId } from './languages';
import { pickProvider, type ProviderId } from './providers';
import { buildSystemPrompt, buildUserMessage } from './prompt';
import { scoreCase, summarize, type SuiteSummary } from './score';

function parseArgs(argv: string[]) {
  const out = { provider: 'cerebras' as ProviderId, languages: [...LANGUAGE_IDS] as LanguageId[], parallel: 8, only: undefined as string | undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] as ProviderId;
    else if (a === '--language') out.languages = [argv[++i] as LanguageId];
    else if (a === '--parallel') out.parallel = parseInt(argv[++i]!, 10);
    else if (a === '--only') out.only = argv[++i];
    else if (a?.startsWith('--')) console.error(`unknown flag: ${a}`);
  }
  return out;
}

async function runOneCell(provider: ReturnType<typeof pickProvider>, language: Language, cases: ReadonlyArray<Case>, parallel: number): Promise<SuiteSummary> {
  const system = buildSystemPrompt(CATALOG, language);
  const results: any[] = [];
  let i = 0;
  async function worker() {
    while (true) {
      const myIdx = i++;
      if (myIdx >= cases.length) return;
      const c = cases[myIdx]!;
      const messages = provider.sysUser(system, buildUserMessage(c.prompt));
      let out: { text: string; latencyMs: number };
      try {
        out = await provider.chat(messages, { temperature: 0, seed: 42, maxTokens: 512 });
      } catch (err) {
        results[myIdx] = { case: c, output: '', error: String(err), latencyMs: 0 };
        continue;
      }
      results[myIdx] = { case: c, output: out.text, latencyMs: out.latencyMs };
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()));

  const scores = results.map((r) => {
    const parsed = language.parseSentinels(r.output, CATALOG);
    return scoreCase(r.case, parsed);
  });
  const summary = summarize(scores);
  // Attach raw outputs for the audit log.
  (summary as any).raw = results.map((r, idx) => ({
    case: r.case,
    output: r.output,
    latencyMs: r.latencyMs,
    error: r.error,
    score: scores[idx],
  }));
  return summary;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function renderSuiteRow(lang: LanguageId, s: SuiteSummary): string {
  const cells = [
    lang.padEnd(15),
    pct(s.overall).padStart(7),
    pct(s.selection).padStart(7),
    pct(s.parameters).padStart(7),
    pct(s.format).padStart(7),
    pct(s.hallucination).padStart(7),
    pct(s.cardinality).padStart(7),
  ];
  return cells.join(' │ ');
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nProvider: ${provider.id} (${provider.modelLabel})`);
  console.log(`Cases:    ${CASES.length}`);
  console.log(`Languages: ${args.languages.join(', ')}\n`);

  // Output dir
  const runId = `${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Audit logs → ${outDir}\n`);

  const filteredCases = args.only ? CASES.filter(c => c.category === args.only || c.id === args.only) : CASES;

  const summaries: Record<LanguageId, SuiteSummary> = {} as any;
  for (const langId of args.languages) {
    const lang = LANGUAGES[langId];
    process.stdout.write(`  ${langId.padEnd(15)} `);
    const t0 = Date.now();
    const summary = await runOneCell(provider, lang, filteredCases, args.parallel);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    summaries[langId] = summary;
    console.log(`done (${dt}s, overall=${pct(summary.overall)})`);
    // Write audit log
    const auditPath = path.join(outDir, `${langId}.log`);
    const lines: string[] = [];
    lines.push(`# ${langId} × ${provider.id} (${provider.modelLabel})`);
    lines.push(`# Overall: ${pct(summary.overall)}`);
    lines.push(``);
    for (const r of (summary as any).raw) {
      lines.push(`── ${r.case.id} [${r.case.category}] ──`);
      lines.push(`PROMPT: ${r.case.prompt}`);
      lines.push(`OUTPUT: ${r.output}`);
      lines.push(`PARSED: ${JSON.stringify(r.score.parsed)}`);
      lines.push(`SCORE:  sel=${r.score.selection} par=${r.score.parameters} fmt=${r.score.format} hal=${r.score.hallucination} card=${r.score.cardinality} overall=${pct(r.score.overall)}`);
      if (r.score.notes.length > 0) lines.push(`NOTES:  ${r.score.notes.join('; ')}`);
      if (r.error) lines.push(`ERROR:  ${r.error}`);
      lines.push(`LAT:    ${r.latencyMs}ms`);
      lines.push(``);
    }
    fs.writeFileSync(auditPath, lines.join('\n'));
  }

  // Summary table
  console.log('');
  console.log('Language        │ Overall │ Sel     │ Param   │ Format  │ Halluc  │ Card');
  console.log('────────────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────');
  for (const langId of args.languages) {
    console.log(renderSuiteRow(langId, summaries[langId]));
  }
  console.log('');

  // Per-category breakdown
  const categories = ['scalar', 'param-single', 'param-multi', 'array', 'field-select', 'composition', 'unsupported'];
  console.log('Per-category overall (0-1):');
  console.log('Language        │ ' + categories.map(c => c.padEnd(13)).join(' │ '));
  console.log('────────────────┼─' + categories.map(() => '─'.repeat(13)).join('─┼─'));
  for (const langId of args.languages) {
    const s = summaries[langId];
    const row = categories.map(c => (s.byCategory[c] !== undefined ? pct(s.byCategory[c]!) : '   -   ').padEnd(13));
    console.log(`${langId.padEnd(15)} │ ${row.join(' │ ')}`);
  }
  console.log('');

  // Write summary.json for cross-run diffing
  const summaryOut = path.join(outDir, 'summary.json');
  fs.writeFileSync(summaryOut, JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    languages: args.languages,
    summaries: Object.fromEntries(args.languages.map(l => [l, {
      overall: summaries[l].overall,
      selection: summaries[l].selection,
      parameters: summaries[l].parameters,
      format: summaries[l].format,
      hallucination: summaries[l].hallucination,
      cardinality: summaries[l].cardinality,
      byCategory: summaries[l].byCategory,
    }])),
  }, null, 2));
  console.log(`Summary written: ${summaryOut}`);
}

main().catch(err => { console.error(err); process.exit(1); });
