/**
 * Nested-composition probe.
 *
 * Question: can the model emit a sentinel whose parameter is ANOTHER
 * sentinel? E.g. given a `WORK CITY` identity scalar and a
 * `WEATHER(city: string)` fn, the prompt "weather where I work _"
 * could be expressed as:
 *
 *   [WEATHER(city=[WORK CITY])]
 *
 * If models can do this reliably, the catalog gains a lot of
 * expressiveness — we don't need a separate `WEATHER AT HOME`
 * entry; the user's prose composes existing entries.
 *
 * Three syntax candidates for nested:
 *
 *   A. inline-bracket    [WEATHER(city=[WORK CITY])]
 *   B. inline-token      [WEATHER(city=WORK_CITY)]   (sentinel-as-bareword)
 *   C. two-token         [WORK CITY] [WEATHER(city=$1)]  (referential, fragile)
 *
 * We only test A and B — C is too rare in the wild to expect any
 * model to invent.
 *
 * Cases focus on inputs where:
 *   - the user implicitly references their own data ("my city's weather")
 *   - the catalog has both the scalar AND the parameterized fn
 *   - a "non-nested" answer is reasonable but inferior
 *     (just emitting `[WEATHER]` without a city ignores the user's
 *     intent)
 *
 * Scoring:
 *   nested      — did the model emit a nested bracket / token?
 *   correct-arg — was the nested value the right scalar (e.g.
 *                 WORK CITY not HOME CITY)?
 *   fmt-parse   — does the runtime's regex strip the outer bracket
 *                 cleanly?
 *
 * Bonus: also score the "fallback" — when the model didn't nest,
 * did it emit a useful sentinel? A non-nested `[WEATHER]` (no
 * args) is OK if the catalog allows; `[WEATHER]` resolving to the
 * runtime's default city would be a degraded but live answer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickProvider, type ProviderId } from './providers';

// ────────────────────────────────────────────────────────────────────
// Catalog
// ────────────────────────────────────────────────────────────────────

interface NestedEntry {
  id: string;
  displayName: string;
  description: string;
  kind: 'scalar' | 'fn';
  returns: string;
  params?: Array<{ name: string; type: string }>;
}

const CATALOG: NestedEntry[] = [
  { id: 'first-name', displayName: 'FIRST NAME', kind: 'scalar', returns: 'string', description: "user's first name" },
  { id: 'home-city', displayName: 'HOME CITY', kind: 'scalar', returns: 'string', description: "city the user lives in" },
  { id: 'work-city', displayName: 'WORK CITY', kind: 'scalar', returns: 'string', description: "city the user works in" },
  { id: 'watch-ticker', displayName: 'WATCH TICKER', kind: 'scalar', returns: 'string', description: "the stock ticker the user is watching" },
  { id: 'home-currency', displayName: 'HOME CURRENCY', kind: 'scalar', returns: 'string', description: "ISO code for user's home currency (USD, GBP, ...)" },
  // Parameterized fns
  { id: 'weather-temp', displayName: 'WEATHER TEMP', kind: 'fn', returns: 'number',
    description: 'current temperature for a city (celsius)',
    params: [{ name: 'city', type: 'string' }] },
  { id: 'time-in', displayName: 'TIME IN', kind: 'fn', returns: 'string',
    description: 'current local time in a city',
    params: [{ name: 'city', type: 'string' }] },
  { id: 'stock-price', displayName: 'STOCK PRICE', kind: 'fn', returns: 'number',
    description: 'current price of a stock',
    params: [{ name: 'ticker', type: 'string' }] },
  { id: 'currency-convert', displayName: 'CONVERT', kind: 'fn', returns: 'number',
    description: 'convert money between currencies',
    params: [
      { name: 'amount', type: 'number' },
      { name: 'from', type: 'string' },
      { name: 'to', type: 'string' },
    ] },
];

// ────────────────────────────────────────────────────────────────────
// Cases
// ────────────────────────────────────────────────────────────────────

interface NestedCase {
  id: string;
  prompt: string;
  outerId: string;
  outerParams: Record<string, string>; // expected, where the args are inner IDs
}

const CASES: ReadonlyArray<NestedCase> = [
  // Weather + work-city
  { id: 'n1', prompt: 'whats the weather where i work _',
    outerId: 'weather-temp', outerParams: { city: 'work-city' } },
  { id: 'n2', prompt: 'temperature in my work city _',
    outerId: 'weather-temp', outerParams: { city: 'work-city' } },

  // Weather + home-city
  { id: 'n3', prompt: 'whats the weather at home today _',
    outerId: 'weather-temp', outerParams: { city: 'home-city' } },
  { id: 'n4', prompt: 'how warm is it at home _',
    outerId: 'weather-temp', outerParams: { city: 'home-city' } },

  // Time + work-city
  { id: 'n5', prompt: 'whats the time in my work city _',
    outerId: 'time-in', outerParams: { city: 'work-city' } },
  { id: 'n6', prompt: 'current time at the office _',
    outerId: 'time-in', outerParams: { city: 'work-city' } },

  // Stock + watch-ticker
  { id: 'n7', prompt: 'price of the stock im watching _',
    outerId: 'stock-price', outerParams: { ticker: 'watch-ticker' } },
  { id: 'n8', prompt: 'my watched ticker price _',
    outerId: 'stock-price', outerParams: { ticker: 'watch-ticker' } },

  // Currency convert with home-currency
  { id: 'n9', prompt: 'whats 100 eur in my home currency _',
    outerId: 'currency-convert', outerParams: { amount: '100', from: 'EUR', to: 'home-currency' } },
  { id: 'n10', prompt: 'how much is 50 usd in my currency _',
    outerId: 'currency-convert', outerParams: { amount: '50', from: 'USD', to: 'home-currency' } },
];

// ────────────────────────────────────────────────────────────────────
// Renderer (parameterized style)
// ────────────────────────────────────────────────────────────────────

function paramSig(e: NestedEntry): string {
  return (e.params ?? []).map(p => `${p.name}: ${p.type}`).join(', ');
}

function renderCatalog(): string {
  const lines = CATALOG.map(e => {
    const sig = (e.params && e.params.length > 0) ? `(${paramSig(e)})` : '';
    return `- [${e.displayName}${sig}: ${e.returns}] — ${e.description}`;
  }).join('\n');
  return `AVAILABLE FUNCTIONS — typed catalog with parameter signatures.

USE PATTERN: emit a token of the form [NAME] for scalars (no args), [NAME(arg=value)] for functions.

You may use ANOTHER token as a function argument when the value is on the user's behalf. For example, if "city" is a function arg and you have a [WORK CITY] scalar, the user's "my work city" intent maps to:
    [WEATHER(city=[WORK CITY])]   ← nest the [WORK CITY] token inside the city= arg
The runtime resolves the inner token FIRST then passes the value to the outer call.

${lines}`;
}

function buildSystem(): string {
  return `You read a user's text containing an underscore (\`_\`) and emit catalog tokens that the runtime will substitute with real data.

Output the user's text with tokens spliced in where the data should land. DO NOT explain. If no token fits, output the text verbatim.

${renderCatalog()}

Example: "Hi [FIRST NAME], the temperature where you work is [WEATHER TEMP(city=[WORK CITY])]."`;
}

// ────────────────────────────────────────────────────────────────────
// Parser — handles nested brackets via stack
// ────────────────────────────────────────────────────────────────────

interface ParsedNested {
  id: string | null;
  raw: string;
  args: Record<string, string | ParsedNested>;
}

function findEntry(name: string): NestedEntry | undefined {
  return CATALOG.find(e => e.displayName === name);
}

/** Extract every TOP-LEVEL `[...]` bracket. Allows nested `[...]` inside. */
function topLevelBrackets(s: string): Array<{ start: number; end: number; inner: string }> {
  const out: Array<{ start: number; end: number; inner: string }> = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push({ start, end: i, inner: s.slice(start + 1, i) });
        start = -1;
      }
    }
  }
  return out;
}

function splitTopLevelArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let inQuote: string | null = null;
  for (const ch of body) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseOne(inner: string): ParsedNested {
  // Possible shapes:
  //   NAME
  //   NAME: TYPE
  //   NAME(args)
  // args may themselves contain `[...]`
  let baseName: string;
  let argBody = '';
  const lparen = inner.indexOf('(');
  if (lparen < 0) {
    baseName = inner.trim();
  } else {
    baseName = inner.slice(0, lparen).trim();
    // find matching ')'
    let depth = 1;
    let j = lparen + 1;
    let q: string | null = null;
    for (; j < inner.length; j++) {
      const ch = inner[j]!;
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (depth === 0) break; }
    }
    argBody = inner.slice(lparen + 1, j);
  }
  const colon = baseName.indexOf(':');
  if (colon >= 0) baseName = baseName.slice(0, colon).trim();
  const ent = findEntry(baseName);
  const args: Record<string, string | ParsedNested> = {};
  if (argBody) {
    const parts = splitTopLevelArgs(argBody);
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      let v = part.slice(eq + 1).trim();
      // If v itself is a `[...]` bracket, recurse.
      if (v.startsWith('[') && v.endsWith(']')) {
        args[k] = parseOne(v.slice(1, -1));
      } else {
        v = v.replace(/^["']|["']$/g, '');
        args[k] = v;
      }
    }
  }
  return { id: ent?.id ?? null, raw: `[${inner}]`, args };
}

function parse(output: string): ParsedNested[] {
  return topLevelBrackets(output).map(b => parseOne(b.inner));
}

// ────────────────────────────────────────────────────────────────────
// Grader
// ────────────────────────────────────────────────────────────────────

interface NestedScore {
  caseId: string;
  prompt: string;
  output: string;
  parsed: ParsedNested[];
  nested: 0 | 1;
  outerHit: 0 | 1;
  innerHit: 0 | 1;          // all expected nested IDs matched
  literalHit: 0 | 1;        // ALL non-nested params (amounts, currency codes) matched
  overall: number;
  notes: string[];
}

function gradeCase(c: NestedCase, parsed: ParsedNested[]): NestedScore {
  const notes: string[] = [];
  const outer = parsed.find(p => p.id === c.outerId);
  const outerHit: 0 | 1 = outer ? 1 : 0;
  if (!outer) notes.push(`miss outer: expected ${c.outerId}, got [${parsed.map(p => p.id ?? '?').join(',')}]`);

  // Did model use ANY nested bracket as an arg?
  let nested: 0 | 1 = 0;
  let innerHit: 0 | 1 = 1;
  let literalHit: 0 | 1 = 1;
  if (outer) {
    for (const [k, expectedV] of Object.entries(c.outerParams)) {
      const got = outer.args[k];
      const innerEntry = CATALOG.find(e => e.id === expectedV);
      if (innerEntry) {
        // This arg expects a nested sentinel
        if (typeof got === 'object' && got !== null) {
          nested = 1;
          if (got.id !== expectedV) {
            innerHit = 0;
            notes.push(`wrong inner: ${k}= expected ${expectedV}, got ${got.id ?? '?'}`);
          }
        } else if (typeof got === 'string') {
          // Model passed a literal — maybe valid but not nested.
          // Score nested=0, innerHit=0.
          innerHit = 0;
          notes.push(`literal instead of nested: ${k}="${got}", expected nested [${innerEntry.displayName}]`);
        } else {
          innerHit = 0;
          notes.push(`missing arg: ${k}`);
        }
      } else {
        // Literal arg expected
        if (typeof got === 'string') {
          if (got.toLowerCase() === expectedV.toLowerCase()) {
            // ok
          } else {
            literalHit = 0;
            notes.push(`literal mismatch: ${k}="${got}", expected "${expectedV}"`);
          }
        } else if (got === undefined) {
          literalHit = 0;
          notes.push(`missing literal arg: ${k}`);
        }
      }
    }
  }
  const overall = (nested + outerHit + innerHit + literalHit) / 4;
  return { caseId: c.id, prompt: c.prompt, output: '', parsed, nested, outerHit, innerHit, literalHit, overall, notes };
}

// ────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const out = { provider: 'cerebras' as ProviderId, parallel: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] as ProviderId;
    else if (a === '--parallel') out.parallel = parseInt(argv[++i]!, 10);
  }
  return out;
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nNested-composition probe — ${CASES.length} cases`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})\n`);

  const runId = `nested-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });

  const system = buildSystem();
  const scores: NestedScore[] = new Array(CASES.length);
  let i = 0;
  process.stdout.write(`  Running... `);
  const t0 = Date.now();
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= CASES.length) return;
      const c = CASES[idx]!;
      const messages = provider.sysUser(system, c.prompt);
      try {
        const out = await provider.chat(messages, { temperature: 0, seed: 42, maxTokens: 512 });
        const parsed = parse(out.text);
        const s = gradeCase(c, parsed);
        s.output = out.text;
        scores[idx] = s;
      } catch (err) {
        scores[idx] = gradeCase(c, []);
        scores[idx]!.output = `<error: ${String(err)}>`;
      }
    }
  }
  await Promise.all(Array.from({ length: args.parallel }, () => worker()));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`done (${dt}s)`);
  console.log('');

  // Summary
  const n = scores.length;
  const mean = (k: keyof NestedScore) => scores.reduce((a, s) => a + (s[k] as number), 0) / n;
  const sum = { n, nested: mean('nested'), outerHit: mean('outerHit'), innerHit: mean('innerHit'), literalHit: mean('literalHit'), overall: mean('overall') };

  // Audit log
  const lines: string[] = [];
  lines.push(`# nested × ${provider.id} (${provider.modelLabel})`);
  lines.push(`# Overall: ${pct(sum.overall)}  nested=${pct(sum.nested)}  outer=${pct(sum.outerHit)}  inner=${pct(sum.innerHit)}  literal=${pct(sum.literalHit)}`);
  lines.push('');
  for (const s of scores) {
    lines.push(`── ${s.caseId} ──`);
    lines.push(`PROMPT: ${s.prompt}`);
    lines.push(`OUTPUT: ${s.output}`);
    lines.push(`PARSED: ${JSON.stringify(s.parsed)}`);
    lines.push(`SCORE:  nested=${s.nested} outer=${s.outerHit} inner=${s.innerHit} literal=${s.literalHit} overall=${pct(s.overall)}`);
    if (s.notes.length) lines.push(`NOTES:  ${s.notes.join('; ')}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(outDir, `audit.log`), lines.join('\n'));

  console.log('Axis           │ Score');
  console.log('───────────────┼─────────');
  console.log(`Overall         │ ${pct(sum.overall).padStart(7)}`);
  console.log(`Nested (any)    │ ${pct(sum.nested).padStart(7)} — model emitted a nested bracket`);
  console.log(`Outer-hit       │ ${pct(sum.outerHit).padStart(7)} — right outer function picked`);
  console.log(`Inner-hit       │ ${pct(sum.innerHit).padStart(7)} — right scalar nested into param`);
  console.log(`Literal-hit     │ ${pct(sum.literalHit).padStart(7)} — non-nested literals (amount, currency) correct`);
  console.log('');

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    summary: sum,
  }, null, 2));
  console.log(`Summary: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
