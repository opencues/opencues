/**
 * Universal-ops probe.
 *
 * Question: when given a bare-bones catalog (no accessor syntax
 * prescribed), what UNIVERSAL collection operations do models reach
 * for spontaneously?
 *
 * This is a discovery probe — we're listening, not measuring
 * accuracy. The output is a list of distinct ops we observed, with
 * counts.
 *
 * Catalog:
 *   STOCKS (array<{ticker, name, price, change}>)
 *   EMAILS (array<{from, subject, time}>)
 *   NEWS   (array<{title, url, source}>)
 *
 * Prompts span ~14 operations a real user might want. We see what
 * syntax the model emits for each.
 *
 *   first      "top stock"
 *   last       "latest email"
 *   nth        "the 3rd headline"
 *   length     "how many emails"
 *   slice      "first 5 stocks"
 *   reverse    "stocks in reverse order"
 *   sort       "newest emails first"
 *   filter     "stocks above $200"
 *   map        "just the tickers"
 *   reduce     "total volume across all stocks"
 *   find       "the email about launch"
 *   includes   "do i have an email about launch"
 *   any        "is there any stock above $500"
 *   join       "comma-separated tickers"
 *
 * We CATEGORIZE each emitted bracket and tally.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickProvider, type ProviderId } from './providers';

interface ArrayEntry {
  id: string;
  displayName: string;
  description: string;
  itemFields: Array<{ name: string; type: string }>;
}

const CATALOG: ArrayEntry[] = [
  { id: 'stocks', displayName: 'STOCKS', description: "user's watched stocks",
    itemFields: [
      { name: 'ticker', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'price', type: 'number' },
      { name: 'change', type: 'number' },
    ] },
  { id: 'emails', displayName: 'EMAILS', description: "user's recent emails",
    itemFields: [
      { name: 'from', type: 'string' },
      { name: 'subject', type: 'string' },
      { name: 'time', type: 'string' },
    ] },
  { id: 'news', displayName: 'NEWS', description: 'recent top headlines',
    itemFields: [
      { name: 'title', type: 'string' },
      { name: 'url', type: 'string' },
      { name: 'source', type: 'string' },
    ] },
];

interface OpCase {
  id: string;
  prompt: string;
  op: 'first' | 'last' | 'nth' | 'length' | 'slice' | 'reverse' | 'sort'
     | 'filter' | 'map' | 'reduce' | 'find' | 'includes' | 'any' | 'join';
  expectId: string;
}

const CASES: ReadonlyArray<OpCase> = [
  // first
  { id: 'f1', prompt: 'my top stock _', op: 'first', expectId: 'stocks' },
  { id: 'f2', prompt: 'top headline today _', op: 'first', expectId: 'news' },
  // last
  { id: 'l1', prompt: 'my latest email _', op: 'last', expectId: 'emails' },
  { id: 'l2', prompt: 'most recent news headline _', op: 'last', expectId: 'news' },
  // nth
  { id: 'n1', prompt: 'the 3rd news headline today _', op: 'nth', expectId: 'news' },
  // length
  { id: 'len1', prompt: 'how many emails do i have _', op: 'length', expectId: 'emails' },
  { id: 'len2', prompt: 'number of stocks im watching _', op: 'length', expectId: 'stocks' },
  // slice
  { id: 'sl1', prompt: 'first 5 stocks _', op: 'slice', expectId: 'stocks' },
  { id: 'sl2', prompt: 'top 3 headlines _', op: 'slice', expectId: 'news' },
  // reverse
  { id: 'r1', prompt: 'stocks in reverse order _', op: 'reverse', expectId: 'stocks' },
  // sort
  { id: 'so1', prompt: 'stocks sorted by price _', op: 'sort', expectId: 'stocks' },
  { id: 'so2', prompt: 'newest emails first _', op: 'sort', expectId: 'emails' },
  // filter
  { id: 'fi1', prompt: 'stocks above $200 _', op: 'filter', expectId: 'stocks' },
  { id: 'fi2', prompt: 'emails about launch _', op: 'filter', expectId: 'emails' },
  // map (single field projection)
  { id: 'm1', prompt: 'just the tickers _', op: 'map', expectId: 'stocks' },
  // reduce
  { id: 'rd1', prompt: 'total of all stock prices _', op: 'reduce', expectId: 'stocks' },
  // find
  { id: 'fd1', prompt: 'find the email about launch _', op: 'find', expectId: 'emails' },
  // includes
  { id: 'in1', prompt: 'do i have an email about launch _', op: 'includes', expectId: 'emails' },
  // any
  { id: 'an1', prompt: 'is there any stock above $500 _', op: 'any', expectId: 'stocks' },
  // join
  { id: 'j1', prompt: 'comma-separated tickers _', op: 'join', expectId: 'stocks' },
];

function renderCatalog(): string {
  const lines = CATALOG.map(e =>
    `- [${e.displayName}: array<{${e.itemFields.map(f => `${f.name}: ${f.type}`).join(', ')}}>] — ${e.description}`,
  ).join('\n');
  return `AVAILABLE CONTEXT — each entry returns an array of structured items.

${lines}

You may pluck fields, take elements, filter, sort, etc — use whatever syntax feels natural; the runtime is generous.`;
}

function buildSystem(): string {
  return `You read a user's text containing an underscore (\`_\`) and emit bracketed context tokens. The runtime substitutes real values after your response.

Output the user's text with tokens spliced in. DO NOT explain.

${renderCatalog()}`;
}

interface Observation {
  caseId: string;
  op: OpCase['op'];
  prompt: string;
  output: string;
  /** All bracket tokens with their classification. */
  brackets: Array<{ raw: string; shape: string; hasFirst: boolean; hasLast: boolean; hasNth: boolean; hasLength: boolean; hasMap: boolean; hasFilter: boolean; hasSort: boolean; hasReverse: boolean; hasSlice: boolean; hasFind: boolean; hasJoin: boolean; }>;
  /** Did model emit ANY token referencing the expected catalog entry? */
  emittedExpected: boolean;
}

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

function classifyBracket(raw: string, inner: string) {
  const i = inner;
  const tags: Record<string, boolean> = {
    hasFirst: /\.first\b|^first\(|\| ?first/.test(i),
    hasLast: /\.last\b|^last\(|\| ?last/.test(i),
    hasNth: /\[\d+\]|\.nth\(|\.at\(/.test(i),
    hasLength: /\.length\b|\.count\b|\.size\b/.test(i),
    hasMap: /\.map\(|\| ?map/.test(i),
    hasFilter: /\.filter\(|\| ?filter|=\s*['"]/.test(i),
    hasSort: /\.sort\(|\| ?sort/.test(i),
    hasReverse: /\.reverse\(|\| ?reverse/.test(i),
    hasSlice: /\.slice\(/.test(i),
    hasFind: /\.find\(|\| ?find/.test(i),
    hasJoin: /\.join\(|\| ?join/.test(i),
  };
  let shape = 'bare';
  if (/\.[A-Za-z]+\(/.test(i)) shape = 'method-call';
  else if (/\|/.test(i)) shape = 'pipe-form';
  else if (/\{[^}]+\}/.test(i)) shape = 'brace-projection';
  else if (/:[^=]/.test(i) && !i.includes('=')) shape = 'colon-spec';
  else if (/\.\w+(\.\w+)*$/.test(i)) shape = 'dotted-chain';
  else if (/\[\d+\]/.test(i)) shape = 'index-access';
  return { shape, ...tags };
}

async function main() {
  const args = (() => {
    const out = { provider: 'cerebras' as ProviderId, parallel: 6 };
    for (let i = 2; i < process.argv.length; i++) {
      const a = process.argv[i];
      if (a === '--provider') out.provider = process.argv[++i] as ProviderId;
      else if (a === '--parallel') out.parallel = parseInt(process.argv[++i]!, 10);
    }
    return out;
  })();
  const provider = pickProvider(args.provider);
  console.log(`\nUniversal-ops probe`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})`);
  console.log(`Cases: ${CASES.length} across ${new Set(CASES.map(c => c.op)).size} operations\n`);

  const runId = `universal-ops-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });

  const system = buildSystem();
  const obs: Observation[] = new Array(CASES.length);
  let i = 0;
  process.stdout.write(`  Running...  `);
  const t0 = Date.now();
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= CASES.length) return;
      const c = CASES[idx]!;
      const messages = provider.sysUser(system, c.prompt);
      try {
        const out = await provider.chat(messages, { temperature: 0, seed: 42, maxTokens: 512 });
        const brackets = topLevelBrackets(out.text).map(b => ({ raw: b.raw, ...classifyBracket(b.raw, b.inner) }));
        const expectName = CATALOG.find(e => e.id === c.expectId)?.displayName;
        const emittedExpected = brackets.some(b => expectName && b.raw.includes(expectName));
        obs[idx] = { caseId: c.id, op: c.op, prompt: c.prompt, output: out.text, brackets, emittedExpected };
      } catch (err) {
        obs[idx] = { caseId: c.id, op: c.op, prompt: c.prompt, output: `<error: ${String(err)}>`, brackets: [], emittedExpected: false };
      }
    }
  }
  await Promise.all(Array.from({ length: args.parallel }, () => worker()));
  console.log(`done (${((Date.now() - t0)/1000).toFixed(1)}s)`);
  console.log('');

  // Per-op breakdown
  const opOutputs: Record<string, string[]> = {};
  for (const o of obs) {
    opOutputs[o.op] = opOutputs[o.op] ?? [];
    opOutputs[o.op]!.push(`${o.caseId}: "${o.prompt}" → ${o.output.replace(/\s+/g, ' ')}`);
  }

  // Shape distribution
  const shapeCounts: Record<string, number> = {};
  for (const o of obs) {
    for (const b of o.brackets) {
      shapeCounts[b.shape] = (shapeCounts[b.shape] ?? 0) + 1;
    }
  }
  // Op-affordance counts
  const affCounts: Record<string, number> = {
    'has-first': 0, 'has-last': 0, 'has-nth-or-index': 0, 'has-length-count-size': 0,
    'has-map': 0, 'has-filter-equals': 0, 'has-sort': 0, 'has-reverse': 0,
    'has-slice': 0, 'has-find': 0, 'has-join': 0,
  };
  for (const o of obs) {
    for (const b of o.brackets) {
      if (b.hasFirst) affCounts['has-first']!++;
      if (b.hasLast) affCounts['has-last']!++;
      if (b.hasNth) affCounts['has-nth-or-index']!++;
      if (b.hasLength) affCounts['has-length-count-size']!++;
      if (b.hasMap) affCounts['has-map']!++;
      if (b.hasFilter) affCounts['has-filter-equals']!++;
      if (b.hasSort) affCounts['has-sort']!++;
      if (b.hasReverse) affCounts['has-reverse']!++;
      if (b.hasSlice) affCounts['has-slice']!++;
      if (b.hasFind) affCounts['has-find']!++;
      if (b.hasJoin) affCounts['has-join']!++;
    }
  }

  // Audit log
  const lines: string[] = [];
  lines.push(`# universal-ops × ${provider.id} (${provider.modelLabel})`);
  lines.push('');
  lines.push(`# Shape distribution across emitted brackets:`);
  for (const [shape, n] of Object.entries(shapeCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`#   ${shape.padEnd(20)} ${n}`);
  }
  lines.push('');
  lines.push(`# Op affordances detected (lower-level features the model reached for):`);
  for (const [k, n] of Object.entries(affCounts).sort((a, b) => b[1] - a[1])) {
    if (n > 0) lines.push(`#   ${k.padEnd(28)} ${n}`);
  }
  lines.push('');
  // Per-op outputs
  for (const [op, outs] of Object.entries(opOutputs)) {
    lines.push(`── op: ${op} ──`);
    for (const s of outs) lines.push(s);
    lines.push('');
  }
  fs.writeFileSync(path.join(outDir, `audit.log`), lines.join('\n'));

  console.log('Shape distribution:');
  for (const [shape, n] of Object.entries(shapeCounts).sort((a, b) => b[1] - a[1])) {
    if (n === 0) continue;
    console.log(`  ${shape.padEnd(20)} ${n}`);
  }
  console.log('');
  console.log('Op affordances reached for:');
  for (const [k, n] of Object.entries(affCounts).sort((a, b) => b[1] - a[1])) {
    if (n === 0) continue;
    console.log(`  ${k.padEnd(28)} ${n}`);
  }
  console.log('');

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    shapeCounts,
    affordanceCounts: affCounts,
    cases: obs.map(o => ({
      caseId: o.caseId,
      op: o.op,
      prompt: o.prompt,
      output: o.output,
      brackets: o.brackets.map(b => b.raw),
    })),
  }, null, 2));
  console.log(`Summary: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
