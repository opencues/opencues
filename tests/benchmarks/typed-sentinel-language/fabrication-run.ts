/**
 * Fabrication probe runner.
 *
 *   npx tsx tests/benchmarks/typed-sentinel-language/fabrication-run.ts \
 *     --provider cerebras --parallel 8
 *
 * Differences from `run.ts`:
 *
 *  1. Uses the STRIPPED catalog (no params on parameterized entries).
 *  2. New grader axes specific to this probe:
 *
 *       fabricated-param-count — # of (key=value) pairs emitted on
 *                                entries whose catalog signature has
 *                                no params. (LOWER is better.)
 *       wrong-param-key-count  — # of keys emitted that aren't in the
 *                                entry's catalog signature. (LOWER.)
 *       respects-catalog       — binary 0/1: model emitted no
 *                                fabricated params for this case.
 *
 *  3. Only fires the cases where fabrication is at risk (param-single,
 *     param-multi, array). Identity scalars and unsupported skipped
 *     since they have no fabrication surface.
 *
 * Output: per-language per-case table flagging exactly which fabricated
 * params landed. Also writes summary.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { STRIPPED_CATALOG } from './catalog-stripped';
import { CASES } from './cases';
import { LANGUAGES, LANGUAGE_IDS, type Language, type LanguageId, type ParsedSentinel } from './languages';
import { pickProvider, type ProviderId } from './providers';
import { buildSystemPrompt, buildUserMessage } from './prompt';

interface FabricationScore {
  caseId: string;
  category: string;
  prompt: string;
  output: string;
  parsed: ParsedSentinel[];
  fabricatedParams: Array<{ token: string; param: string; value: string; }>;
  wrongKeyParams: Array<{ token: string; param: string; value: string; }>;
  respectsCatalog: 0 | 1;
  emittedAnything: 0 | 1;
  /** Did the model emit any sentinel that was IN the stripped catalog,
   *  even if it omitted params it would've passed? Used to distinguish
   *  "respected catalog and emitted the no-param version" from "bailed
   *  entirely". */
  emittedValidNoParam: 0 | 1;
}

function fabricationCheck(
  parsed: ParsedSentinel[],
  catalog: typeof STRIPPED_CATALOG,
): { fabricated: FabricationScore['fabricatedParams']; wrongKey: FabricationScore['wrongKeyParams'] } {
  const fabricated: FabricationScore['fabricatedParams'] = [];
  const wrongKey: FabricationScore['wrongKeyParams'] = [];
  for (const p of parsed) {
    if (p.id === null) continue;
    const entry = catalog.find(e => e.id === p.id);
    if (!entry) continue;
    const allowedKeys = (entry.params ?? []).map(x => x.name);
    for (const [k, v] of Object.entries(p.params)) {
      if (allowedKeys.length === 0) {
        fabricated.push({ token: p.raw, param: k, value: v });
      } else if (!allowedKeys.includes(k)) {
        wrongKey.push({ token: p.raw, param: k, value: v });
      }
    }
  }
  return { fabricated, wrongKey };
}

async function runCell(provider: ReturnType<typeof pickProvider>, language: Language, parallel: number): Promise<FabricationScore[]> {
  const system = buildSystemPrompt(STRIPPED_CATALOG, language);
  // Probe runs ALL cases — including identity scalars and unsupported
  // — because fabrication could show up anywhere. (e.g. model could
  // emit `[EMAIL(limit=5)]` for "show me 5 emails" if it doesn't
  // respect the catalog.)
  const cases = CASES;
  const results: FabricationScore[] = new Array(cases.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= cases.length) return;
      const c = cases[idx]!;
      const messages = provider.sysUser(system, buildUserMessage(c.prompt));
      let out: { text: string; latencyMs: number };
      try {
        out = await provider.chat(messages, { temperature: 0, seed: 42, maxTokens: 512 });
      } catch (err) {
        results[idx] = {
          caseId: c.id, category: c.category, prompt: c.prompt, output: `<error: ${String(err)}>`,
          parsed: [], fabricatedParams: [], wrongKeyParams: [], respectsCatalog: 1,
          emittedAnything: 0, emittedValidNoParam: 0,
        };
        continue;
      }
      const parsed = language.parseSentinels(out.text, STRIPPED_CATALOG);
      const fab = fabricationCheck(parsed, STRIPPED_CATALOG);
      const respectsCatalog: 0 | 1 = fab.fabricated.length + fab.wrongKey.length === 0 ? 1 : 0;
      const emittedAnything: 0 | 1 = parsed.some(p => p.id !== null) ? 1 : 0;
      const emittedValidNoParam: 0 | 1 = parsed.some(p => p.id !== null && Object.keys(p.params).length === 0) ? 1 : 0;
      results[idx] = {
        caseId: c.id, category: c.category, prompt: c.prompt, output: out.text,
        parsed, fabricatedParams: fab.fabricated, wrongKeyParams: fab.wrongKey,
        respectsCatalog, emittedAnything, emittedValidNoParam,
      };
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return results;
}

function parseArgs(argv: string[]) {
  const out = { provider: 'cerebras' as ProviderId, languages: [...LANGUAGE_IDS] as LanguageId[], parallel: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] as ProviderId;
    else if (a === '--language') out.languages = [argv[++i] as LanguageId];
    else if (a === '--parallel') out.parallel = parseInt(argv[++i]!, 10);
  }
  return out;
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nFabrication probe — STRIPPED catalog`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})`);
  console.log(`Languages: ${args.languages.join(', ')}\n`);

  const runId = `fabrication-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Audit logs → ${outDir}\n`);

  type Summary = {
    n: number;
    fabricatedCases: number;
    fabricatedParams: number;
    respectsCatalog: number;
    emittedAnything: number;
    emittedValidNoParam: number;
  };
  const summaries: Record<LanguageId, Summary> = {} as any;
  const audits: Record<LanguageId, FabricationScore[]> = {} as any;
  for (const langId of args.languages) {
    const lang = LANGUAGES[langId];
    process.stdout.write(`  ${langId.padEnd(15)} `);
    const t0 = Date.now();
    const scores = await runCell(provider, lang, args.parallel);
    audits[langId] = scores;
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const s: Summary = {
      n: scores.length,
      fabricatedCases: scores.filter(r => r.respectsCatalog === 0).length,
      fabricatedParams: scores.reduce((sum, r) => sum + r.fabricatedParams.length + r.wrongKeyParams.length, 0),
      respectsCatalog: scores.reduce((sum, r) => sum + r.respectsCatalog, 0) / scores.length,
      emittedAnything: scores.reduce((sum, r) => sum + r.emittedAnything, 0) / scores.length,
      emittedValidNoParam: scores.reduce((sum, r) => sum + r.emittedValidNoParam, 0) / scores.length,
    };
    summaries[langId] = s;
    console.log(`done (${dt}s, ${s.fabricatedCases}/${s.n} cases with fabricated params)`);

    // Audit log
    const lines: string[] = [];
    lines.push(`# ${langId} × ${provider.id} (${provider.modelLabel}) — STRIPPED catalog`);
    lines.push(`# Total: ${s.n} cases  Fabricated: ${s.fabricatedCases}  RespectsCatalog: ${pct(s.respectsCatalog)}`);
    lines.push('');
    for (const r of scores) {
      lines.push(`── ${r.caseId} [${r.category}] ──`);
      lines.push(`PROMPT: ${r.prompt}`);
      lines.push(`OUTPUT: ${r.output}`);
      lines.push(`PARSED: ${JSON.stringify(r.parsed)}`);
      if (r.fabricatedParams.length > 0) {
        lines.push(`FABRICATED: ${r.fabricatedParams.map(f => `${f.token} (${f.param}=${f.value})`).join('; ')}`);
      }
      if (r.wrongKeyParams.length > 0) {
        lines.push(`WRONG-KEY: ${r.wrongKeyParams.map(f => `${f.token} (${f.param}=${f.value})`).join('; ')}`);
      }
      lines.push(`FLAGS: respectsCatalog=${r.respectsCatalog} emittedAnything=${r.emittedAnything} emittedValidNoParam=${r.emittedValidNoParam}`);
      lines.push('');
    }
    fs.writeFileSync(path.join(outDir, `${langId}.log`), lines.join('\n'));
  }

  console.log('');
  console.log('Language        │ N  │ Fabricated │ Respects │ EmittedAny │ NoParamEmit');
  console.log('────────────────┼────┼────────────┼──────────┼────────────┼────────────');
  for (const lang of args.languages) {
    const s = summaries[lang]!;
    console.log(`${lang.padEnd(15)} │ ${String(s.n).padStart(2)} │ ${String(s.fabricatedCases).padStart(3)}/${String(s.n).padStart(2)} (${pct(s.fabricatedCases/s.n).padStart(5)}) │ ${pct(s.respectsCatalog).padStart(7)} │ ${pct(s.emittedAnything).padStart(8)} │ ${pct(s.emittedValidNoParam).padStart(8)}`);
  }
  console.log('');

  // Per-category fabrication
  const cats = ['scalar', 'param-single', 'param-multi', 'array', 'field-select', 'composition', 'unsupported'];
  console.log('Fabrication count by category (lower is better):');
  console.log('Language        │ ' + cats.map(c => c.padEnd(13)).join(' │ '));
  console.log('────────────────┼─' + cats.map(() => '─'.repeat(13)).join('─┼─'));
  for (const lang of args.languages) {
    const counts: Record<string, number> = {};
    for (const cat of cats) counts[cat] = audits[lang].filter(r => r.category === cat).reduce((sum, r) => sum + r.fabricatedParams.length + r.wrongKeyParams.length, 0);
    const row = cats.map(c => String(counts[c]).padEnd(13));
    console.log(`${lang.padEnd(15)} │ ${row.join(' │ ')}`);
  }
  console.log('');

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    languages: args.languages,
    summaries,
  }, null, 2));
  console.log(`Summary written: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
