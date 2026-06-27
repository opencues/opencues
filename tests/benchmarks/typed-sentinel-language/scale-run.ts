/**
 * Scale probe — does the bare → parameterized accuracy gap hold at
 * production-scale catalog (50 entries vs the 16 of pass-1)?
 *
 * Uses the existing 34-case suite from `cases.ts` against the LARGE
 * catalog at `catalog-large.ts`. Reuses run.ts's grader by importing
 * scoreCase. Compares against the original (16-entry) catalog
 * baseline by re-running it side-by-side.
 *
 * Selection accuracy is the axis most likely to drop with catalog
 * scale: more entries → more chances to mis-pick. Param fill should
 * be unchanged (catalog signature per entry is unchanged).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CATALOG } from './catalog';
import { LARGE_CATALOG } from './catalog-large';
import { CASES } from './cases';
import { LANGUAGES, type LanguageId } from './languages';
import { pickProvider, type ProviderId } from './providers';
import { buildSystemPrompt, buildUserMessage } from './prompt';
import { scoreCase, summarize } from './score';

function parseArgs(argv: string[]) {
  const out = { provider: 'cerebras' as ProviderId, languages: ['bare', 'parameterized'] as LanguageId[], parallel: 8 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] as ProviderId;
    else if (a === '--language') out.languages = [argv[++i] as LanguageId];
    else if (a === '--parallel') out.parallel = parseInt(argv[++i]!, 10);
  }
  return out;
}

async function runCell(provider: ReturnType<typeof pickProvider>, lang: LanguageId, catalog: typeof CATALOG, parallel: number) {
  const language = LANGUAGES[lang];
  const system = buildSystemPrompt(catalog, language);
  const results: Array<{ score: ReturnType<typeof scoreCase>; raw: any }> = new Array(CASES.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= CASES.length) return;
      const c = CASES[idx]!;
      const messages = provider.sysUser(system, buildUserMessage(c.prompt));
      try {
        const out = await provider.chat(messages, { temperature: 0, seed: 42, maxTokens: 512 });
        const parsed = language.parseSentinels(out.text, catalog);
        results[idx] = { score: scoreCase(c, parsed), raw: out };
      } catch (err) {
        const empty = language.parseSentinels('', catalog);
        results[idx] = { score: scoreCase(c, empty), raw: { error: String(err) } };
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return summarize(results.map(r => r.score));
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nScale probe — small (${CATALOG.length}) vs large (${LARGE_CATALOG.length}) catalog`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})`);
  console.log(`Languages: ${args.languages.join(', ')}\n`);

  const runId = `scale-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });

  const cells: Array<{ lang: LanguageId; size: 'small' | 'large'; summary: any }> = [];
  for (const lang of args.languages) {
    for (const [label, catalog] of [['small', CATALOG], ['large', LARGE_CATALOG]] as const) {
      process.stdout.write(`  ${lang.padEnd(15)} ${label.padEnd(6)} `);
      const t0 = Date.now();
      const sum = await runCell(provider, lang, catalog, args.parallel);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      cells.push({ lang, size: label, summary: sum });
      console.log(`done (${dt}s, overall=${pct(sum.overall)})`);
    }
  }

  console.log('');
  console.log('Language        │ Size  │ Overall │ Sel     │ Param   │ Format  │ Halluc  │ Card');
  console.log('────────────────┼───────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────');
  for (const c of cells) {
    const s = c.summary;
    console.log(`${c.lang.padEnd(15)} │ ${c.size.padEnd(5)} │ ${pct(s.overall).padStart(7)} │ ${pct(s.selection).padStart(7)} │ ${pct(s.parameters).padStart(7)} │ ${pct(s.format).padStart(7)} │ ${pct(s.hallucination).padStart(7)} │ ${pct(s.cardinality).padStart(7)}`);
  }
  console.log('');

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    smallSize: CATALOG.length,
    largeSize: LARGE_CATALOG.length,
    cells: cells.map(c => ({
      language: c.lang,
      size: c.size,
      overall: c.summary.overall,
      selection: c.summary.selection,
      parameters: c.summary.parameters,
      format: c.summary.format,
      hallucination: c.summary.hallucination,
      cardinality: c.summary.cardinality,
    })),
  }, null, 2));
  console.log(`Summary: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
