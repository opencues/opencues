/**
 * Array deep-dive probe.
 *
 * Tests the model's behaviour on the 6 most common array dimensions:
 *
 *   cardinality-explicit   user states a count: "top 5 news"
 *   cardinality-implicit   user implies a count: "a few news", "couple of stories"
 *   cardinality-unspecified user gives no count: "headlines"
 *   filter                  user wants a subset: "tech news", "emails from boss"
 *   sort                    user wants ordering: "most popular HN", "newest emails first"
 *   aggregation             user wants a count/sum: "count of recent emails"
 *   element-access          user wants one item: "the first HN story", "top headline"
 *
 * Two catalog variants:
 *
 *   FULL — every array entry has (limit, filter, sort) params + a
 *          `first(n)` accessor. The model has every capability available.
 *
 *   NARROW — every array entry has ONLY `limit`. Same prompts.
 *            Filter / sort / element-access prompts force a choice:
 *            invent params (fabrication), bail, or settle for a
 *            broader sentinel that ignores the user's intent.
 *
 * Six axes scored per case (binary 0/1):
 *
 *   selection      right entry id chosen?
 *   limit-ok       limit param matches expected (when expected)
 *   no-fabrication zero invented param keys
 *   bail-when-stuck did the model BAIL on the narrow catalog when it
 *                  couldn't express user intent? (the GOOD behaviour
 *                  — emitting a wrong-default sentinel is worse than
 *                  bailing for downstream UX)
 *   format         emitted a parseable bracket
 *   overall        mean of the 5 axes above
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickProvider, type ProviderId } from './providers';

// ────────────────────────────────────────────────────────────────────
// Catalogs
// ────────────────────────────────────────────────────────────────────

interface ArrayEntry {
  id: string;
  displayName: string;
  description: string;
  /** What the model can pass — full or narrow. */
  params: Array<{ name: string; type: string; doc: string }>;
  returnsItem: string; // pretty-printed item shape
  /** Whether this entry also offers `.first(n)` / `[n]` access. */
  supportsElement?: boolean;
  fields?: Array<{ name: string; type: string }>;
}

const ARRAY_FULL: ArrayEntry[] = [
  {
    id: 'news', displayName: 'NEWS',
    description: 'recent top headlines',
    returnsItem: 'string',
    params: [
      { name: 'limit', type: 'number', doc: 'how many items (default 5)' },
      { name: 'filter', type: 'string', doc: 'topic keyword filter, e.g. "tech", "politics", or null for any' },
      { name: 'sort', type: '"newest" | "trending"', doc: '"newest" = chronological, "trending" = by engagement (default)' },
    ],
    supportsElement: true,
  },
  {
    id: 'hackernews', displayName: 'HACKERNEWS',
    description: 'top stories from Hacker News right now',
    returnsItem: '{title: string, url: string, points: number}',
    params: [
      { name: 'limit', type: 'number', doc: 'how many items (default 10)' },
      { name: 'sort', type: '"top" | "newest"', doc: '"top" = highest points (default), "newest" = chronological' },
    ],
    supportsElement: true,
    fields: [
      { name: 'title', type: 'string' },
      { name: 'url', type: 'string' },
      { name: 'points', type: 'number' },
    ],
  },
  {
    id: 'recent-emails', displayName: 'RECENT EMAILS',
    description: "the user's most recent emails",
    returnsItem: '{from: string, subject: string, time: string}',
    params: [
      { name: 'limit', type: 'number', doc: 'how many (default 5)' },
      { name: 'filter', type: 'string', doc: 'sender or subject substring; null for any' },
      { name: 'sort', type: '"newest" | "unread"', doc: '"newest" (default) or unread-first' },
    ],
    supportsElement: true,
    fields: [
      { name: 'from', type: 'string' },
      { name: 'subject', type: 'string' },
      { name: 'time', type: 'string' },
    ],
  },
];

const ARRAY_NARROW: ArrayEntry[] = ARRAY_FULL.map(e => ({
  ...e,
  params: e.params.filter(p => p.name === 'limit'),
  supportsElement: false,
}));

// Identity scalar — used as composition target in nested cases (which
// we test separately; arrays don't need it but the prompt shape
// occasionally pulls one in for context).
const IDENTITY = [
  { id: 'first-name', displayName: 'FIRST NAME', description: 'the user’s first name' },
];

// ────────────────────────────────────────────────────────────────────
// Cases
// ────────────────────────────────────────────────────────────────────

type Dim =
  | 'cardinality-explicit'
  | 'cardinality-implicit'
  | 'cardinality-unspecified'
  | 'filter'
  | 'sort'
  | 'aggregation'
  | 'element-access';

interface ArrayCase {
  id: string;
  prompt: string;
  dim: Dim;
  expectId: string;
  /** Expected limit (when applicable). Undefined = no specific
   *  limit, model should omit OR pass null. */
  expectLimit?: number;
  /** For filter/sort cases — what arg the model SHOULD pass when
   *  the catalog exposes that param. Used in FULL catalog scoring;
   *  ignored in NARROW. */
  expectFilter?: string;
  expectSort?: string;
  /** For element-access cases — whether model should emit `.first`,
   *  `[0]`, or similar. Used in FULL catalog scoring. */
  expectElement?: boolean;
  /** When true, the case is genuinely satisfiable with the broader
   *  (no-filter, no-sort) version — narrow catalog can still pass
   *  with a slightly degraded answer. */
  satisfiableInNarrow: boolean;
}

const CASES: ReadonlyArray<ArrayCase> = [
  // ─── cardinality-explicit (7) ────────────────────────────────────
  { id: 'ce1', prompt: 'just 1 headline _', dim: 'cardinality-explicit',
    expectId: 'news', expectLimit: 1, satisfiableInNarrow: true },
  { id: 'ce2', prompt: 'top 3 hn _', dim: 'cardinality-explicit',
    expectId: 'hackernews', expectLimit: 3, satisfiableInNarrow: true },
  { id: 'ce3', prompt: 'top 5 headlines _', dim: 'cardinality-explicit',
    expectId: 'news', expectLimit: 5, satisfiableInNarrow: true },
  { id: 'ce4', prompt: 'top 10 stories on hn _', dim: 'cardinality-explicit',
    expectId: 'hackernews', expectLimit: 10, satisfiableInNarrow: true },
  { id: 'ce5', prompt: 'first 25 recent emails _', dim: 'cardinality-explicit',
    expectId: 'recent-emails', expectLimit: 25, satisfiableInNarrow: true },
  { id: 'ce6', prompt: '7 most recent emails _', dim: 'cardinality-explicit',
    expectId: 'recent-emails', expectLimit: 7, satisfiableInNarrow: true },
  { id: 'ce7', prompt: 'show me 100 headlines _', dim: 'cardinality-explicit',
    expectId: 'news', expectLimit: 100, satisfiableInNarrow: true },

  // ─── cardinality-implicit (4) ────────────────────────────────────
  // "a few", "several", "handful" — should model invent a number or omit?
  { id: 'ci1', prompt: 'a few headlines _', dim: 'cardinality-implicit',
    expectId: 'news', expectLimit: undefined, satisfiableInNarrow: true },
  { id: 'ci2', prompt: 'several recent emails _', dim: 'cardinality-implicit',
    expectId: 'recent-emails', expectLimit: undefined, satisfiableInNarrow: true },
  { id: 'ci3', prompt: 'a handful of hn stories _', dim: 'cardinality-implicit',
    expectId: 'hackernews', expectLimit: undefined, satisfiableInNarrow: true },
  { id: 'ci4', prompt: 'a couple of news items _', dim: 'cardinality-implicit',
    expectId: 'news', expectLimit: undefined, satisfiableInNarrow: true },

  // ─── cardinality-unspecified (3) ─────────────────────────────────
  { id: 'cu1', prompt: 'headlines _', dim: 'cardinality-unspecified',
    expectId: 'news', expectLimit: undefined, satisfiableInNarrow: true },
  { id: 'cu2', prompt: 'recent emails _', dim: 'cardinality-unspecified',
    expectId: 'recent-emails', expectLimit: undefined, satisfiableInNarrow: true },
  { id: 'cu3', prompt: "today's hn _", dim: 'cardinality-unspecified',
    expectId: 'hackernews', expectLimit: undefined, satisfiableInNarrow: true },

  // ─── filter (5) ──────────────────────────────────────────────────
  { id: 'f1', prompt: 'top 5 tech news _', dim: 'filter',
    expectId: 'news', expectLimit: 5, expectFilter: 'tech', satisfiableInNarrow: false },
  { id: 'f2', prompt: 'recent ai-related headlines _', dim: 'filter',
    expectId: 'news', expectFilter: 'ai', satisfiableInNarrow: false },
  { id: 'f3', prompt: 'emails from boss _', dim: 'filter',
    expectId: 'recent-emails', expectFilter: 'boss', satisfiableInNarrow: false },
  { id: 'f4', prompt: 'emails about the launch _', dim: 'filter',
    expectId: 'recent-emails', expectFilter: 'launch', satisfiableInNarrow: false },
  { id: 'f5', prompt: 'politics news today _', dim: 'filter',
    expectId: 'news', expectFilter: 'politics', satisfiableInNarrow: false },

  // ─── sort (4) ─────────────────────────────────────────────────────
  { id: 's1', prompt: 'newest hn stories _', dim: 'sort',
    expectId: 'hackernews', expectSort: 'newest', satisfiableInNarrow: false },
  { id: 's2', prompt: 'most popular hn right now _', dim: 'sort',
    expectId: 'hackernews', expectSort: 'top', satisfiableInNarrow: true },  // 'top' is default
  { id: 's3', prompt: 'unread emails _', dim: 'sort',
    expectId: 'recent-emails', expectSort: 'unread', satisfiableInNarrow: false },
  { id: 's4', prompt: 'newest emails first _', dim: 'sort',
    expectId: 'recent-emails', expectSort: 'newest', satisfiableInNarrow: true },  // 'newest' is default

  // ─── aggregation (3) — should NOT pick array sentinel ─────────────
  // These ask for a count/sum, not the array. Catalog has no
  // "count of emails" entry. Model should bail or emit prose.
  { id: 'a1', prompt: 'how many recent emails do i have _', dim: 'aggregation',
    expectId: '', satisfiableInNarrow: false },
  { id: 'a2', prompt: 'count of unread emails _', dim: 'aggregation',
    expectId: '', satisfiableInNarrow: false },
  { id: 'a3', prompt: 'number of headlines today _', dim: 'aggregation',
    expectId: '', satisfiableInNarrow: false },

  // ─── element-access (5) ──────────────────────────────────────────
  // User wants one item, not the array. FULL catalog has
  // .first/[0]; NARROW does not.
  { id: 'e1', prompt: 'the top story on hn _', dim: 'element-access',
    expectId: 'hackernews', expectElement: true, satisfiableInNarrow: false },
  { id: 'e2', prompt: 'first headline today _', dim: 'element-access',
    expectId: 'news', expectElement: true, satisfiableInNarrow: false },
  { id: 'e3', prompt: 'latest email subject _', dim: 'element-access',
    expectId: 'recent-emails', expectElement: true, satisfiableInNarrow: false },
  { id: 'e4', prompt: 'top headline _', dim: 'element-access',
    expectId: 'news', expectElement: true, satisfiableInNarrow: false },
  { id: 'e5', prompt: 'who sent my latest email _', dim: 'element-access',
    expectId: 'recent-emails', expectElement: true, satisfiableInNarrow: false },
];

// ────────────────────────────────────────────────────────────────────
// Renderers — pick one parameterized-style language (the winner from
// pass 1 + 2). All probes go through this one.
// ────────────────────────────────────────────────────────────────────

function renderArrayEntry(e: ArrayEntry): string {
  const paramSig = e.params.map(p => `${p.name}: ${p.type}`).join(', ');
  const sig = paramSig ? `(${paramSig})` : '';
  const arr = `array<${e.returnsItem}>`;
  const lines = [`- [${e.displayName}${sig}: ${arr}] — ${e.description}`];
  for (const p of e.params) {
    lines.push(`    ${p.name}: ${p.doc}`);
  }
  if (e.supportsElement) {
    lines.push(`    accessor .first → first element only; .first(n) → first n items inline`);
  }
  if (e.fields) {
    lines.push(`    accessor .<field> on returned items: ${e.fields.map(f => `.${f.name}: ${f.type}`).join(', ')}`);
  }
  return lines.join('\n');
}

function renderCatalog(entries: ArrayEntry[], idents: typeof IDENTITY): string {
  const arrayBlock = entries.map(renderArrayEntry).join('\n');
  const identBlock = idents.map(i => `- [${i.displayName}: string] — ${i.description}`).join('\n');
  return `AVAILABLE FUNCTIONS — typed catalog with parameter signatures.

To use a function, emit a token of the form [NAME(arg1=value1, arg2=value2)].
For scalars (no params), just [NAME].
For element access: [NAME(...).first] or [NAME(...).first(n)] when supported.

The runtime substitutes the resolved value AFTER your response.

${arrayBlock}

${identBlock}`;
}

function buildSystem(entries: ArrayEntry[]): string {
  return `You read a user's text containing an underscore (\`_\`) and decide what TOKENS to emit so the runtime can substitute real data values.

Output the user's text with tokens spliced in where appropriate. DO NOT explain, DO NOT add commentary. If NO catalog token fits the user's request, output the text verbatim — no brackets.

${renderCatalog(entries, IDENTITY)}

Example output: "Top 3 headlines today: [NEWS(limit=3)]. Posted by [FIRST NAME]."`;
}

// ────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────

interface Parsed {
  id: string | null;
  raw: string;
  params: Record<string, string>;
  accessor: string | null;        // 'first' / 'first(3)' / 'title' / null
  accessorArg: string | null;     // numeric arg inside accessor
}

function splitKwArgs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body.trim()) return out;
  // simple comma-split honoring quoted strings
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
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      const eq = cur.indexOf('=');
      if (eq >= 0) {
        const k = cur.slice(0, eq).trim();
        let v = cur.slice(eq + 1).trim();
        v = v.replace(/^["']|["']$/g, '');
        out[k] = v;
      }
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) {
    const eq = cur.indexOf('=');
    if (eq >= 0) {
      const k = cur.slice(0, eq).trim();
      let v = cur.slice(eq + 1).trim();
      v = v.replace(/^["']|["']$/g, '');
      out[k] = v;
    }
  }
  return out;
}

function parse(output: string, catalog: ArrayEntry[], idents: typeof IDENTITY): Parsed[] {
  const re = /\[([^\[\]]+?)\]/g;
  const out: Parsed[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const raw = m[0]!;
    const inner = m[1]!;
    if (!/[A-Za-z]/.test(inner)) continue;
    // Tokenize: NAME[(args)][.accessor[(arg)]]
    const t = inner.trim();
    let baseName: string;
    let argBody = '';
    let accessor: string | null = null;
    let accessorArg: string | null = null;
    const lparen = t.indexOf('(');
    if (lparen < 0) {
      // No args. Maybe ".accessor"
      const dot = t.indexOf('.');
      if (dot >= 0) {
        baseName = t.slice(0, dot).trim();
        accessor = t.slice(dot + 1).trim();
      } else {
        baseName = t;
      }
    } else {
      baseName = t.slice(0, lparen).trim();
      // find matching ')'
      let depth = 1;
      let j = lparen + 1;
      for (; j < t.length; j++) {
        if (t[j] === '(') depth++;
        else if (t[j] === ')') { depth--; if (depth === 0) break; }
      }
      argBody = t.slice(lparen + 1, j);
      const rest = t.slice(j + 1).trim();
      if (rest.startsWith('.')) {
        const acc = rest.slice(1);
        // acc may itself have `(arg)`
        const aL = acc.indexOf('(');
        if (aL >= 0) {
          accessor = acc.slice(0, aL).trim();
          const aR = acc.lastIndexOf(')');
          accessorArg = aR > aL ? acc.slice(aL + 1, aR).trim() : null;
        } else {
          accessor = acc;
        }
      }
    }
    // Strip optional ": type"
    const colon = baseName.indexOf(':');
    if (colon >= 0) baseName = baseName.slice(0, colon).trim();
    const ent = catalog.find(e => e.displayName === baseName)
      ?? idents.find(i => i.displayName === baseName);
    const params = splitKwArgs(argBody);
    out.push({
      id: ent ? ent.id : null,
      raw, params, accessor, accessorArg,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Grader
// ────────────────────────────────────────────────────────────────────

interface ArrayScore {
  caseId: string;
  dim: Dim;
  prompt: string;
  output: string;
  parsed: Parsed[];
  selectionHit: 0 | 1;
  limitOk: 0 | 1;
  noFabrication: 0 | 1;
  bailedAppropriately: 0 | 1;
  formatOk: 0 | 1;
  overall: number;
  notes: string[];
}

function gradeCase(
  c: ArrayCase,
  parsed: Parsed[],
  catalog: ArrayEntry[],
  catalogIsNarrow: boolean,
): ArrayScore {
  const notes: string[] = [];
  const expectsEntry = c.expectId !== '';
  const matched = c.expectId ? parsed.find(p => p.id === c.expectId) : undefined;

  // ─── Selection ────────────────────────────────────────────────
  let selectionHit: 0 | 1 = 0;
  if (!expectsEntry) {
    // Aggregation cases: the GOOD answer is no sentinel emitted (or
    // a sentinel that's clearly a creative bail). Score 1 when model
    // emitted no array sentinel; 0 if it emitted one anyway.
    const emittedArray = parsed.some(p => catalog.some(e => e.id === p.id));
    selectionHit = emittedArray ? 0 : 1;
    if (emittedArray) notes.push(`aggregation case: model emitted array sentinel ${parsed.find(p => p.id)?.id}`);
  } else {
    selectionHit = matched ? 1 : 0;
    if (!matched) notes.push(`miss: expected ${c.expectId}, got [${parsed.map(p => p.id).join(',')}]`);
  }

  // ─── Limit-ok ─────────────────────────────────────────────────
  let limitOk: 0 | 1 = 1;
  if (matched && c.expectLimit !== undefined) {
    const got = matched.params['limit'];
    limitOk = (got !== undefined && parseInt(got, 10) === c.expectLimit) ? 1 : 0;
    if (!limitOk) notes.push(`limit mismatch: want ${c.expectLimit}, got ${got ?? 'omitted'}`);
  } else if (matched && c.expectLimit === undefined) {
    // limit should be absent — accept any value, just check no contradiction
    limitOk = 1;
  }

  // ─── No-fabrication: count keys NOT in catalog signature ─────
  let noFabrication: 0 | 1 = 1;
  for (const p of parsed) {
    if (!p.id) continue;
    const ent = catalog.find(e => e.id === p.id);
    if (!ent) continue;
    const allowed = ent.params.map(x => x.name);
    for (const k of Object.keys(p.params)) {
      if (!allowed.includes(k)) {
        noFabrication = 0;
        notes.push(`fabricated param: ${ent.displayName}(${k}=${p.params[k]}) [allowed: ${allowed.join(',') || 'none'}]`);
      }
    }
    // Accessor check — only `.first` / `.first(N)` valid if e.supportsElement.
    // Field accessors (e.fields) also valid.
    if (p.accessor) {
      const validAccessors = new Set<string>();
      if (ent.supportsElement) validAccessors.add('first');
      if (ent.fields) for (const f of ent.fields) validAccessors.add(f.name);
      if (!validAccessors.has(p.accessor)) {
        noFabrication = 0;
        notes.push(`fabricated accessor: .${p.accessor}${p.accessorArg ? `(${p.accessorArg})` : ''} on ${ent.displayName}`);
      }
    }
  }

  // ─── Bail when stuck (NARROW only) ───────────────────────────
  let bailedAppropriately: 0 | 1 = 1;
  if (catalogIsNarrow && expectsEntry && !c.satisfiableInNarrow) {
    // The GOOD outcomes:
    //   (a) bailed (no sentinel emitted at all)
    //   (b) emitted with no fabricated params (acceptable — runtime
    //       returns degraded results; user sees "all news" not "tech
    //       news" but no corruption)
    // The BAD outcome:
    //   (c) fabricated a param to express the user's intent
    if (noFabrication === 0) {
      bailedAppropriately = 0;
      // notes already added above
    } else {
      bailedAppropriately = 1;
    }
  }

  // ─── Format ──────────────────────────────────────────────────
  const formatOk: 0 | 1 = parsed.length === 0 || parsed.every(p => p.id !== null) ? 1 : 0;

  const overall = (selectionHit + limitOk + noFabrication + bailedAppropriately + formatOk) / 5;
  return {
    caseId: c.id, dim: c.dim, prompt: c.prompt, output: '',
    parsed, selectionHit, limitOk, noFabrication, bailedAppropriately,
    formatOk, overall, notes,
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

async function runVariant(
  provider: ReturnType<typeof pickProvider>,
  variant: 'FULL' | 'NARROW',
  parallel: number,
): Promise<ArrayScore[]> {
  const catalog = variant === 'FULL' ? ARRAY_FULL : ARRAY_NARROW;
  const system = buildSystem(catalog);
  const scores: ArrayScore[] = new Array(CASES.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= CASES.length) return;
      const c = CASES[idx]!;
      const messages = provider.sysUser(system, c.prompt);
      let out: { text: string; latencyMs: number };
      try {
        out = await provider.chat(messages, { temperature: 0, seed: 42, maxTokens: 512 });
      } catch (err) {
        const s = gradeCase(c, [], catalog, variant === 'NARROW');
        s.output = `<error: ${String(err)}>`;
        scores[idx] = s;
        continue;
      }
      const parsed = parse(out.text, catalog, IDENTITY);
      const s = gradeCase(c, parsed, catalog, variant === 'NARROW');
      s.output = out.text;
      scores[idx] = s;
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return scores;
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

function summarize(scores: ArrayScore[]) {
  const n = scores.length;
  const mean = (k: keyof ArrayScore) => n === 0 ? 0 : scores.reduce((a, s) => a + (s[k] as number), 0) / n;
  return {
    n,
    selection: mean('selectionHit'),
    limit: mean('limitOk'),
    noFabrication: mean('noFabrication'),
    bailedAppropriately: mean('bailedAppropriately'),
    format: mean('formatOk'),
    overall: mean('overall'),
  };
}

function dimBreakdown(scores: ArrayScore[]) {
  const dims = ['cardinality-explicit', 'cardinality-implicit', 'cardinality-unspecified', 'filter', 'sort', 'aggregation', 'element-access'] as const;
  const out: Record<string, number> = {};
  for (const d of dims) {
    const subset = scores.filter(s => s.dim === d);
    out[d] = subset.length === 0 ? 0 : subset.reduce((a, s) => a + s.overall, 0) / subset.length;
  }
  return out;
}

function writeAudit(outDir: string, label: string, scores: ArrayScore[]) {
  const lines: string[] = [];
  lines.push(`# ${label}`);
  const sum = summarize(scores);
  lines.push(`# Overall: ${pct(sum.overall)}  selection=${pct(sum.selection)}  limit=${pct(sum.limit)}  noFab=${pct(sum.noFabrication)}  bail=${pct(sum.bailedAppropriately)}  fmt=${pct(sum.format)}`);
  lines.push('');
  for (const s of scores) {
    lines.push(`── ${s.caseId} [${s.dim}] ──`);
    lines.push(`PROMPT: ${s.prompt}`);
    lines.push(`OUTPUT: ${s.output}`);
    lines.push(`PARSED: ${JSON.stringify(s.parsed)}`);
    lines.push(`SCORE:  sel=${s.selectionHit} limit=${s.limitOk} noFab=${s.noFabrication} bail=${s.bailedAppropriately} fmt=${s.formatOk} overall=${pct(s.overall)}`);
    if (s.notes.length) lines.push(`NOTES:  ${s.notes.join('; ')}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(outDir, `${label}.log`), lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nArray deep-dive — ${CASES.length} cases × 7 dimensions × 2 catalogs`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})\n`);

  const runId = `array-deep-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Audit logs → ${outDir}\n`);

  // FULL catalog
  process.stdout.write(`  FULL    `);
  let t0 = Date.now();
  const fullScores = await runVariant(provider, 'FULL', args.parallel);
  let dt = ((Date.now() - t0) / 1000).toFixed(1);
  const fullSum = summarize(fullScores);
  console.log(`done (${dt}s, overall=${pct(fullSum.overall)})`);
  writeAudit(outDir, 'FULL', fullScores);

  // NARROW catalog
  process.stdout.write(`  NARROW  `);
  t0 = Date.now();
  const narrowScores = await runVariant(provider, 'NARROW', args.parallel);
  dt = ((Date.now() - t0) / 1000).toFixed(1);
  const narrowSum = summarize(narrowScores);
  console.log(`done (${dt}s, overall=${pct(narrowSum.overall)})`);
  writeAudit(outDir, 'NARROW', narrowScores);

  console.log('');
  console.log('Catalog │ Overall │ Sel     │ Limit   │ NoFab   │ Bailed  │ Format');
  console.log('────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────');
  for (const [label, sum] of [['FULL', fullSum], ['NARROW', narrowSum]] as const) {
    console.log(`${label.padEnd(7)} │ ${pct(sum.overall).padStart(7)} │ ${pct(sum.selection).padStart(7)} │ ${pct(sum.limit).padStart(7)} │ ${pct(sum.noFabrication).padStart(7)} │ ${pct(sum.bailedAppropriately).padStart(7)} │ ${pct(sum.format).padStart(7)}`);
  }
  console.log('');

  // Per-dimension breakdown
  console.log('Per-dimension overall:');
  const dims = ['cardinality-explicit', 'cardinality-implicit', 'cardinality-unspecified', 'filter', 'sort', 'aggregation', 'element-access'];
  console.log(`Catalog │ ${dims.map(d => d.padEnd(13)).join(' │ ')}`);
  console.log(`────────┼─${dims.map(() => '─'.repeat(13)).join('─┼─')}`);
  const fullDim = dimBreakdown(fullScores);
  const narrowDim = dimBreakdown(narrowScores);
  console.log(`FULL    │ ${dims.map(d => pct(fullDim[d]!).padEnd(13)).join(' │ ')}`);
  console.log(`NARROW  │ ${dims.map(d => pct(narrowDim[d]!).padEnd(13)).join(' │ ')}`);
  console.log('');

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    full: { overall: fullSum, byDim: fullDim },
    narrow: { overall: narrowSum, byDim: narrowDim },
  }, null, 2));
  console.log(`Summary: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
