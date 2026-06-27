/**
 * Sentinel-language candidates. Each language pairs:
 *   - a `renderCatalog(catalog)` — formats entries into a system-prompt
 *     block the model can read.
 *   - a `parseSentinels(output)` — pulls the model's emitted sentinels
 *     back out, returning normalized `{ id, params }` triples the grader
 *     can match against ground truth.
 *
 * The four candidates probe different design axes:
 *
 *   BARE          — current production shape. No types, no params in
 *                   schema. Closest baseline; tells us if richer schemas
 *                   help at all.
 *
 *   TYPED_SCALAR  — bracket form with TS-like type annotations
 *                   (`[EMAIL: string]`, `[STOCK NVDA: number]`). Types
 *                   visible but parameters are embedded in the name
 *                   (still strings, the model just picks a literal).
 *
 *   PARAMETERIZED — function-call shape with input/output type signatures
 *                   (`[STOCK(ticker: string): {price, change}]`). The
 *                   model picks the function AND fills the arg.
 *                   This is the most expressive variant.
 *
 *   NATURAL       — verb-prefixed English (`[GET email]`, `[LOOKUP stock
 *                   NVDA]`, `[LIST news 5]`). Easier to read; tests
 *                   whether models perform better when the schema looks
 *                   like instructions instead of code.
 */

import type { CatalogEntry, ScalarReturn, StructReturn, ArrayReturn } from './catalog';

export type LanguageId = 'bare' | 'typed-scalar' | 'parameterized' | 'natural' | 'json-call' | 'hybrid';

export const LANGUAGE_IDS: ReadonlyArray<LanguageId> = ['bare', 'typed-scalar', 'parameterized', 'natural', 'json-call', 'hybrid'];

export interface ParsedSentinel {
  /** Matched catalog id, or null if no catalog entry matched (a
   *  hallucinated bracket). */
  id: string | null;
  /** Raw bracketed token the LLM emitted, kept for debugging. */
  raw: string;
  /** Parameter values the LLM filled, keyed by param name. Empty
   *  when parsing couldn't extract any. */
  params: Record<string, string>;
}

export interface Language {
  id: LanguageId;
  /** Build the catalog block injected into the system prompt. */
  renderCatalog(catalog: ReadonlyArray<CatalogEntry>): string;
  /** Show the model an example output using this language's shape, so
   *  it knows what the runtime expects to parse. */
  exampleUsage(catalog: ReadonlyArray<CatalogEntry>): string;
  /** Pull sentinels back out of LLM output. */
  parseSentinels(output: string, catalog: ReadonlyArray<CatalogEntry>): ParsedSentinel[];
}

// ────────────────────────────────────────────────────────────────────────
// Helpers shared across renderers
// ────────────────────────────────────────────────────────────────────────

function renderReturnType(r: ScalarReturn | StructReturn | ArrayReturn): string {
  if (typeof r === 'string') return r; // 'string' | 'number' | 'array<...>'
  // struct
  const fields = Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `{${fields}}`;
}

function paramSig(e: CatalogEntry): string {
  if (!e.params || e.params.length === 0) return '';
  return e.params.map(p => `${p.name}: ${p.type}`).join(', ');
}

function paramCallExample(e: CatalogEntry): string {
  if (!e.params || e.params.length === 0) return '';
  return e.params.map(p => p.example).join(', ');
}

// ────────────────────────────────────────────────────────────────────────
// BARE — current production shape
// ────────────────────────────────────────────────────────────────────────

const BARE: Language = {
  id: 'bare',
  renderCatalog(catalog) {
    const lines = catalog.map(e => {
      // Bare encodes params in the name (production today): `[STOCK NVDA]`
      const name = e.kind === 'fn' || e.kind === 'array' ? `${e.displayName} <${paramCallExample(e)}>` : e.displayName;
      return `- [${name}] — ${e.description}`;
    });
    return `AVAILABLE CONTEXT TOKENS — emit VERBATIM when relevant; the runtime substitutes real values AFTER your response:\n\n${lines.join('\n')}`;
  },
  exampleUsage(catalog) {
    const stock = catalog.find(e => e.id === 'stock-price')!;
    return `Example output: "Your email is [EMAIL] and ${stock.displayName.toLowerCase()} for NVDA is [${stock.displayName} NVDA]"`;
  },
  parseSentinels(output, catalog) {
    return parseBrackets(output, (raw, inner) => {
      // Try to match against catalog: longest displayName prefix wins.
      const sorted = [...catalog].sort((a, b) => b.displayName.length - a.displayName.length);
      for (const e of sorted) {
        if (inner === e.displayName) return { id: e.id, raw, params: {} };
        if (inner.startsWith(e.displayName + ' ')) {
          const args = inner.slice(e.displayName.length + 1).trim();
          // Map all args into a single positional bag keyed by param name.
          const params: Record<string, string> = {};
          if (e.params && e.params.length > 0) {
            const parts = args.split(/\s+/);
            for (let i = 0; i < e.params.length && i < parts.length; i++) {
              params[e.params[i]!.name] = parts[i]!;
            }
          }
          return { id: e.id, raw, params };
        }
      }
      return { id: null, raw, params: {} };
    });
  },
};

// ────────────────────────────────────────────────────────────────────────
// TYPED_SCALAR — bracket with TS-like type annotation
// ────────────────────────────────────────────────────────────────────────

const TYPED_SCALAR: Language = {
  id: 'typed-scalar',
  renderCatalog(catalog) {
    const lines = catalog.map(e => {
      const ret = renderReturnType(e.returns);
      const name = e.kind === 'fn' || e.kind === 'array'
        ? `${e.displayName} <${paramCallExample(e)}>: ${ret}`
        : `${e.displayName}: ${ret}`;
      return `- [${name}] — ${e.description}`;
    });
    return `AVAILABLE CONTEXT TOKENS — typed catalog. Emit a token EXACTLY as written in the list (including its type annotation). The runtime substitutes the typed value AFTER your response:\n\n${lines.join('\n')}`;
  },
  exampleUsage(_) {
    return `Example output: "Your email is [EMAIL: string] and the NVDA price is [STOCK PRICE <NVDA>: number]"`;
  },
  parseSentinels(output, catalog) {
    return parseBrackets(output, (raw, inner) => {
      // Strip type annotation (everything from ":" onward).
      const colon = inner.lastIndexOf(':');
      const head = (colon >= 0 ? inner.slice(0, colon) : inner).trim();
      // head may still contain "<args>"
      const ltIdx = head.indexOf('<');
      const baseName = ltIdx >= 0 ? head.slice(0, ltIdx).trim() : head;
      const argString = ltIdx >= 0 ? head.slice(ltIdx + 1, head.lastIndexOf('>')).trim() : '';

      for (const e of catalog) {
        if (e.displayName === baseName) {
          const params: Record<string, string> = {};
          if (argString && e.params) {
            const parts = argString.split(/\s*,\s*|\s+/).filter(Boolean);
            for (let i = 0; i < e.params.length && i < parts.length; i++) {
              params[e.params[i]!.name] = parts[i]!;
            }
          }
          return { id: e.id, raw, params };
        }
      }
      return { id: null, raw, params: {} };
    });
  },
};

// ────────────────────────────────────────────────────────────────────────
// PARAMETERIZED — function-call shape with input + output signatures
// ────────────────────────────────────────────────────────────────────────

const PARAMETERIZED: Language = {
  id: 'parameterized',
  renderCatalog(catalog) {
    const lines = catalog.map(e => {
      const ret = renderReturnType(e.returns);
      let body: string;
      if (e.params && e.params.length > 0) {
        body = `${e.displayName}(${paramSig(e)}): ${ret}`;
      } else {
        body = `${e.displayName}: ${ret}`;
      }
      return `- [${body}] — ${e.description}`;
    });
    return `AVAILABLE FUNCTIONS — typed catalog with parameter signatures. To use a function, emit a token of the form [NAME(arg1=value1, arg2=value2)]. For scalars (no params), just [NAME]. The runtime fills the result AFTER your response:\n\n${lines.join('\n')}`;
  },
  exampleUsage(_) {
    return `Example output: "Your email is [EMAIL] and the NVDA price is [STOCK PRICE(ticker="NVDA")]"`;
  },
  parseSentinels(output, catalog) {
    return parseBrackets(output, (raw, inner) => {
      // Two shapes: `NAME` (scalar) or `NAME(arg=val, ...)` (fn call).
      // Also tolerant of `NAME(val1, val2)` positional form.
      const lparen = inner.indexOf('(');
      let baseName: string;
      let argBody = '';
      if (lparen < 0) {
        baseName = inner.trim();
      } else {
        baseName = inner.slice(0, lparen).trim();
        const rparen = inner.lastIndexOf(')');
        argBody = rparen > lparen ? inner.slice(lparen + 1, rparen) : '';
      }
      // Strip any trailing return-type annotation that might've leaked.
      const colon = baseName.indexOf(':');
      if (colon >= 0) baseName = baseName.slice(0, colon).trim();

      for (const e of catalog) {
        if (e.displayName === baseName) {
          const params: Record<string, string> = {};
          if (argBody && e.params) {
            const tokens = splitArgs(argBody);
            const named = tokens.every(t => /^[A-Za-z_][\w]*\s*=/.test(t));
            if (named) {
              for (const t of tokens) {
                const eq = t.indexOf('=');
                const k = t.slice(0, eq).trim();
                let v = t.slice(eq + 1).trim();
                v = v.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
                params[k] = v;
              }
            } else {
              for (let i = 0; i < e.params.length && i < tokens.length; i++) {
                let v = tokens[i]!.trim();
                v = v.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
                params[e.params[i]!.name] = v;
              }
            }
          }
          return { id: e.id, raw, params };
        }
      }
      return { id: null, raw, params: {} };
    });
  },
};

// ────────────────────────────────────────────────────────────────────────
// NATURAL — verb-prefixed English
// ────────────────────────────────────────────────────────────────────────

const VERBS: Record<CatalogEntry['kind'], string> = {
  scalar: 'GET',
  fn: 'LOOKUP',
  array: 'LIST',
};

const NATURAL: Language = {
  id: 'natural',
  renderCatalog(catalog) {
    const lines = catalog.map(e => {
      const verb = VERBS[e.kind];
      const lowerName = e.displayName.toLowerCase();
      const argHint = e.params && e.params.length > 0
        ? ' ' + e.params.map(p => `<${p.name}>`).join(' ')
        : '';
      return `- [${verb} ${lowerName}${argHint}] — ${e.description} (returns ${renderReturnType(e.returns)})`;
    });
    return `AVAILABLE LOOKUPS — emit a bracketed verb phrase using the EXACT verb (GET / LOOKUP / LIST) and lower-case name shown. Fill <args> with literal values. The runtime resolves the lookup AFTER your response:\n\n${lines.join('\n')}`;
  },
  exampleUsage(_) {
    return `Example output: "Your email is [GET email] and NVDA is at [LOOKUP stock price NVDA]"`;
  },
  parseSentinels(output, catalog) {
    return parseBrackets(output, (raw, inner) => {
      const m = /^(GET|LOOKUP|LIST)\s+(.+)$/i.exec(inner.trim());
      if (!m) return { id: null, raw, params: {} };
      const verb = m[1]!.toUpperCase() as 'GET' | 'LOOKUP' | 'LIST';
      const rest = m[2]!.trim();
      // Match by longest lowercase name prefix.
      const sorted = [...catalog].sort((a, b) => b.displayName.length - a.displayName.length);
      for (const e of sorted) {
        const lower = e.displayName.toLowerCase();
        if (VERBS[e.kind] !== verb) continue;
        if (rest === lower) return { id: e.id, raw, params: {} };
        if (rest.startsWith(lower + ' ')) {
          const args = rest.slice(lower.length + 1).trim();
          const params: Record<string, string> = {};
          if (e.params && e.params.length > 0) {
            const parts = args.split(/\s+/);
            for (let i = 0; i < e.params.length && i < parts.length; i++) {
              params[e.params[i]!.name] = parts[i]!;
            }
          }
          return { id: e.id, raw, params };
        }
      }
      return { id: null, raw, params: {} };
    });
  },
};

// ────────────────────────────────────────────────────────────────────────
// Common bracket extractor
// ────────────────────────────────────────────────────────────────────────

function parseBrackets(
  output: string,
  matchFn: (raw: string, inner: string) => ParsedSentinel,
): ParsedSentinel[] {
  const results: ParsedSentinel[] = [];
  // Match balanced single-bracket pairs that contain at least one
  // alphabetic char. We do NOT do nested-bracket matching — typed
  // catalogs may have `{...}` inside but stay within one `[...]`.
  const re = /\[([^\[\]]+?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const raw = m[0]!;
    const inner = m[1]!;
    // Skip obvious markdown links `[text](url)` to avoid noise.
    if (output[m.index + raw.length] === '(' && /https?:\/\//.test(output.slice(m.index + raw.length, m.index + raw.length + 40))) {
      continue;
    }
    if (!/[A-Za-z]/.test(inner)) continue;
    results.push(matchFn(raw, inner));
  }
  return results;
}

function splitArgs(body: string): string[] {
  // Split on commas not inside quotes.
  const out: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let acc = '';
  for (const ch of body) {
    if (inQuote) {
      acc += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; acc += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; acc += ch; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth--; acc += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(acc.trim()); acc = ''; continue; }
    acc += ch;
  }
  if (acc.trim()) out.push(acc.trim());
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// JSON_CALL — pure JSON shape: `{"call": "STOCK", "args": {"ticker": "NVDA"}}`
// ────────────────────────────────────────────────────────────────────────

const JSON_CALL: Language = {
  id: 'json-call',
  renderCatalog(catalog) {
    const lines = catalog.map(e => {
      const ret = renderReturnType(e.returns);
      const sig = e.params && e.params.length > 0 ? `(${paramSig(e)})` : '';
      return `- "${e.displayName}"${sig} → ${ret} — ${e.description}`;
    });
    return `AVAILABLE FUNCTIONS — emit each as a single JSON object on its own line, INLINE inside your prose:
  {"call": "<name>", "args": {<arg-name>: <value>, ...}}
For scalars (no args): {"call": "<name>"}. The runtime replaces each JSON object with the resolved value.

${lines.join('\n')}`;
  },
  exampleUsage(_) {
    return `Example output: "Your email is {"call": "EMAIL"} and NVDA is at {"call": "STOCK PRICE", "args": {"ticker": "NVDA"}}"`;
  },
  parseSentinels(output, catalog) {
    const results: ParsedSentinel[] = [];
    // Find balanced JSON object literals via a stack walk. Simpler
    // than a full JSON tokenizer — we only need shallow `{...}` chunks.
    let i = 0;
    while (i < output.length) {
      if (output[i] !== '{') { i++; continue; }
      // Find matching close brace.
      let depth = 0;
      let j = i;
      let inStr: string | null = null;
      let esc = false;
      for (; j < output.length; j++) {
        const ch = output[j]!;
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === inStr) inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) { i++; continue; }
      const raw = output.slice(i, j + 1);
      i = j + 1;
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || typeof obj.call !== 'string') continue;
        const name = obj.call;
        const args = obj.args && typeof obj.args === 'object' ? obj.args : {};
        const entry = catalog.find(e => e.displayName === name) ?? null;
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          params[k] = String(v);
        }
        results.push({ id: entry?.id ?? null, raw, params });
      } catch {
        // not valid JSON — skip
        continue;
      }
    }
    return results;
  },
};

// ────────────────────────────────────────────────────────────────────────
// HYBRID — verb prefix + keyword-arg signature
// ────────────────────────────────────────────────────────────────────────

const HYBRID: Language = {
  id: 'hybrid',
  renderCatalog(catalog) {
    const lines = catalog.map(e => {
      const verb = VERBS[e.kind];
      const lowerName = e.displayName.toLowerCase();
      const ret = renderReturnType(e.returns);
      if (e.params && e.params.length > 0) {
        return `- [${verb} ${lowerName}(${paramSig(e)})] → ${ret} — ${e.description}`;
      }
      return `- [${verb} ${lowerName}] → ${ret} — ${e.description}`;
    });
    return `AVAILABLE LOOKUPS — emit a bracketed verb phrase. The verb (GET / LOOKUP / LIST) tells the runtime the entry kind; the name + args identify the call.

  Scalar:    [GET email]
  Function:  [LOOKUP stock price(ticker="NVDA")]
  Array:     [LIST news(limit=5)]

The runtime substitutes the resolved value AFTER your response.

${lines.join('\n')}`;
  },
  exampleUsage(_) {
    return `Example output: "Your email is [GET email] and NVDA is at [LOOKUP stock price(ticker="NVDA")]"`;
  },
  parseSentinels(output, catalog) {
    return parseBrackets(output, (raw, inner) => {
      const m = /^(GET|LOOKUP|LIST)\s+(.+)$/i.exec(inner.trim());
      if (!m) return { id: null, raw, params: {} };
      const verb = m[1]!.toUpperCase() as 'GET' | 'LOOKUP' | 'LIST';
      const rest = m[2]!.trim();
      // Strip optional (args)
      const lparen = rest.indexOf('(');
      let baseName: string;
      let argBody = '';
      if (lparen < 0) {
        baseName = rest;
      } else {
        baseName = rest.slice(0, lparen).trim();
        const rparen = rest.lastIndexOf(')');
        argBody = rparen > lparen ? rest.slice(lparen + 1, rparen) : '';
      }
      // Match name (lowercased)
      const sorted = [...catalog].sort((a, b) => b.displayName.length - a.displayName.length);
      for (const e of sorted) {
        if (VERBS[e.kind] !== verb) continue;
        if (baseName === e.displayName.toLowerCase()) {
          const params: Record<string, string> = {};
          if (argBody && e.params) {
            const tokens = splitArgs(argBody);
            const named = tokens.every(t => /^[A-Za-z_][\w]*\s*=/.test(t));
            if (named) {
              for (const t of tokens) {
                const eq = t.indexOf('=');
                const k = t.slice(0, eq).trim();
                let v = t.slice(eq + 1).trim();
                v = v.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
                params[k] = v;
              }
            } else {
              for (let i = 0; i < e.params.length && i < tokens.length; i++) {
                let v = tokens[i]!.trim();
                v = v.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
                params[e.params[i]!.name] = v;
              }
            }
          }
          return { id: e.id, raw, params };
        }
      }
      return { id: null, raw, params: {} };
    });
  },
};

// ────────────────────────────────────────────────────────────────────────

export const LANGUAGES: Record<LanguageId, Language> = {
  bare: BARE,
  'typed-scalar': TYPED_SCALAR,
  parameterized: PARAMETERIZED,
  natural: NATURAL,
  'json-call': JSON_CALL,
  hybrid: HYBRID,
};
