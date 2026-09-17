// `_` ROUTER bench (Jev plan step 5, design A). The REAL three chat blank
// sources (config-intent, transform-blank, fluid-blank, built by
// buildSourcesFromConfig on cerebras) behind the REAL core resolver, on the
// 171 labelled `_` cases the three pipelines' own suites provide, run two
// ways in the same session:
//
//   CHAT    today: every chat source dispatched at once (the fan-out)
//   ROUTED  routeUnderscore first, then only the routed source; a routed
//           source that cedes is followed by the fan-out over the rest
//           (the runtime's cede fallback, mirrored here)
//
// Scored on the runtime's own outcome per `_`: which source WON (highest
// priority with a result), so the two arms are compared on agreement, on
// answers the routed arm lost (chat had a winner, routed had none), and on
// calls / $ / latency per `_`. The router's own judgement against the labels
// is `--probe` (the 171-case router probe, no chat calls).
//
// Run: TYPESAFE_API_KEY=… CEREBRAS_API_KEY=… npx tsx tests/benchmarks/decisions/route-bench.mts [--arm chat|routed|both|probe] [--n 60] [--threshold 0.5]
import path from 'node:path';
import url from 'node:url';
import { CASES as FLUID_CONFIG_CASES } from '../fluid-config/cases';
import { CASES as FLUID_CASES } from '../fluid-blank/cases';
import { CASES as TRANSFORM_CASES } from '../transform-blank/cases';

const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const argv = process.argv.slice(2);
const ARM = argv.includes('--arm') ? argv[argv.indexOf('--arm') + 1] : 'both';
const N = argv.includes('--n') ? Number(argv[argv.indexOf('--n') + 1]) : 40;
const THRESHOLD = argv.includes('--threshold') ? Number(argv[argv.indexOf('--threshold') + 1]) : undefined;
const http = new NodeHttpAdapter({ maxSockets: 8, timeout: 30000 });
const CEREBRAS = process.env.CEREBRAS_API_KEY, TYPESAFE = process.env.TYPESAFE_API_KEY;
if (!CEREBRAS || !TYPESAFE) { console.error('CEREBRAS_API_KEY and TYPESAFE_API_KEY are required'); process.exit(2); }

// ── cases (the router probe's corpus) ──────────────────────────────────────
type Label = 'settings' | 'transform' | 'lookup' | 'device' | 'not-settings' | 'not-transform';
const cases: Array<{ input: string; want: Label; from: string }> = [];
const every = <T,>(arr: T[], n: number) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
for (const c of FLUID_CONFIG_CASES as any[]) {
  if (c.category.startsWith('hit')) cases.push({ input: c.input, want: 'settings', from: `config/${c.category}` });
  else if (c.category === 'reject-fluid') cases.push({ input: c.input, want: 'lookup', from: `config/${c.category}` });
  else if (c.category === 'reject-user-blank') cases.push({ input: c.input, want: 'device', from: `config/${c.category}` });
  else cases.push({ input: c.input, want: 'not-settings', from: `config/${c.category}` });
}
for (const c of every((FLUID_CASES as any[]).filter((c) => c.category !== 'no-question' && !c.shouldFailSoft), N)) cases.push({ input: c.input, want: 'lookup', from: `fluid/${c.category}` });
for (const c of every((TRANSFORM_CASES as any[]).filter((c) => c.category !== 'negative' && c.input.length < 400), N)) cases.push({ input: c.input, want: 'transform', from: `transform/${c.category}` });
for (const c of (TRANSFORM_CASES as any[]).filter((c) => c.category === 'negative')) cases.push({ input: c.input, want: 'not-transform', from: 'transform/negative' });

// ── usage per arm, priced from the meter ──────────────────────────────────
const usage: Record<string, { arm: string; providerId: string; model: string; calls: number; promptTokens: number; cachedTokens: number; completionTokens: number }> = {};
let arm: string | null = null;
core.registerUsageSink((u: any) => {
  if (!arm) return;
  const k = `${arm}|${u.providerId}/${u.model}`;
  const row = usage[k] ?? (usage[k] = { arm, providerId: u.providerId, model: u.model, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
  row.calls++; row.promptTokens += u.promptTokens; row.cachedTokens += u.cachedTokens; row.completionTokens += u.completionTokens;
});
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const PRIORITY: Record<string, number> = { 'config-intent': 94, 'transform-blank': 93, 'fluid-blank': 90 };
const winner = (results: Array<{ source?: string }>) => results.map((r) => r.source ?? '').filter((s) => s in PRIORITY).sort((a, b) => PRIORITY[b] - PRIORITY[a])[0] ?? null;

// ── the real sources + resolver ────────────────────────────────────────────
const sources = core.buildSourcesFromConfig(undefined, undefined, {
  httpAdapter: http, apiKeys: { CEREBRAS_API_KEY: CEREBRAS }, globalProvider: 'cerebras', globalModel: 'gpt-oss-120b',
  enableConfigIntent: true, applyOpencuesScalar: () => {}, enableFluidBlank: true, enableTransformBlank: true, replaceParse: true,
  hostName: 'claude-code', blanks: {}, maxThinking: true,
});
const ids = sources.map((s: any) => s.id);
if (!['config-intent', 'transform-blank', 'fluid-blank'].every((id) => ids.includes(id))) { console.error(`sources built: ${ids.join(', ')} — expected the three chat blank sources`); process.exit(2); }
const resolver = core.createResolver(sources, { parallel: true, timeout: 30000, continueOnError: true });
const decisions = new core.TypeSafeDecisionProvider({ apiKey: TYPESAFE, httpAdapter: http });
const ctxFor = (text: string) => ({ text, words: text.split(/\s+/).filter(Boolean), cursor: text.length, domain: 'claude-code' });

async function run(name: string, routed: boolean) {
  arm = name;
  const ms: number[] = []; const winners: Array<string | null> = []; let routedN = 0, ceded = 0, routerFailed = 0;
  for (const c of cases) {
    const t0 = Date.now();
    let only: ((id: string) => boolean) | undefined; let routedTo: string | null = null;
    if (routed) {
      try {
        const r = await core.routeUnderscore(decisions, c.input, { threshold: THRESHOLD });
        routedTo = r.sourceId;
        if (routedTo) { routedN++; only = (id: string) => !core.UNDERSCORE_CHAT_SOURCE_IDS.has(id) || id === routedTo; }
      } catch { routerFailed++; }
    }
    let results: Array<{ source?: string }> = [];
    try { results = (await resolver.resolve(ctxFor(c.input), { only })).results; } catch { /* counted as no winner */ }
    if (routedTo && !results.some((r) => r.source === routedTo)) {
      ceded++;
      try { results = results.concat((await resolver.resolve(ctxFor(c.input), { only: (id: string) => core.UNDERSCORE_CHAT_SOURCE_IDS.has(id) && id !== routedTo })).results); } catch { /* ditto */ }
    }
    ms.push(Date.now() - t0);
    winners.push(winner(results));
  }
  arm = null;
  const rows = Object.values(usage).filter((u) => u.arm === name);
  let cost = 0, chat = 0, jev = 0;
  for (const u of rows) { const price = core.priceFor(u.providerId, u.model); if (price) cost += core.estimateRowCostUSD(u, price); if (u.providerId === 'typesafe') jev += u.calls; else chat += u.calls; }
  console.log(`\n${name}  (${cases.length} underscores${THRESHOLD !== undefined ? `, T=${THRESHOLD}` : ''})`);
  if (routed) console.log(`  routed ${routedN}/${cases.length} · routed-then-ceded ${ceded} · router failed ${routerFailed}`);
  console.log(`  latency per _ p50 ${pct(ms, 0.5)} ms · p90 ${pct(ms, 0.9)} ms · mean ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms`);
  console.log(`  calls per _: chat ${(chat / cases.length).toFixed(2)} · jev ${(jev / cases.length).toFixed(2)} · $ per _ ${(cost / cases.length).toFixed(6)}`);
  for (const u of rows) console.log(`    ${u.providerId}/${u.model}: ${u.calls} calls · ${Math.round(u.promptTokens / u.calls)} in (${Math.round(u.cachedTokens / u.calls)} cached) / ${Math.round(u.completionTokens / u.calls)} out`);
  const byWinner: Record<string, number> = {};
  for (const w of winners) byWinner[w ?? '(none)'] = (byWinner[w ?? '(none)'] ?? 0) + 1;
  console.log(`  winners: ${Object.entries(byWinner).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  return winners;
}

if (ARM === 'probe') {
  // the router alone against the labels — the probe the shipped question was chosen on
  const rows: Array<{ want: Label; routing: any }> = [];
  for (const c of cases) rows.push({ want: c.want, routing: await core.routeUnderscore(decisions, c.input, { threshold: THRESHOLD }) });
  const right = (want: Label, route: string) => want.startsWith('not-') ? route !== want.slice(4) : route === want;
  const acted = rows.filter((r) => r.routing.route);
  console.log(`router probe: ${rows.length} cases · routed ${acted.length} (${Math.round(100 * acted.length / rows.length)}%) · right on routed ${acted.filter((r) => right(r.want, r.routing.route)).length}/${acted.length} · mean ${Math.round(rows.reduce((s, r) => s + r.routing.ms, 0) / rows.length)} ms`);
  for (const r of acted.filter((r) => !right(r.want, r.routing.route))) console.log(`  WRONG ${r.want} -> ${r.routing.route} (conf ${r.routing.confidence.toFixed(2)}, agree ${r.routing.agreement.toFixed(2)})`);
  process.exit(0);
}

let chatW: Array<string | null> | null = null, routedW: Array<string | null> | null = null;
if (ARM === 'chat' || ARM === 'both') chatW = await run('CHAT (today, the fan-out)', false);
if (ARM === 'routed' || ARM === 'both') routedW = await run('ROUTED (design A: router first, cede fallback)', true);
if (chatW && routedW) {
  let agree = 0, lost = 0, gained = 0, differ = 0; const diffs: string[] = [];
  cases.forEach((c, i) => {
    const a = chatW![i], b = routedW![i];
    if (a === b) agree++;
    else if (a && !b) { lost++; diffs.push(`LOST    [${c.want}] chat ${a} → routed none  «${c.input.slice(0, 50)}»`); }
    else if (!a && b) { gained++; diffs.push(`gained  [${c.want}] chat none → routed ${b}  «${c.input.slice(0, 50)}»`); }
    else { differ++; diffs.push(`differ  [${c.want}] chat ${a} → routed ${b}  «${c.input.slice(0, 50)}»`); }
  });
  console.log(`\nAGREEMENT chat vs routed: same winner ${agree}/${cases.length} · lost answers ${lost} · gained ${gained} · different winner ${differ}`);
  for (const d of diffs) console.log(`  ${d}`);
}
