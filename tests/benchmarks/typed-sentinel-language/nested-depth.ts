/**
 * Nested-composition DEPTH probe — clears open decision #3 of the
 * typed-sentinel-language upgrade plan ("Nested call depth limit — max
 * 3 levels feels safe but the bench only tested 1 level. Run a deeper-
 * nesting probe before Phase 1 to confirm models don't go off the rails
 * at depth 2+.").
 *
 * The depth-1 `nested.ts` probe established `[WEATHER(city=[WORK CITY])]`
 * works at 100%. This probe asks the next question: how far does that
 * compositional ability hold? It builds a small chainable catalog where
 * the natural answer to a prompt requires 1, 2, or 3 levels of bracket
 * nesting, e.g.
 *
 *   depth 1: [WEATHER TEMP(city=[WORK CITY])]
 *   depth 2: [HQ CITY(company=[COMPANY NAME(ticker=[WATCH TICKER])])]
 *   depth 3: [WEATHER TEMP(city=[HQ CITY(company=[COMPANY NAME(ticker=[WATCH TICKER])])])]
 *
 * The chain works because each fn's return type feeds the next fn's
 * arg: WATCH TICKER (scalar) → COMPANY NAME(ticker) → HQ CITY(company)
 * → WEATHER TEMP(city).
 *
 * What we measure, GROUPED BY EXPECTED DEPTH:
 *   exact      — parsed tree == expected tree (outer fn + every nested
 *                id + literal args, recursively)
 *   structOk   — right outer fn AND emitted nesting reached the
 *                expected depth (an inner id may be slightly off)
 *   wellFormed — brackets balanced AND every emitted token id is a real
 *                catalog entry (no hallucinated fn / arg)
 *   offRails   — the failure mode decision #3 cares about: malformed
 *                output (unbalanced brackets / hallucinated ids) OR the
 *                model bailed to prose / a flat non-nested token. This
 *                is what "going off the rails" means operationally.
 *
 * Decision rule for the plan:
 *   - If exact stays high (>=80%) and offRails stays ~0 through depth 3,
 *     no depth cap is needed for v1 — document depth 3 as supported.
 *   - If offRails climbs sharply at depth N, cap the parser at N-1 and
 *     have the catalog renderer stop advertising deeper composition.
 *
 * Run:
 *   OPENCUES_BENCH_PROVIDER=cerebras \
 *     npx tsx tests/benchmarks/typed-sentinel-language/nested-depth.ts \
 *     --provider cerebras --parallel 6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickProvider, type ProviderId } from './providers';

// ────────────────────────────────────────────────────────────────────
// Chainable catalog — return types line up so fns compose
// ────────────────────────────────────────────────────────────────────

interface Entry {
  id: string;
  displayName: string;
  description: string;
  kind: 'scalar' | 'fn';
  returns: string;
  params?: Array<{ name: string; type: string }>;
}

const CATALOG: Entry[] = [
  // Scalars (depth-0 leaves)
  { id: 'first-name', displayName: 'FIRST NAME', kind: 'scalar', returns: 'string', description: "user's first name" },
  { id: 'work-city', displayName: 'WORK CITY', kind: 'scalar', returns: 'string', description: 'city the user works in' },
  { id: 'watch-ticker', displayName: 'WATCH TICKER', kind: 'scalar', returns: 'string', description: 'stock ticker the user is watching' },
  { id: 'home-currency', displayName: 'HOME CURRENCY', kind: 'scalar', returns: 'string', description: "ISO code for user's home currency" },
  { id: 'employer-company', displayName: 'EMPLOYER COMPANY', kind: 'scalar', returns: 'string', description: 'company the user works for' },
  // Chainable fns — each return type feeds the next arg
  { id: 'company-name', displayName: 'COMPANY NAME', kind: 'fn', returns: 'string',
    description: 'company name for a stock ticker', params: [{ name: 'ticker', type: 'string' }] },
  { id: 'hq-city', displayName: 'HQ CITY', kind: 'fn', returns: 'string',
    description: 'headquarters city of a company', params: [{ name: 'company', type: 'string' }] },
  { id: 'weather-temp', displayName: 'WEATHER TEMP', kind: 'fn', returns: 'number',
    description: 'current temperature for a city (celsius)', params: [{ name: 'city', type: 'string' }] },
  { id: 'time-in', displayName: 'TIME IN', kind: 'fn', returns: 'string',
    description: 'current local time in a city', params: [{ name: 'city', type: 'string' }] },
  { id: 'stock-price', displayName: 'STOCK PRICE', kind: 'fn', returns: 'number',
    description: 'current USD price of a stock', params: [{ name: 'ticker', type: 'string' }] },
  { id: 'currency-convert', displayName: 'CONVERT', kind: 'fn', returns: 'number',
    description: 'convert money between currencies',
    params: [{ name: 'amount', type: 'number' }, { name: 'from', type: 'string' }, { name: 'to', type: 'string' }] },
];

// ────────────────────────────────────────────────────────────────────
// Expected trees + cases
// ────────────────────────────────────────────────────────────────────

/** Expected node: a scalar leaf (no args) or a fn with arg expectations.
 *  An arg value is either a nested ExpectNode or a literal string. */
interface ExpectNode { id: string; args?: Record<string, ExpectNode | string>; }

interface DepthCase { id: string; depth: 1 | 2 | 3; prompt: string; expect: ExpectNode; }

const scalar = (id: string): ExpectNode => ({ id });

const CASES: ReadonlyArray<DepthCase> = [
  // ── depth 1 ──────────────────────────────────────────────────────
  { id: 'd1a', depth: 1, prompt: 'whats the weather where i work _',
    expect: { id: 'weather-temp', args: { city: scalar('work-city') } } },
  { id: 'd1b', depth: 1, prompt: 'price of the stock im watching _',
    expect: { id: 'stock-price', args: { ticker: scalar('watch-ticker') } } },
  { id: 'd1c', depth: 1, prompt: 'what city is my employer based in _',
    expect: { id: 'hq-city', args: { company: scalar('employer-company') } } },

  // ── depth 2 ──────────────────────────────────────────────────────
  { id: 'd2a', depth: 2, prompt: 'the HQ city of the company im watching _',
    expect: { id: 'hq-city', args: { company: { id: 'company-name', args: { ticker: scalar('watch-ticker') } } } } },
  { id: 'd2b', depth: 2, prompt: 'the weather at my employers head office _',
    expect: { id: 'weather-temp', args: { city: { id: 'hq-city', args: { company: scalar('employer-company') } } } } },
  { id: 'd2c', depth: 2, prompt: 'my watched stock price in my home currency _',
    expect: { id: 'currency-convert', args: {
      amount: { id: 'stock-price', args: { ticker: scalar('watch-ticker') } },
      from: 'USD',
      to: scalar('home-currency'),
    } } },

  // ── depth 3 ──────────────────────────────────────────────────────
  { id: 'd3a', depth: 3, prompt: 'the weather at the HQ of the company im watching _',
    expect: { id: 'weather-temp', args: { city:
      { id: 'hq-city', args: { company:
        { id: 'company-name', args: { ticker: scalar('watch-ticker') } } } } } } },
  { id: 'd3b', depth: 3, prompt: 'what time is it at the head office of my watched company _',
    expect: { id: 'time-in', args: { city:
      { id: 'hq-city', args: { company:
        { id: 'company-name', args: { ticker: scalar('watch-ticker') } } } } } } },
  { id: 'd3c', depth: 3, prompt: 'how warm is it at the headquarters of the firm i track _',
    expect: { id: 'weather-temp', args: { city:
      { id: 'hq-city', args: { company:
        { id: 'company-name', args: { ticker: scalar('watch-ticker') } } } } } } },
];

// ────────────────────────────────────────────────────────────────────
// Catalog renderer (parameterized + explicit nesting instruction)
// ────────────────────────────────────────────────────────────────────

function renderCatalog(): string {
  const lines = CATALOG.map(e => {
    const sig = (e.params && e.params.length) ? `(${e.params.map(p => `${p.name}: ${p.type}`).join(', ')})` : '';
    return `- [${e.displayName}${sig}: ${e.returns}] — ${e.description}`;
  }).join('\n');
  return `AVAILABLE FUNCTIONS — typed catalog with parameter signatures.

USE PATTERN: emit [NAME] for scalars (no args), [NAME(arg=value)] for functions.

NESTING: a function argument may itself be ANOTHER token when that is how the user's intent maps to the data. The runtime resolves the INNERMOST token first and feeds its value outward. A function's return type can fill another function's argument when the types line up. Examples:
    [HQ CITY(company=[COMPANY NAME(ticker=[WATCH TICKER])])]
    [WEATHER TEMP(city=[HQ CITY(company=[EMPLOYER COMPANY])])]
Nest as deeply as the user's intent requires; do not invent functions that are not listed.

${lines}`;
}

function buildSystem(): string {
  return `You read a user's text containing an underscore (\`_\`) and emit catalog tokens that the runtime will substitute with real data.

Output the user's text with the token spliced in where the data should land. DO NOT explain. If no token fits, output the text verbatim.

${renderCatalog()}`;
}

// ────────────────────────────────────────────────────────────────────
// Recursive nested-bracket parser (same machinery as nested.ts)
// ────────────────────────────────────────────────────────────────────

interface Parsed { id: string | null; name: string; args: Record<string, string | Parsed>; }

function findEntry(name: string): Entry | undefined { return CATALOG.find(e => e.displayName === name); }

function topLevelBrackets(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '[') { if (depth === 0) start = i; depth++; }
    else if (ch === ']') { depth--; if (depth === 0 && start >= 0) { out.push(s.slice(start + 1, i)); start = -1; } }
  }
  return out;
}

function splitTopLevelArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', q: string | null = null;
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseOne(inner: string): Parsed {
  let baseName: string, argBody = '';
  const lp = inner.indexOf('(');
  if (lp < 0) { baseName = inner.trim(); }
  else {
    baseName = inner.slice(0, lp).trim();
    let depth = 1, j = lp + 1, q: string | null = null;
    for (; j < inner.length; j++) {
      const ch = inner[j]!;
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (depth === 0) break; }
    }
    argBody = inner.slice(lp + 1, j);
  }
  const colon = baseName.indexOf(':');
  if (colon >= 0) baseName = baseName.slice(0, colon).trim();
  const ent = findEntry(baseName);
  const args: Record<string, string | Parsed> = {};
  if (argBody) {
    for (const part of splitTopLevelArgs(argBody)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      let v = part.slice(eq + 1).trim();
      if (v.startsWith('[') && v.endsWith(']')) args[k] = parseOne(v.slice(1, -1));
      else args[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  return { id: ent?.id ?? null, name: baseName, args };
}

function parseAll(output: string): Parsed[] { return topLevelBrackets(output).map(parseOne); }

// ────────────────────────────────────────────────────────────────────
// Structural helpers
// ────────────────────────────────────────────────────────────────────

function bracketsBalanced(s: string): boolean {
  let d = 0;
  for (const ch of s) { if (ch === '[') d++; else if (ch === ']') { d--; if (d < 0) return false; } }
  return d === 0;
}

function maxBracketDepth(s: string): number {
  let d = 0, max = 0;
  for (const ch of s) { if (ch === '[') { d++; if (d > max) max = d; } else if (ch === ']') d--; }
  return max;
}

/** Every token id in the parsed tree resolves to a real catalog entry. */
function allIdsValid(p: Parsed): boolean {
  if (p.id === null) return false;
  for (const v of Object.values(p.args)) if (typeof v === 'object' && v !== null && !allIdsValid(v)) return false;
  return true;
}

/** Recursive exact compare: parsed tree matches the expected tree. */
function treeMatches(p: Parsed | string | undefined, e: ExpectNode | string): boolean {
  if (typeof e === 'string') {
    // literal arg — model may pass it verbatim (case-insensitive)
    return typeof p === 'string' && p.toLowerCase() === e.toLowerCase();
  }
  if (typeof p !== 'object' || p === null) return false;
  if (p.id !== e.id) return false;
  if (e.args) {
    for (const [k, ev] of Object.entries(e.args)) {
      if (!treeMatches(p.args[k], ev)) return false;
    }
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Grader
// ────────────────────────────────────────────────────────────────────

interface Score {
  caseId: string; depth: 1 | 2 | 3; prompt: string; output: string;
  exact: 0 | 1; structOk: 0 | 1; wellFormed: 0 | 1; offRails: 0 | 1;
  emittedDepth: number; notes: string[];
}

function grade(c: DepthCase, output: string): Score {
  const notes: string[] = [];
  const balanced = bracketsBalanced(output);
  const emittedDepth = maxBracketDepth(output);
  const parsed = parseAll(output);
  const outer = parsed.find(p => p.id === c.expect.id) ?? parsed[0];

  const exact: 0 | 1 = outer && treeMatches(outer, c.expect) ? 1 : 0;
  const structOk: 0 | 1 = (outer && outer.id === c.expect.id && emittedDepth >= c.depth) ? 1 : 0;
  const idsValid = parsed.length > 0 && parsed.every(allIdsValid);
  const wellFormed: 0 | 1 = (balanced && idsValid && parsed.length > 0) ? 1 : 0;

  // off the rails = malformed OR bailed (no token / flattened below the
  // required depth while not exact)
  const bailed = parsed.length === 0 || (emittedDepth < c.depth && exact === 0);
  const offRails: 0 | 1 = (!wellFormed || bailed) ? 1 : 0;

  if (!balanced) notes.push('UNBALANCED brackets');
  if (!idsValid) notes.push('hallucinated/unknown id in tree');
  if (parsed.length === 0) notes.push('no token emitted (prose bail)');
  if (exact === 0 && outer) notes.push(`tree mismatch vs expected (got depth ${emittedDepth}, need ${c.depth})`);

  return { caseId: c.id, depth: c.depth, prompt: c.prompt, output, exact, structOk, wellFormed, offRails, emittedDepth, notes };
}

// ────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const out = { provider: (process.env.OPENCUES_BENCH_PROVIDER as ProviderId) || 'cerebras' as ProviderId, parallel: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] as ProviderId;
    else if (a === '--parallel') out.parallel = parseInt(argv[++i]!, 10);
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nNested-DEPTH probe — ${CASES.length} cases (depth 1/2/3)`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})\n`);

  const runId = `nested-depth-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });

  const system = buildSystem();
  const scores: Score[] = new Array(CASES.length);
  let i = 0;
  process.stdout.write('  Running... ');
  const t0 = Date.now();
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= CASES.length) return;
      const c = CASES[idx]!;
      try {
        const out = await provider.chat(provider.sysUser(system, c.prompt), { temperature: 0, seed: 42, maxTokens: 512 });
        scores[idx] = grade(c, out.text);
      } catch (err) {
        scores[idx] = grade(c, `<error: ${String(err)}>`);
      }
    }
  }
  await Promise.all(Array.from({ length: args.parallel }, () => worker()));
  console.log(`done (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

  // Per-depth aggregation
  const byDepth = ([1, 2, 3] as const).map(d => {
    const rows = scores.filter(s => s.depth === d);
    const m = (k: keyof Score) => rows.reduce((a, s) => a + (s[k] as number), 0) / rows.length;
    return { depth: d, n: rows.length, exact: m('exact'), structOk: m('structOk'), wellFormed: m('wellFormed'), offRails: m('offRails') };
  });

  console.log('Depth │ n │ Exact   │ StructOk │ WellForm │ OffRails');
  console.log('──────┼───┼─────────┼──────────┼──────────┼─────────');
  for (const r of byDepth) {
    console.log(`  ${r.depth}   │ ${r.n} │ ${pct(r.exact).padStart(7)} │ ${pct(r.structOk).padStart(8)} │ ${pct(r.wellFormed).padStart(8)} │ ${pct(r.offRails).padStart(7)}`);
  }
  console.log('');

  // Audit log
  const lines: string[] = [`# nested-depth × ${provider.id} (${provider.modelLabel})`, ''];
  for (const s of scores) {
    lines.push(`── ${s.caseId} (depth ${s.depth}) ──`);
    lines.push(`PROMPT: ${s.prompt}`);
    lines.push(`OUTPUT: ${s.output}`);
    lines.push(`SCORE:  exact=${s.exact} structOk=${s.structOk} wellFormed=${s.wellFormed} offRails=${s.offRails} emittedDepth=${s.emittedDepth}`);
    if (s.notes.length) lines.push(`NOTES:  ${s.notes.join('; ')}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(outDir, 'audit.log'), lines.join('\n'));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ provider: provider.id, model: provider.modelLabel, byDepth }, null, 2));
  console.log(`Summary: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
