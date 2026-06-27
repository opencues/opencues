/**
 * Field-access probe.
 *
 * Question: when one catalog entry returns a multi-field struct (e.g.
 * STOCK → {price, change, volume}, WEATHER → {temp, conditions, forecast}),
 * what syntax should the model use to pick out just one field?
 *
 * Four candidate syntaxes — all targeting THE SAME catalog entry (no
 * separate `stock-price` / `weather-temp` shortcuts; the model HAS to
 * extract a field):
 *
 *   A. dotted-token       [STOCK(ticker="NVDA").price]
 *   B. field-param        [STOCK(ticker="NVDA", field="price")]
 *   C. return-selector    [STOCK(ticker="NVDA"): price]
 *   D. separate-entries   [STOCK PRICE(ticker="NVDA")]   (baseline — 2× catalog size)
 *
 * Each language renders the SAME structured catalog differently and
 * parses output back accordingly.
 *
 * Cases focus on picking the right field:
 *   - "just the price of nvda _"   → field=price
 *   - "nvda change today _"        → field=change
 *   - "berlin temperature _"       → field=temp
 *   - "what's the forecast for london _" → field=forecast
 *   - "full nvda quote _"          → full struct (no field)
 *
 * Scoring axes:
 *   - selection (right entry chosen)
 *   - field-selection (right field chosen / OR full struct when wanted)
 *   - param-fill (ticker/city right)
 *   - format (parses cleanly)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickProvider, type ProviderId } from './providers';

// ────────────────────────────────────────────────────────────────────────
// Structured catalog (just the multi-field entries — that's what matters)
// ────────────────────────────────────────────────────────────────────────

interface StructEntry {
  id: string;
  displayName: string;
  description: string;
  params: Array<{ name: string; type: string }>;
  fields: Array<{ name: string; type: string; description: string }>;
}

const STRUCT_ENTRIES: StructEntry[] = [
  {
    id: 'stock',
    displayName: 'STOCK',
    description: 'a stock quote',
    params: [{ name: 'ticker', type: 'string' }],
    fields: [
      { name: 'price', type: 'number', description: 'current trading price (USD)' },
      { name: 'change', type: 'number', description: 'price change today (%)' },
      { name: 'volume', type: 'number', description: 'shares traded today' },
    ],
  },
  {
    id: 'weather',
    displayName: 'WEATHER',
    description: "a city's weather",
    params: [{ name: 'city', type: 'string' }],
    fields: [
      { name: 'temp', type: 'number', description: 'current temp (celsius)' },
      { name: 'conditions', type: 'string', description: 'one-line conditions ("cloudy", "raining")' },
      { name: 'forecast', type: 'string', description: 'short narrative for the rest of today' },
    ],
  },
];

const IDENTITY_SCALARS: Array<{ id: string; displayName: string; type: string; description: string }> = [
  { id: 'first-name', displayName: 'FIRST NAME', type: 'string', description: 'first name' },
  { id: 'email', displayName: 'EMAIL', type: 'string', description: 'primary email' },
];

// ────────────────────────────────────────────────────────────────────────
// Cases — same prompts across syntaxes; ground truth is { id, field?, params }.
// ────────────────────────────────────────────────────────────────────────

interface FieldCase {
  id: string;
  prompt: string;
  /** Expected catalog id. */
  expectId: string;
  /** Expected field accessor — undefined means full struct is expected. */
  expectField?: string;
  /** Expected params for the entry. */
  expectParams?: Record<string, string>;
}

const CASES: ReadonlyArray<FieldCase> = [
  // Stock — different fields ────────────────────────────────────────
  { id: 'sp1', prompt: 'just the price of nvda _',
    expectId: 'stock', expectField: 'price', expectParams: { ticker: 'NVDA' } },
  { id: 'sp2', prompt: 'aapl trading at _',
    expectId: 'stock', expectField: 'price', expectParams: { ticker: 'AAPL' } },
  { id: 'sc1', prompt: 'how much did nvda move today _',
    expectId: 'stock', expectField: 'change', expectParams: { ticker: 'NVDA' } },
  { id: 'sc2', prompt: 'tsla change today _',
    expectId: 'stock', expectField: 'change', expectParams: { ticker: 'TSLA' } },
  { id: 'sv1', prompt: 'nvda trading volume today _',
    expectId: 'stock', expectField: 'volume', expectParams: { ticker: 'NVDA' } },
  { id: 'sf1', prompt: 'full nvda quote _',
    expectId: 'stock', expectField: undefined, expectParams: { ticker: 'NVDA' } },

  // Weather — different fields ──────────────────────────────────────
  { id: 'wt1', prompt: 'temperature in london _',
    expectId: 'weather', expectField: 'temp', expectParams: { city: 'London' } },
  { id: 'wt2', prompt: 'how warm is it in paris _',
    expectId: 'weather', expectField: 'temp', expectParams: { city: 'Paris' } },
  { id: 'wc1', prompt: 'whats it like in tokyo _',
    expectId: 'weather', expectField: 'conditions', expectParams: { city: 'Tokyo' } },
  { id: 'wf1', prompt: 'london forecast for today _',
    expectId: 'weather', expectField: 'forecast', expectParams: { city: 'London' } },
  { id: 'wfull1', prompt: 'full berlin weather report _',
    expectId: 'weather', expectField: undefined, expectParams: { city: 'Berlin' } },

  // Mixed (a composition — identity + struct field)
  { id: 'mix1', prompt: 'reply from _ — nvda price is _',
    expectId: 'stock', expectField: 'price', expectParams: { ticker: 'NVDA' } },
];

// ────────────────────────────────────────────────────────────────────────
// Syntax renderers
// ────────────────────────────────────────────────────────────────────────

type SyntaxId = 'dotted' | 'field-param' | 'return-selector' | 'separate-entries';

interface Syntax {
  id: SyntaxId;
  renderCatalog(): string;
  example(): string;
  /** Pull (id, field?, params) triples from output text. */
  parse(output: string): Array<{ id: string | null; field: string | null; params: Record<string, string>; raw: string }>;
}

function paramSig(e: StructEntry): string {
  return e.params.map(p => `${p.name}: ${p.type}`).join(', ');
}

function fieldList(e: StructEntry): string {
  return e.fields.map(f => `${f.name}: ${f.type}`).join(', ');
}

// Generic bracket extractor
function extractBrackets(out: string): Array<{ raw: string; inner: string }> {
  const re = /\[([^\[\]]+?)\]/g;
  const list: Array<{ raw: string; inner: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    if (/[A-Za-z]/.test(m[1]!)) list.push({ raw: m[0]!, inner: m[1]! });
  }
  return list;
}

function splitKwArgs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body.trim()) return out;
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    v = v.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    out[k] = v;
  }
  return out;
}

// A. dotted-token
const DOTTED: Syntax = {
  id: 'dotted',
  renderCatalog() {
    const structs = STRUCT_ENTRIES.map(e =>
      `- [${e.displayName}(${paramSig(e)}): {${fieldList(e)}}] — ${e.description}\n    fields:\n${e.fields.map(f => `      .${f.name} → ${f.type} — ${f.description}`).join('\n')}`
    ).join('\n');
    const scalars = IDENTITY_SCALARS.map(s => `- [${s.displayName}: ${s.type}] — ${s.description}`).join('\n');
    return `AVAILABLE FUNCTIONS — emit either the full struct OR access a single field with a dot accessor:

  Full struct: [STOCK(ticker="NVDA")]      → {price, change, volume}
  Just one field: [STOCK(ticker="NVDA").price]   → number
  Scalar (no params): [EMAIL]

${structs}

${scalars}`;
  },
  example() { return `Example: "Hi [FIRST NAME], NVDA is at [STOCK(ticker=\"NVDA\").price] (volume [STOCK(ticker=\"NVDA\").volume])."`; },
  parse(output) {
    const out: ReturnType<Syntax['parse']> = [];
    for (const { raw, inner } of extractBrackets(output)) {
      // Try dotted form first: NAME(args).FIELD
      let m = /^([A-Z][A-Z\s]*?)\(([^)]*)\)\.(\w+)$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: m[3]!, params: splitKwArgs(m[2]!), raw });
        continue;
      }
      // Full-struct form: NAME(args)
      m = /^([A-Z][A-Z\s]*?)\(([^)]*)\)$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: null, params: splitKwArgs(m[2]!), raw });
        continue;
      }
      // Scalar form: NAME (no parens)
      m = /^([A-Z][A-Z\s]*?)(?:\s*:\s*\w+)?$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = IDENTITY_SCALARS.find(e => e.displayName === name)
          ?? STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: null, params: {}, raw });
        continue;
      }
      out.push({ id: null, field: null, params: {}, raw });
    }
    return out;
  },
};

// B. field-param
const FIELD_PARAM: Syntax = {
  id: 'field-param',
  renderCatalog() {
    const structs = STRUCT_ENTRIES.map(e => {
      const fieldsList = e.fields.map(f => `"${f.name}"`).join(' | ');
      return `- [${e.displayName}(${paramSig(e)}, field: ${fieldsList} | null)] — ${e.description}\n    field=null → full struct {${fieldList(e)}}; field=<name> → just that field's value`;
    }).join('\n');
    const scalars = IDENTITY_SCALARS.map(s => `- [${s.displayName}: ${s.type}] — ${s.description}`).join('\n');
    return `AVAILABLE FUNCTIONS — pick a single field with a \`field=\` argument; omit \`field=\` to get the full struct:

  Full struct: [STOCK(ticker="NVDA")]
  Just one field: [STOCK(ticker="NVDA", field="price")]
  Scalar (no params): [EMAIL]

${structs}

${scalars}`;
  },
  example() { return `Example: "NVDA is at [STOCK(ticker=\"NVDA\", field=\"price\")] today."`; },
  parse(output) {
    const out: ReturnType<Syntax['parse']> = [];
    for (const { raw, inner } of extractBrackets(output)) {
      let m = /^([A-Z][A-Z\s]*?)\(([^)]*)\)$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const args = splitKwArgs(m[2]!);
        const field = args.field ?? null;
        delete args.field;
        const entry = STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field, params: args, raw });
        continue;
      }
      m = /^([A-Z][A-Z\s]*?)(?:\s*:\s*\w+)?$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = IDENTITY_SCALARS.find(e => e.displayName === name)
          ?? STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: null, params: {}, raw });
        continue;
      }
      out.push({ id: null, field: null, params: {}, raw });
    }
    return out;
  },
};

// C. return-selector — `[STOCK(args): field]`
const RETURN_SELECTOR: Syntax = {
  id: 'return-selector',
  renderCatalog() {
    const structs = STRUCT_ENTRIES.map(e =>
      `- [${e.displayName}(${paramSig(e)})] returns {${fieldList(e)}} — ${e.description}`
    ).join('\n');
    const scalars = IDENTITY_SCALARS.map(s => `- [${s.displayName}: ${s.type}] — ${s.description}`).join('\n');
    return `AVAILABLE FUNCTIONS — to pick a single field, suffix the token with \`: <field>\`:

  Full struct: [STOCK(ticker="NVDA")]
  Just one field: [STOCK(ticker="NVDA"): price]
  Scalar: [EMAIL]

${structs}

${scalars}`;
  },
  example() { return `Example: "NVDA price is [STOCK(ticker=\"NVDA\"): price] today."`; },
  parse(output) {
    const out: ReturnType<Syntax['parse']> = [];
    for (const { raw, inner } of extractBrackets(output)) {
      // NAME(args): FIELD
      let m = /^([A-Z][A-Z\s]*?)\(([^)]*)\)\s*:\s*(\w+)$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: m[3]!, params: splitKwArgs(m[2]!), raw });
        continue;
      }
      // NAME(args)
      m = /^([A-Z][A-Z\s]*?)\(([^)]*)\)$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: null, params: splitKwArgs(m[2]!), raw });
        continue;
      }
      m = /^([A-Z][A-Z\s]*?)(?:\s*:\s*\w+)?$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = IDENTITY_SCALARS.find(e => e.displayName === name)
          ?? STRUCT_ENTRIES.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: null, params: {}, raw });
        continue;
      }
      out.push({ id: null, field: null, params: {}, raw });
    }
    return out;
  },
};

// D. separate-entries — baseline, today's production approach
const SEPARATE_ENTRIES: Syntax = {
  id: 'separate-entries',
  renderCatalog() {
    const lines: string[] = [];
    for (const e of STRUCT_ENTRIES) {
      // Full struct entry
      lines.push(`- [${e.displayName}(${paramSig(e)}): {${fieldList(e)}}] — ${e.description} (full quote)`);
      // One entry per field
      for (const f of e.fields) {
        lines.push(`- [${e.displayName} ${f.name.toUpperCase()}(${paramSig(e)}): ${f.type}] — ${f.description}`);
      }
    }
    const scalars = IDENTITY_SCALARS.map(s => `- [${s.displayName}: ${s.type}] — ${s.description}`).join('\n');
    return `AVAILABLE FUNCTIONS — each field has its own entry; pick the right one based on what the user wants:

${lines.join('\n')}

${scalars}`;
  },
  example() { return `Example: "NVDA is at [STOCK PRICE(ticker=\"NVDA\")] today."`; },
  parse(output) {
    const out: ReturnType<Syntax['parse']> = [];
    for (const { raw, inner } of extractBrackets(output)) {
      let m = /^([A-Z][A-Z\s]*?)\(([^)]*)\)$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        // Match: is this a per-field entry like "STOCK PRICE"?
        for (const e of STRUCT_ENTRIES) {
          for (const f of e.fields) {
            const compound = `${e.displayName} ${f.name.toUpperCase()}`;
            if (name === compound) {
              out.push({ id: e.id, field: f.name, params: splitKwArgs(m[2]!), raw });
              continue;
            }
          }
        }
        // Or the full-struct entry
        const struct = STRUCT_ENTRIES.find(e => e.displayName === name);
        if (struct) {
          out.push({ id: struct.id, field: null, params: splitKwArgs(m[2]!), raw });
          continue;
        }
        // Unknown
        if (!out.length || out[out.length - 1]!.raw !== raw) {
          out.push({ id: null, field: null, params: splitKwArgs(m[2]!), raw });
        }
        continue;
      }
      m = /^([A-Z][A-Z\s]*?)(?:\s*:\s*\w+)?$/.exec(inner.trim());
      if (m) {
        const name = m[1]!.trim();
        const entry = IDENTITY_SCALARS.find(e => e.displayName === name);
        out.push({ id: entry?.id ?? null, field: null, params: {}, raw });
        continue;
      }
      out.push({ id: null, field: null, params: {}, raw });
    }
    // Dedupe (struct-entry matcher may double-push)
    const seen = new Set<string>();
    return out.filter(p => {
      const k = p.raw + '|' + p.field;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
};

const SYNTAXES: Record<SyntaxId, Syntax> = {
  dotted: DOTTED,
  'field-param': FIELD_PARAM,
  'return-selector': RETURN_SELECTOR,
  'separate-entries': SEPARATE_ENTRIES,
};

const SYNTAX_IDS: ReadonlyArray<SyntaxId> = ['dotted', 'field-param', 'return-selector', 'separate-entries'];

// ────────────────────────────────────────────────────────────────────────
// Grader
// ────────────────────────────────────────────────────────────────────────

interface FieldScore {
  caseId: string;
  prompt: string;
  output: string;
  selectionHit: 0 | 1;
  fieldHit: 0 | 1;
  paramHit: 0 | 1;
  formatOk: 0 | 1;
  overall: number;
  parsed: ReturnType<Syntax['parse']>;
  notes: string[];
}

function norm(s: string): string { return s.trim().toLowerCase().replace(/[",.]/g, ''); }

function score(c: FieldCase, parsed: ReturnType<Syntax['parse']>): FieldScore {
  const notes: string[] = [];
  // Find best match: same id as expected
  const candidates = parsed.filter(p => p.id === c.expectId);
  let selectionHit: 0 | 1 = candidates.length > 0 ? 1 : 0;
  if (!selectionHit) notes.push(`miss-id: expected ${c.expectId}, got ${parsed.map(p => p.id).join(',')}`);
  let fieldHit: 0 | 1 = 0;
  let paramHit: 0 | 1 = 0;
  let formatOk: 0 | 1 = parsed.every(p => p.id !== null) ? 1 : 0;
  if (selectionHit) {
    const want = c.expectField ?? null;
    const got = candidates.find(p => (p.field ?? null) === want);
    fieldHit = got ? 1 : 0;
    if (!got) {
      notes.push(`miss-field: want ${want ?? '(none)'}, got ${candidates.map(p => p.field ?? '(none)').join(',')}`);
    }
    const winner = got ?? candidates[0]!;
    if (c.expectParams) {
      let ok = true;
      for (const [k, v] of Object.entries(c.expectParams)) {
        if (norm(v) !== norm(winner.params[k] ?? '')) { ok = false; break; }
      }
      paramHit = ok ? 1 : 0;
      if (!ok) notes.push(`miss-param: want ${JSON.stringify(c.expectParams)}, got ${JSON.stringify(winner.params)}`);
    } else {
      paramHit = 1;
    }
  } else {
    if (c.expectParams) paramHit = 0; else paramHit = 1;
  }
  const overall = (selectionHit + fieldHit + paramHit + formatOk) / 4;
  return { caseId: c.id, prompt: c.prompt, output: '', selectionHit, fieldHit, paramHit, formatOk, overall, parsed, notes };
}

// ────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const out = { provider: 'cerebras' as ProviderId, syntaxes: [...SYNTAX_IDS] as SyntaxId[], parallel: 6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i] as ProviderId;
    else if (a === '--syntax') out.syntaxes = [argv[++i] as SyntaxId];
    else if (a === '--parallel') out.parallel = parseInt(argv[++i]!, 10);
  }
  return out;
}

function buildSysPrompt(syn: Syntax): string {
  return `You read a user's text containing an underscore (\`_\`) and emit catalog tokens that the runtime will substitute with real data.

Output the user's text with tokens spliced in where the data should land. DO NOT explain. If no token fits, output the text verbatim.

${syn.renderCatalog()}

${syn.example()}`;
}

async function runCell(provider: ReturnType<typeof pickProvider>, syn: Syntax, parallel: number) {
  const system = buildSysPrompt(syn);
  const scores: FieldScore[] = new Array(CASES.length);
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
        const s = score(c, []);
        s.output = `<error: ${String(err)}>`;
        scores[idx] = s;
        continue;
      }
      const parsed = syn.parse(out.text);
      const s = score(c, parsed);
      s.output = out.text;
      scores[idx] = s;
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return scores;
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

async function main() {
  const args = parseArgs(process.argv);
  const provider = pickProvider(args.provider);
  console.log(`\nField-access probe — single STRUCT catalog per syntax`);
  console.log(`Provider: ${provider.id} (${provider.modelLabel})`);
  console.log(`Syntaxes: ${args.syntaxes.join(', ')}\n`);

  const runId = `field-access-${provider.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = path.resolve(__dirname, '../../results/typed-sentinel-language', runId);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Audit logs → ${outDir}\n`);

  const summaries: Record<SyntaxId, { sel: number; field: number; param: number; format: number; overall: number }> = {} as any;

  for (const synId of args.syntaxes) {
    const syn = SYNTAXES[synId];
    process.stdout.write(`  ${synId.padEnd(20)} `);
    const t0 = Date.now();
    const scores = await runCell(provider, syn, args.parallel);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const n = scores.length;
    const sel = scores.reduce((a, s) => a + s.selectionHit, 0) / n;
    const field = scores.reduce((a, s) => a + s.fieldHit, 0) / n;
    const param = scores.reduce((a, s) => a + s.paramHit, 0) / n;
    const format = scores.reduce((a, s) => a + s.formatOk, 0) / n;
    const overall = scores.reduce((a, s) => a + s.overall, 0) / n;
    summaries[synId] = { sel, field, param, format, overall };
    console.log(`done (${dt}s, overall=${pct(overall)})`);
    // Audit
    const lines: string[] = [];
    lines.push(`# ${synId} × ${provider.id} (${provider.modelLabel})`);
    lines.push(`# Overall: ${pct(overall)}`);
    lines.push('');
    for (const s of scores) {
      lines.push(`── ${s.caseId} ──`);
      lines.push(`PROMPT: ${s.prompt}`);
      lines.push(`OUTPUT: ${s.output}`);
      lines.push(`PARSED: ${JSON.stringify(s.parsed)}`);
      lines.push(`SCORE:  sel=${s.selectionHit} field=${s.fieldHit} param=${s.paramHit} fmt=${s.formatOk} overall=${pct(s.overall)}`);
      if (s.notes.length > 0) lines.push(`NOTES:  ${s.notes.join('; ')}`);
      lines.push('');
    }
    fs.writeFileSync(path.join(outDir, `${synId}.log`), lines.join('\n'));
  }

  console.log('');
  console.log('Syntax               │ Overall │ Sel     │ Field   │ Param   │ Format');
  console.log('─────────────────────┼─────────┼─────────┼─────────┼─────────┼─────────');
  for (const synId of args.syntaxes) {
    const s = summaries[synId]!;
    console.log(`${synId.padEnd(20)} │ ${pct(s.overall).padStart(7)} │ ${pct(s.sel).padStart(7)} │ ${pct(s.field).padStart(7)} │ ${pct(s.param).padStart(7)} │ ${pct(s.format).padStart(7)}`);
  }
  console.log('');

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    provider: provider.id,
    model: provider.modelLabel,
    syntaxes: args.syntaxes,
    summaries,
  }, null, 2));
  console.log(`Summary written: ${path.join(outDir, 'summary.json')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
