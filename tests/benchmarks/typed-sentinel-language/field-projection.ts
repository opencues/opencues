/**
 * Field-projection probe.
 *
 * Goal: don't fight the model — let it pick whatever syntax it wants
 * for picking fields off array items + element access. Then ask "can
 * the system PARSE everything the model naturally writes?"
 *
 * The probe has TWO halves:
 *
 *  HALF A — "open" condition.
 *    Catalog shows the array type signature (`array<{ticker: string,
 *    name: string, price: number}>`) but does NOT prescribe any
 *    accessor syntax. The model is free to write whatever feels
 *    natural. We log the distribution of syntaxes that emerge.
 *
 *  HALF B — "prescribed" condition.
 *    Catalog explicitly documents 4 syntaxes for accessing fields +
 *    elements. The model is told to use ONE of them, picked at random
 *    per-cell. Measures: can the model follow each prescription?
 *
 * Cases (20):
 *   - single-field-each-item — "list of stock prices" → name per item
 *   - multi-field-each-item — "names and prices of stocks"
 *   - filter-then-field — "just nvda's price"
 *   - first-element-field — "top stock's price"
 *   - last-element-field — "latest email subject"
 *   - count — "how many emails"
 *   - all — "all stock tickers"
 *   - composition — multiple field-projections in one prompt
 *
 * Catalog (3 array entries, multi-field items):
 *   STOCKS    array<{ticker, name, price, change}>
 *   EMAILS    array<{from, subject, time}>
 *   NEWS      array<{title, url, source}>
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickProvider, type ProviderId } from './providers';

// ────────────────────────────────────────────────────────────────────
// Catalog
// ────────────────────────────────────────────────────────────────────

interface ArrayEntry {
  id: string;
  displayName: string;
  description: string;
  itemFields: Array<{ name: string; type: string }>;
  /** Optional filter / count params, kept narrow so we can also test
   *  if the model invents them. */
  params?: Array<{ name: string; type: string }>;
}

const CATALOG: ArrayEntry[] = [
  {
    id: 'stocks', displayName: 'STOCKS', description: "user's watched stocks",
    itemFields: [
      { name: 'ticker', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'price', type: 'number' },
      { name: 'change', type: 'number' },
    ],
  },
  {
    id: 'emails', displayName: 'EMAILS', description: "user's recent emails",
    itemFields: [
      { name: 'from', type: 'string' },
      { name: 'subject', type: 'string' },
      { name: 'time', type: 'string' },
    ],
  },
  {
    id: 'news', displayName: 'NEWS', description: 'recent top headlines',
    itemFields: [
      { name: 'title', type: 'string' },
      { name: 'url', type: 'string' },
      { name: 'source', type: 'string' },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────
// Cases
// ────────────────────────────────────────────────────────────────────

type Dim =
  | 'single-field'
  | 'multi-field'
  | 'filter-then-field'
  | 'first-field'
  | 'last-field'
  | 'count'
  | 'all-field'
  | 'composition';

interface Case {
  id: string;
  prompt: string;
  dim: Dim;
  /** Set of (entry-id, field, accessor-hint) the model is expected to
   *  hit. Hint may be 'first' / 'last' / 'all' / null. */
  expected: Array<{ id: string; field?: string; element?: 'first' | 'last' | 'all' }>;
  /** When true, the catalog has no first-class way to do this op
   *  (e.g. count / filter) — model is expected to bail OR emit some
   *  natural-prose workaround. */
  outOfBand?: boolean;
}

const CASES: ReadonlyArray<Case> = [
  // single-field — pluck ONE field across all items
  { id: 'sf1', prompt: 'list of all my stock tickers _', dim: 'single-field',
    expected: [{ id: 'stocks', field: 'ticker', element: 'all' }] },
  { id: 'sf2', prompt: 'just the prices of my stocks _', dim: 'single-field',
    expected: [{ id: 'stocks', field: 'price', element: 'all' }] },
  { id: 'sf3', prompt: 'subjects of my recent emails _', dim: 'single-field',
    expected: [{ id: 'emails', field: 'subject', element: 'all' }] },
  { id: 'sf4', prompt: 'sources of todays news _', dim: 'single-field',
    expected: [{ id: 'news', field: 'source', element: 'all' }] },

  // multi-field — pluck >1 fields per item
  { id: 'mf1', prompt: 'tickers and prices of my stocks _', dim: 'multi-field',
    expected: [
      { id: 'stocks', field: 'ticker', element: 'all' },
      { id: 'stocks', field: 'price', element: 'all' },
    ] },
  { id: 'mf2', prompt: 'names and changes of my stocks _', dim: 'multi-field',
    expected: [
      { id: 'stocks', field: 'name', element: 'all' },
      { id: 'stocks', field: 'change', element: 'all' },
    ] },
  { id: 'mf3', prompt: 'senders and subjects of my emails _', dim: 'multi-field',
    expected: [
      { id: 'emails', field: 'from', element: 'all' },
      { id: 'emails', field: 'subject', element: 'all' },
    ] },
  { id: 'mf4', prompt: 'titles and sources of news today _', dim: 'multi-field',
    expected: [
      { id: 'news', field: 'title', element: 'all' },
      { id: 'news', field: 'source', element: 'all' },
    ] },

  // filter-then-field — filter to one item by predicate, then pluck field
  { id: 'ff1', prompt: 'just nvda price _', dim: 'filter-then-field',
    expected: [{ id: 'stocks', field: 'price' }],
    outOfBand: true /* catalog has no filter param */ },
  { id: 'ff2', prompt: 'aapl change today _', dim: 'filter-then-field',
    expected: [{ id: 'stocks', field: 'change' }], outOfBand: true },
  { id: 'ff3', prompt: 'email from boss subject _', dim: 'filter-then-field',
    expected: [{ id: 'emails', field: 'subject' }], outOfBand: true },

  // first-element-field — top/first + field
  { id: 'fe1', prompt: 'price of my top stock _', dim: 'first-field',
    expected: [{ id: 'stocks', field: 'price', element: 'first' }] },
  { id: 'fe2', prompt: 'name of the top news source _', dim: 'first-field',
    expected: [{ id: 'news', field: 'source', element: 'first' }] },
  { id: 'fe3', prompt: 'subject of my first unread email _', dim: 'first-field',
    expected: [{ id: 'emails', field: 'subject', element: 'first' }] },

  // last-element-field
  { id: 'le1', prompt: 'subject of my latest email _', dim: 'last-field',
    expected: [{ id: 'emails', field: 'subject', element: 'last' }] },
  { id: 'le2', prompt: 'who sent my most recent email _', dim: 'last-field',
    expected: [{ id: 'emails', field: 'from', element: 'last' }] },

  // count
  { id: 'c1', prompt: 'how many recent emails do i have _', dim: 'count',
    expected: [{ id: 'emails' }], outOfBand: true },
  { id: 'c2', prompt: 'count of stocks im watching _', dim: 'count',
    expected: [{ id: 'stocks' }], outOfBand: true },

  // all-field is captured under single-field — keep section for clarity

  // composition — multiple field projections in one prompt
  { id: 'cp1', prompt: "morning! tickers _, today's headlines _", dim: 'composition',
    expected: [
      { id: 'stocks', field: 'ticker', element: 'all' },
      { id: 'news', field: 'title', element: 'all' },
    ] },
  { id: 'cp2', prompt: 'recap: stock prices _, top headline _', dim: 'composition',
    expected: [
      { id: 'stocks', field: 'price', element: 'all' },
      { id: 'news', field: 'title', element: 'first' },
    ] },
];

// ────────────────────────────────────────────────────────────────────
// Catalog renderers — OPEN (no syntax) vs PRESCRIBED (each syntax)
// ────────────────────────────────────────────────────────────────────

function renderItemFields(e: ArrayEntry): string {
  return e.itemFields.map(f => `${f.name}: ${f.type}`).join(', ');
}

function renderOpen(): string {
  // Just the type signature — no accessor syntax prescribed.
  const lines = CATALOG.map(e =>
    `- [${e.displayName}: array<{${renderItemFields(e)}}>] — ${e.description}`,
  ).join('\n');
  return `AVAILABLE CONTEXT — each entry returns an array of structured items. You may pluck fields off items if you need just one field per item.

${lines}

Emit one or more bracketed tokens; the runtime resolves and inlines values. Use whatever syntax feels natural — the runtime is generous.`;
}

type SyntaxId = 'dotted' | 'projection' | 'separate' | 'mapped';

function renderPrescribed(syn: SyntaxId): string {
  const lines = CATALOG.map(e => {
    const items = `array<{${renderItemFields(e)}}>`;
    return `- [${e.displayName}: ${items}] — ${e.description}`;
  }).join('\n');
  let teach: string;
  switch (syn) {
    case 'dotted':
      teach = `SYNTAX (use this form ONLY):
  Full array:           [STOCKS]
  Single field of each: [STOCKS.price]
  First element:        [STOCKS.first]
  Last element:         [STOCKS.last]
  First's field:        [STOCKS.first.price]
  Multiple fields:      emit each separately: [STOCKS.ticker] [STOCKS.price]
  Count:                [STOCKS.count]`;
      break;
    case 'projection':
      teach = `SYNTAX (use this form ONLY):
  Full array:           [STOCKS]
  Single field of each: [STOCKS{price}]
  Multiple fields:      [STOCKS{ticker, price}]
  First element:        [STOCKS.first]
  First's field:        [STOCKS.first{price}]
  Count:                [STOCKS.count]`;
      break;
    case 'separate':
      teach = `SYNTAX (use this form ONLY):
  Full array:           [STOCKS]
  For ONE field, emit a separate per-field token: [STOCKS PRICE] / [STOCKS TICKER]
  Multiple fields:      [STOCKS TICKER] [STOCKS PRICE] (two tokens)
  First element:        [STOCKS FIRST]
  First's field:        [STOCKS FIRST PRICE]
  Count:                [STOCKS COUNT]`;
      break;
    case 'mapped':
      teach = `SYNTAX (use this form ONLY):
  Full array:           [STOCKS]
  Single field of each: [STOCKS | map: price]
  Multiple fields:      [STOCKS | map: ticker, price]
  First element:        [STOCKS | first]
  First's field:        [STOCKS | first | price]
  Count:                [STOCKS | count]`;
      break;
  }
  return `AVAILABLE CONTEXT — each entry returns an array of structured items.

${lines}

${teach}

Output the user's text with tokens spliced in.`;
}

function buildSystemOpen(): string {
  return `You read a user's text containing an underscore (\`_\`) and emit bracketed context tokens. The runtime substitutes real values after your response.

Output the user's text with tokens spliced in. DO NOT explain.

${renderOpen()}`;
}

function buildSystemPrescribed(syn: SyntaxId): string {
  return `You read a user's text containing an underscore (\`_\`) and emit bracketed context tokens. The runtime substitutes real values after your response.

Output the user's text with tokens spliced in. DO NOT explain.

${renderPrescribed(syn)}`;
}

// ────────────────────────────────────────────────────────────────────
// Parsers — one per OPEN observation pattern; one per prescribed syntax
// ────────────────────────────────────────────────────────────────────

interface Parsed {
  id: string | null;
  raw: string;
  /** Field projected (or null). */
  fields: string[];
  /** Element accessor extracted ('first' / 'last' / 'count' / null). */
  element: 'first' | 'last' | 'count' | 'all' | null;
}

/** Generic bracket extractor — handles nested brackets via stack. */
function topLevelBrackets(s: string): Array<{ raw: string; inner: string }> {
  const out: Array<{ raw: string; inner: string }> = [];
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
        out.push({ raw: s.slice(start, i + 1), inner: s.slice(start + 1, i) });
        start = -1;
      }
    }
  }
  return out;
}

/** Tolerant union parser — accepts any of the four prescribed forms
 *  PLUS a few natural-language drifts (e.g. `STOCKS.price` even when
 *  prescribed was `[STOCKS{price}]`).
 *
 *  Returns null id when the bracket clearly doesn't match any catalog
 *  entry.
 */
function tolerantParse(inner: string): Parsed {
  const t = inner.trim().replace(/^([A-Z][A-Z\s]+?)\s*:\s*[^,]*$/i, '$1'); // strip trailing `: type` annotation
  // Strip leading `array<...>` clutter
  // Match `NAME` first, then look for accessors.
  // Try projection: NAME{a, b, c}
  let m = /^([A-Z][A-Z\s]*?)\s*\{([^}]+)\}$/.exec(t);
  if (m) {
    const name = m[1]!.trim();
    const fields = m[2]!.split(',').map(s => s.trim());
    const ent = CATALOG.find(e => e.displayName === name);
    return { id: ent?.id ?? null, raw: `[${inner}]`, fields, element: 'all' };
  }
  // Try mapped: NAME | map: a, b, c   OR   NAME | first | b   OR   NAME | count
  m = /^([A-Z][A-Z\s]*?)\s*\|\s*(.+)$/.exec(t);
  if (m) {
    const name = m[1]!.trim();
    const rest = m[2]!.trim();
    const segs = rest.split('|').map(s => s.trim());
    let element: Parsed['element'] = 'all';
    let fields: string[] = [];
    for (const seg of segs) {
      if (/^first$/i.test(seg)) element = 'first';
      else if (/^last$/i.test(seg)) element = 'last';
      else if (/^count$/i.test(seg)) element = 'count';
      else if (/^map\s*:/i.test(seg)) {
        const after = seg.slice(seg.indexOf(':') + 1).trim();
        fields = after.split(',').map(s => s.trim());
      } else {
        // bare segment → could be a field name
        fields = seg.split(',').map(s => s.trim());
      }
    }
    const ent = CATALOG.find(e => e.displayName === name);
    return { id: ent?.id ?? null, raw: `[${inner}]`, fields, element };
  }
  // Try dotted: NAME.a OR NAME.first OR NAME.first.field
  // Strip `()` if model included empty parens like NAME()
  let base = t;
  base = base.replace(/\(\s*\)$/, '');
  // Tokenize on `.`
  const segs = base.split('.').map(s => s.trim());
  const name = segs.shift()!;
  const ent = CATALOG.find(e => e.displayName === name);
  let element: Parsed['element'] = 'all';
  const fields: string[] = [];
  for (const s of segs) {
    if (/^first$/i.test(s)) element = 'first';
    else if (/^last$/i.test(s)) element = 'last';
    else if (/^count$/i.test(s)) element = 'count';
    else if (/^all$/i.test(s)) element = 'all';
    else fields.push(s);
  }
  return { id: ent?.id ?? null, raw: `[${inner}]`, fields, element };
}

/** Separate-entries parser: brackets like [STOCKS PRICE], [STOCKS FIRST PRICE]. */
function separateParse(inner: string): Parsed {
  const tokens = inner.trim().split(/\s+/);
  const name = tokens[0]!;
  const rest = tokens.slice(1).map(t => t.toLowerCase());
  const ent = CATALOG.find(e => e.displayName === name);
  // also try multi-word displayName (we don't have any in this catalog)
  let element: Parsed['element'] = 'all';
  const fields: string[] = [];
  for (const r of rest) {
    if (r === 'first') element = 'first';
    else if (r === 'last') element = 'last';
    else if (r === 'count') element = 'count';
    else if (r === 'all') element = 'all';
    else fields.push(r);
  }
  return { id: ent?.id ?? null, raw: `[${inner}]`, fields, element };
}

function parse(output: string, mode: 'tolerant' | 'separate' = 'tolerant'): Parsed[] {
  const out: Parsed[] = [];
  for (const { raw, inner } of topLevelBrackets(output)) {
    if (!/[A-Za-z]/.test(inner)) continue;
    out.push(mode === 'separate' ? separateParse(inner) : tolerantParse(inner));
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Grader
// ────────────────────────────────────────────────────────────────────

interface Score {
  caseId: string;
  dim: Dim;
  prompt: string;
  output: string;
  parsed: Parsed[];
  /** All expected (id, field, element) tuples covered? */
  semanticHit: 0 | 1;
  /** No invented field names (every parsed field is in the catalog item)? */
  noBadField: 0 | 1;
  /** Did anything emit? (zero-emit = bailed) */
  emitted: 0 | 1;
  notes: string[];
}

function gradeCase(c: Case, parsed: Parsed[]): Score {
  const notes: string[] = [];
  const emitted: 0 | 1 = parsed.length > 0 ? 1 : 0;

  // Check: every expected tuple has a parsed match.
  let semanticHit: 0 | 1 = 1;
  for (const exp of c.expected) {
    const candidates = parsed.filter(p => p.id === exp.id);
    if (candidates.length === 0) {
      semanticHit = 0;
      notes.push(`missing entry ${exp.id}`);
      continue;
    }
    // For each candidate, does it match the expected field + element?
    const matched = candidates.find(p => {
      const fieldOk = !exp.field || p.fields.includes(exp.field);
      const elementOk = !exp.element ||
        exp.element === p.element ||
        // 'all' is the default semantic; if model emitted with no
        // element accessor, that's 'all' too.
        (exp.element === 'all' && p.element === 'all');
      return fieldOk && elementOk;
    });
    if (!matched) {
      semanticHit = 0;
      notes.push(`miss ${exp.id} (field=${exp.field}, element=${exp.element ?? 'all'}); parsed=${JSON.stringify(candidates)}`);
    }
  }
  if (c.expected.length === 0 && parsed.some(p => p.id)) {
    // Out-of-band cases like count/filter: model emitting nothing OR
    // emitting the array (degraded — runtime returns array, user
    // visually counts) are both OK; emitting a hallucinated count
    // is the bad outcome.
    semanticHit = 1; // not penalized here — out-of-band is graded below
  }

  // No bad fields: every parsed.fields entry must be in some catalog
  // entry's itemFields list.
  let noBadField: 0 | 1 = 1;
  for (const p of parsed) {
    if (!p.id) continue;
    const ent = CATALOG.find(e => e.id === p.id);
    if (!ent) continue;
    const valid = new Set(ent.itemFields.map(f => f.name));
    for (const f of p.fields) {
      if (!valid.has(f)) {
        noBadField = 0;
        notes.push(`bad field on ${ent.displayName}: .${f}`);
      }
    }
  }

  return {
    caseId: c.id, dim: c.dim, prompt: c.prompt, output: '',
    parsed, semanticHit, noBadField, emitted, notes,
  };
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

async function runCell(
  provider: ReturnType<typeof pickProvider>,
  systemPrompt: string,
  parseMode: 'tolerant' | 'separate',
  parallel: number,
): Promise<Score[]> {
  const scores: Score[] = new Array(CASES.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= CASES.length) return;
      const c = CASES[idx]!;
      const messages = provider.sysUser(systemPrompt, c.prompt);
      try {
        const out = await provider.chat(messages, { temperature: 0, seed: 42, maxTokens: 512 });
        const parsed = parse(out.text, parseMode);
        const s = gradeCase(c, parsed);
        s.output = out.text;
        scores[idx] = s;
      } catch (err) {
        const s = gradeCase(c, []);
        s.output = `<error: ${String(err)}>`;
        scores[idx] = s;
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return scores;
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

function summarize(scores: Score[]) {
  const n = scores.length;
  const mean = (k: keyof Score) => n === 0 ? 0 : scores.reduce((a, s) => a + (s[k] as number), 0) / n;
  return {
    n, emitted: mean('emitted'),
    semanticHit: mean('semanticHit'),
    noBadField: mean('noBadField'),
  };
}

/** Discover what SYNTAX shapes the model spontaneously emits under OPEN. */
function summarizeOpenSyntax(scores: Score[]): Record<string, number> {
  // Classify each parsed token's syntactic shape by inspecting raw bracket.
  const counts: Record<string, number> = {
    'dotted-field': 0,            // [NAME.field]
    'dotted-element': 0,          // [NAME.first] [NAME.count]
    'dotted-element-field': 0,    // [NAME.first.field]
    'brace-projection': 0,        // [NAME{a, b}]
    'pipe-map': 0,                // [NAME | map: a]
    'separate-tokens': 0,         // [NAME FIELD]
    'bare-name': 0,               // [NAME]
    'unknown-shape': 0,
  };
  for (const s of scores) {
    for (const p of s.parsed) {
      const inner = p.raw.slice(1, -1).trim();
      if (/\|/.test(inner)) counts['pipe-map']!++;
      else if (/\{[^}]+\}$/.test(inner)) counts['brace-projection']!++;
      else if (/\.(first|last|count|all)\.\w+/i.test(inner)) counts['dotted-element-field']!++;
      else if (/\.(first|last|count|all)\b/i.test(inner)) counts['dotted-element']!++;
      else if (/\./.test(inner)) counts['dotted-field']!++;
      else if (/^[A-Z][A-Z\s]+\s+[A-Za-z]+$/.test(inner)) counts['separate-tokens']!++;
      else if (/^[A-Z][A-Z\s]+$/.test(inner)) counts['bare-name']!++;
      else counts['unknown-shape']!++;
    }
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nField-projection probe`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})`);
  console.log(`Cases: ${CASES.length} × HALF-A (open) + ${CASES.length} × HALF-B (4 prescribed syntaxes)\n`);

  const runId = `field-projection-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });

  // HALF A: open condition
  process.stdout.write(`  HALF A — open       `);
  let t0 = Date.now();
  const openScores = await runCell(provider, buildSystemOpen(), 'tolerant', args.parallel);
  let dt = ((Date.now() - t0) / 1000).toFixed(1);
  const openSum = summarize(openScores);
  const openSyntax = summarizeOpenSyntax(openScores);
  console.log(`done (${dt}s, semantic=${pct(openSum.semanticHit)})`);

  // Write open audit
  const openLines: string[] = [];
  openLines.push(`# HALF-A OPEN × ${provider.id} (${provider.modelLabel})`);
  openLines.push(`# semantic=${pct(openSum.semanticHit)} noBadField=${pct(openSum.noBadField)} emitted=${pct(openSum.emitted)}`);
  openLines.push(`# syntax-shape distribution: ${JSON.stringify(openSyntax)}`);
  openLines.push('');
  for (const s of openScores) {
    openLines.push(`── ${s.caseId} [${s.dim}] ──`);
    openLines.push(`PROMPT: ${s.prompt}`);
    openLines.push(`OUTPUT: ${s.output}`);
    openLines.push(`PARSED: ${JSON.stringify(s.parsed)}`);
    openLines.push(`SCORE:  semantic=${s.semanticHit} noBadField=${s.noBadField} emitted=${s.emitted}`);
    if (s.notes.length) openLines.push(`NOTES:  ${s.notes.join('; ')}`);
    openLines.push('');
  }
  fs.writeFileSync(path.join(outDir, 'open.log'), openLines.join('\n'));

  // HALF B: each prescribed syntax
  const synIds: SyntaxId[] = ['dotted', 'projection', 'separate', 'mapped'];
  const prescribedSums: Record<SyntaxId, ReturnType<typeof summarize>> = {} as any;
  for (const syn of synIds) {
    process.stdout.write(`  HALF B — ${syn.padEnd(11)}`);
    t0 = Date.now();
    const scores = await runCell(provider, buildSystemPrescribed(syn), syn === 'separate' ? 'separate' : 'tolerant', args.parallel);
    dt = ((Date.now() - t0) / 1000).toFixed(1);
    const sum = summarize(scores);
    prescribedSums[syn] = sum;
    console.log(`done (${dt}s, semantic=${pct(sum.semanticHit)})`);
    const lines: string[] = [];
    lines.push(`# HALF-B PRESCRIBED-${syn} × ${provider.id} (${provider.modelLabel})`);
    lines.push(`# semantic=${pct(sum.semanticHit)} noBadField=${pct(sum.noBadField)} emitted=${pct(sum.emitted)}`);
    lines.push('');
    for (const s of scores) {
      lines.push(`── ${s.caseId} [${s.dim}] ──`);
      lines.push(`PROMPT: ${s.prompt}`);
      lines.push(`OUTPUT: ${s.output}`);
      lines.push(`PARSED: ${JSON.stringify(s.parsed)}`);
      lines.push(`SCORE:  semantic=${s.semanticHit} noBadField=${s.noBadField} emitted=${s.emitted}`);
      if (s.notes.length) lines.push(`NOTES:  ${s.notes.join('; ')}`);
      lines.push('');
    }
    fs.writeFileSync(path.join(outDir, `prescribed-${syn}.log`), lines.join('\n'));
  }

  console.log('');
  console.log('Cell               │ Semantic │ NoBadField │ Emitted');
  console.log('───────────────────┼──────────┼────────────┼─────────');
  console.log(`open               │ ${pct(openSum.semanticHit).padStart(8)} │ ${pct(openSum.noBadField).padStart(10)} │ ${pct(openSum.emitted).padStart(7)}`);
  for (const syn of synIds) {
    const s = prescribedSums[syn];
    console.log(`prescribed-${syn.padEnd(8)} │ ${pct(s.semanticHit).padStart(8)} │ ${pct(s.noBadField).padStart(10)} │ ${pct(s.emitted).padStart(7)}`);
  }
  console.log('');

  console.log('OPEN-half syntax-shape distribution (what model naturally reaches for):');
  for (const [shape, n] of Object.entries(openSyntax).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${shape.padEnd(25)} ${n}`);
  }
  console.log('');

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    open: { ...openSum, syntaxShapes: openSyntax },
    prescribed: prescribedSums,
  }, null, 2));
  console.log(`Summary: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
