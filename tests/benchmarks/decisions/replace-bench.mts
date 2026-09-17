// Step 7A bench — replace-detect as CANDIDATE SELECTION on Jev vs today's chat
// detector, on the fluid-blank-replace suite (67 cases: 28 replace, 23 fill,
// 16 none), same session.
//
//   CHAT   today: REPLACE_DETECT_SYSTEM_PROMPT on cerebras, parsed by the
//          source's own parser; CLASS + TARGET scored against the labels
//   JEV    core's replaceDecisionRequest: a `kind` Choice (fill / replace /
//          none, with examples), a `target` Choice over candidates the runtime
//          cut (every word and 2-gram of the input, ≤ 200, minus `_`) and a
//          `command` Choice over the imperative phrases that end at the `_`.
//          The model never emits a string: the target and the command are
//          candidates we offered.
//
// Divert rule swept: REPLACE when kind = replace at ≥ N and target confidence ≥ C
// (the shipped rule is core's decideReplace: kind ≥ 0.5, target ≥ 0.4, then the
// fused-diff check in the source — see transform-blank/prod.ts --replace-parse decisions); scored
// as class accuracy per label, target right (against `target` +
// `targetAlternates`), and — the number that matters for a splice — fill/none
// cases wrongly diverted (a false REPLACE edits text that was fine).
//
// Run: TYPESAFE_API_KEY=… CEREBRAS_API_KEY=… npx tsx tests/benchmarks/decisions/replace-bench.mts [--arm chat|jev|both|e2e]
import path from 'node:path';
import url from 'node:url';
import { CASES } from '../fluid-blank-replace/cases';

const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const rd = await import(path.join(R, 'packages/opencues-core/dist/sources/replace-detect.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const argv = process.argv.slice(2);
const ARM = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1] : 'both';
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });
const CEREBRAS = process.env.CEREBRAS_API_KEY, TYPESAFE = process.env.TYPESAFE_API_KEY;
if (!CEREBRAS || !TYPESAFE) { console.error('CEREBRAS_API_KEY and TYPESAFE_API_KEY are required'); process.exit(2); }
const decisions = new core.TypeSafeDecisionProvider({ apiKey: TYPESAFE, httpAdapter: http });

const usage: Record<string, any> = {};
let arm: string | null = null;
core.registerUsageSink((u: any) => {
  if (!arm) return;
  const k = `${arm}|${u.providerId}/${u.model}`;
  const row = usage[k] ?? (usage[k] = { arm, providerId: u.providerId, model: u.model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
  row.calls++; row.promptTokens += u.promptTokens; row.cachedTokens += u.cachedTokens; row.completionTokens += u.completionTokens;
});
const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round(100 * a / b) : 0}%)`;
const strip = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const targetOk = (c: typeof CASES[number], got: string) => {
  const want = [c.expected.target, ...(c.expected.targetAlternates ?? [])].filter(Boolean) as string[];
  return want.some((w) => got === w || strip(got) === strip(w));
};

// ── the shipped request (core's replace-decide.ts) ────────────────────────
const replaceCandidates = core.replaceCandidates as (input: string) => { targets: string[]; commands: string[] };
const replaceRequest = core.replaceDecisionRequest as (input: string) => { state: unknown; questions: unknown; targets: string[]; commands: string[] };

async function runJev() {
  arm = 'JEV';
  const rows: Array<{ c: typeof CASES[number]; kind: string; kindConf: number; noul: number; tConf: number; target: string; tChoice: string; cChoice: string; command: string; ms: number }> = [];
  for (const c of CASES) {
    const req = replaceRequest(c.input);
    const t0 = Date.now();
    let res: any;
    try { res = await core.dispatchDecision(decisions, { state: req.state, questions: req.questions }, { leg: 'replace' }); } catch (e) { console.log(`  ERROR ${c.id}: ${(e as Error).message}`); continue; }
    const a = res.answers;
    const tIdx = Number(String(a.target.choice).slice(1)) - 1; const cIdx = Number(String(a.command.choice).slice(1)) - 1;
    rows.push({ c, kind: a.kind.choice, kindConf: a.kind.confidence, noul: 0, tConf: a.target.confidence, tChoice: a.target.choice, target: a.target.choice === 'none' ? '' : (req.targets[tIdx] ?? ''), cChoice: a.command.choice, command: a.command.choice === 'none' ? '' : (req.commands[cIdx] ?? ''), ms: Date.now() - t0 });
  }
  arm = null;
  const u = Object.values(usage).find((x: any) => x.arm === 'JEV') as any;
  const price = u ? core.priceFor(u.providerId, u.model) : null; const cost = u && price ? core.estimateRowCostUSD(u, price) / u.calls : 0;
  console.log(`\nJEV (candidate selection)  (${rows.length} cases) · mean ${mean(rows.map((r) => r.ms))} ms · $${cost.toFixed(6)} per call · ${u ? Math.round(u.promptTokens / u.calls) : 0} in`);
  // raw signal
  const byCls = (cls: string) => rows.filter((r) => r.c.expected.cls === cls);
  for (const cls of ['replace', 'fill', 'none']) {
    const g = byCls(cls);
    console.log(`  ${cls.padEnd(8)} kind Choice right ${pct(g.filter((r) => r.kind === cls).length, g.length)} · conf mean ${(g.reduce((s, r) => s + r.kindConf, 0) / g.length).toFixed(2)}${g.filter((r) => r.kind !== cls).length ? ' · wrong: ' + g.filter((r) => r.kind !== cls).map((r) => `${r.c.id}→${r.kind} ${r.kindConf.toFixed(2)}`).join(', ') : ''}`);
  }
  const rep = byCls('replace');
  console.log(`  replace: target right ${pct(rep.filter((r) => targetOk(r.c, r.target)).length, rep.length)} · target conf mean ${(rep.reduce((s, r) => s + r.tConf, 0) / rep.length).toFixed(2)} min ${Math.min(...rep.map((r) => r.tConf)).toFixed(2)} · command ends at _ and excludes target ${pct(rep.filter((r) => r.command && r.c.input.includes(r.command.replace(/ _$/, '')) && !(r.target && r.command.includes(r.target))).length, rep.length)}`);
  for (const r of rep.filter((r) => !(r.command && r.c.input.includes(r.command.replace(/ _$/, '')) && !(r.target && r.command.includes(r.target))))) console.log(`    command odd [${r.c.id}] «${r.command || r.cChoice}»`);
  for (const r of rep.filter((r) => !targetOk(r.c, r.target))) console.log(`    target miss [${r.c.id}] got «${r.target || r.tChoice}» want «${r.c.expected.target}» (noul ${r.noul.toFixed(2)}, conf ${r.tConf.toFixed(2)})`);
  if (argv.includes('--verbose')) for (const r of rows) console.log(`    [${r.c.id.padEnd(16)}] want ${r.c.expected.cls.padEnd(7)} kind ${r.kind.padEnd(7)} ${r.kindConf.toFixed(2)} · target «${r.target || r.tChoice}» ${r.tConf.toFixed(2)} · cmd «${r.command || r.cChoice}»  «${r.c.input.slice(0, 60)}»`);
  // divert rule sweep
  console.log('  divert rule (REPLACE when kind = replace at conf ≥ N and target conf ≥ C):');
  for (const [N, C] of [[0.5, 0.3], [0.5, 0.4], [0.5, 0.5], [0.5, 0.6], [0.5, 0.8], [0.7, 0.5]]) {
    const div = (r: typeof rows[number]) => r.kind === 'replace' && r.kindConf >= N && r.tConf >= C && r.tChoice !== 'none';
    const tp = rep.filter((r) => div(r) && targetOk(r.c, r.target)).length;
    const wrongTarget = rep.filter((r) => div(r) && !targetOk(r.c, r.target)).length;
    const fp = rows.filter((r) => r.c.expected.cls !== 'replace' && div(r));
    console.log(`    N=${N} C=${C}: diverted right ${pct(tp, rep.length)} · diverted on a wrong target ${wrongTarget} · FALSE diverts (fill/none) ${fp.length}${fp.length ? ': ' + fp.map((r) => `${r.c.id}→«${r.target}»`).join(', ') : ''}`);
  }
}

async function runChat() {
  arm = 'CHAT';
  const provider = core.getProvider('cerebras');
  const rows: Array<{ c: typeof CASES[number]; det: any; ms: number }> = [];
  for (const c of CASES) {
    const t0 = Date.now();
    try {
      const raw = await core.dispatchChat(provider, http, { model: 'gpt-oss-120b', messages: [{ role: 'system', content: rd.REPLACE_DETECT_SYSTEM_PROMPT }, { role: 'user', content: `INPUT: ${c.input}` }], maxTokens: rd.REPLACE_DETECT_MAX_TOKENS, temperature: 0, seed: 42 }, { apiKey: CEREBRAS });
      rows.push({ c, det: rd.parseReplaceDetect(raw), ms: Date.now() - t0 });
    } catch (e) { console.log(`  ERROR ${c.id}: ${(e as Error).message}`); }
  }
  arm = null;
  const u = Object.values(usage).find((x: any) => x.arm === 'CHAT') as any;
  const price = u ? core.priceFor(u.providerId, u.model) : null; const cost = u && price ? core.estimateRowCostUSD(u, price) / u.calls : 0;
  console.log(`\nCHAT (today's detector)  (${rows.length} cases) · mean ${mean(rows.map((r) => r.ms))} ms · $${cost.toFixed(6)} per call · ${u ? Math.round(u.promptTokens / u.calls) : 0} in / ${u ? Math.round(u.completionTokens / u.calls) : 0} out`);
  for (const cls of ['replace', 'fill', 'none']) {
    const g = rows.filter((r) => r.c.expected.cls === cls);
    console.log(`  ${cls.padEnd(8)} class right ${pct(g.filter((r) => r.det.cls === cls).length, g.length)}`);
  }
  const rep = rows.filter((r) => r.c.expected.cls === 'replace');
  const verified = rep.filter((r) => rd.verifyReplaceDetect(r.c.input, r.det));
  console.log(`  replace: target right ${pct(rep.filter((r) => r.det.cls === 'replace' && targetOk(r.c, r.det.target)).length, rep.length)} · verified (would divert) ${pct(verified.length, rep.length)} · FALSE diverts (fill/none verified) ${rows.filter((r) => r.c.expected.cls !== 'replace' && rd.verifyReplaceDetect(r.c.input, r.det)).length}`);
}

// ── end to end: the REAL TransformBlankSource, fused on cerebras + the decision detector ──
async function runE2E() {
  arm = 'E2E';
  const src = new core.TransformBlankSource({ httpAdapter: http, provider: core.getProvider('cerebras'), endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: CEREBRAS, model: 'gpt-oss-120b', replaceParse: true, decisions });
  const rows: Array<{ c: typeof CASES[number]; mode: string; target?: string; value?: string; ms: number }> = [];
  for (const c of CASES) {
    const words = c.input.split(/\s+/).filter(Boolean);
    const t0 = Date.now();
    let r: any = null;
    try { r = await src.getCues({ text: c.input, words, blankIndices: words.map((w, i) => (w === '_' ? i : -1)).filter((i) => i >= 0) }); } catch { /* counted as no result */ }
    const m = r?.results?.[0]?.metadata ?? {};
    rows.push({ c, mode: m.pipelineMode ?? (r?.results?.length ? 'fused' : 'none'), target: m.transformTarget, value: r?.results?.[0]?.alternatives?.[1], ms: Date.now() - t0 });
  }
  arm = null;
  const rep = rows.filter((x) => x.c.expected.cls === 'replace');
  const spliced = rep.filter((x) => x.mode === 'replace-splice-decision');
  const valueOk = (x: typeof rows[number]) => (x.c.expected.values ?? []).some((v) => (x.value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const falseSplices = rows.filter((x) => x.c.expected.cls !== 'replace' && x.mode === 'replace-splice-decision');
  console.log(`\nE2E (real TransformBlankSource: fused on cerebras + decision detector)  (${rows.length} cases) · mean ${mean(rows.map((x) => x.ms))} ms`);
  console.log(`  replace: spliced ${pct(spliced.length, rep.length)} · spliced value matches the suite ${pct(spliced.filter(valueOk).length, spliced.length)} · target right ${pct(spliced.filter((x) => targetOk(x.c, x.target ?? '')).length, spliced.length)}`);
  console.log(`  fill/none: FALSE splices ${falseSplices.length}${falseSplices.length ? ': ' + falseSplices.map((x) => `${x.c.id}→«${x.target}»→«${x.value}»`).join(', ') : ''}`);
  for (const x of rep.filter((x) => x.mode !== 'replace-splice-decision')) console.log(`    not spliced [${x.c.id}] ${x.mode}  «${x.c.input.slice(0, 60)}»`);
  for (const x of spliced.filter((x) => !valueOk(x))) console.log(`    value differs [${x.c.id}] «${x.target}» → «${x.value}» (suite: ${(x.c.expected.values ?? []).join(' / ')})`);
}

console.log(`step 7A replace bench · ${CASES.length} cases (${CASES.filter((c) => c.expected.cls === 'replace').length} replace / ${CASES.filter((c) => c.expected.cls === 'fill').length} fill / ${CASES.filter((c) => c.expected.cls === 'none').length} none) · candidates per case mean ${mean(CASES.map((c) => replaceCandidates(c.input).targets.length))}`);
if (ARM === 'chat' || ARM === 'both') await runChat();
if (ARM === 'jev' || ARM === 'both') await runJev();
if (ARM === 'e2e') await runE2E();
