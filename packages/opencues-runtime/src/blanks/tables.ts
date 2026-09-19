/**
 * `tables` — one built-in blank, eight offline tables, no model.
 *
 * The lookups people type with a `_` that a table or a calculator answers
 * exactly: a unicode symbol, a CSS colour, an HTTP status, a MIME type, a
 * default port, a unit conversion, arithmetic, a chemistry constant. The
 * keyword names the table, the context is the argument; the answer is
 * data, never generation, so it cannot hallucinate. Country facts already
 * have their own blank (`countries`).
 *
 * Reached two ways: the blank's own shapes (`unicode for em dash _`,
 * `hex for tomato _`, `http status for not found _`, `mime type for png _`,
 * `default port for postgres _`, `convert 5 miles to km _`, `calc 17 * 23 _`,
 * `atomic number of gold _`), and the decision layer's `table` verdict
 * (core's data-policy.ts), which resolves a plain phrasing (`what's the
 * postgres port _`) to the same keyword + argument.
 */
import type { Blank } from './types';
import { CSS_COLOURS, UNICODE_NAMES, HTTP_STATUS, HTTP_ALIASES, MIME_TYPES, DEFAULT_PORTS, ELEMENTS, SUBSTANCES, UNITS } from './tables-data';
import { calculatorForKeyword, calculatorForPhrase, PHRASE_KEYWORD } from './calc/registry';
import { calcContext } from './calc/env';
export { CALCULATORS, calculatorForKeyword, calculatorById, calculatorForPhrase, PHRASE_KEYWORD } from './calc/registry';
export { configureCalcEnv } from './calc/env';
export type { Calculator, CalcContext, CalcArgFrom, CalcFamily } from './calc/types';

export type TableName = 'unicode' | 'colour' | 'http' | 'mime' | 'port' | 'convert' | 'math' | 'chemistry';

/** the keyword each table answers to, as the blank's shapes and the decision policy use it */
export const TABLE_KEYWORDS: Readonly<Record<TableName, string>> = {
  unicode: 'unicode for', colour: 'hex for', http: 'http status for', mime: 'mime type for', port: 'default port for', convert: 'convert', math: 'calc', chemistry: 'atomic number of',
};

const norm = (s: string): string => s.toLowerCase().replace(/[’'"]/g, '').replace(/[^a-z0-9./*+\-^%() ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function tableFor(keyword: string): TableName | null {
  const k = keyword.toLowerCase();
  if (/^unicode/.test(k)) return 'unicode';
  if (/^(hex|rgb|colou?r)/.test(k)) return 'colour';
  if (/^http/.test(k)) return 'http';
  if (/^mime/.test(k)) return 'mime';
  if (/^(default )?port/.test(k)) return 'port';
  if (/^convert/.test(k)) return 'convert';
  if (/^(calc|calculate|compute|math)/.test(k)) return 'math';
  if (/^(atomic|boiling|melting|ph)/.test(k)) return 'chemistry';
  return null;
}

// ── unicode ───────────────────────────────────────────────────────────
export function lookupUnicode(name: string): string | null {
  const n = norm(name).replace(/\b(the|a|an|symbol|sign|character|char)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const cp = UNICODE_NAMES[n] ?? UNICODE_NAMES[`${n} sign`] ?? UNICODE_NAMES[`${n} symbol`] ?? UNICODE_NAMES[n.replace(/s$/, '')] ?? UNICODE_NAMES[`${n.replace(/s$/, '')} sign`];
  if (cp === undefined) return null;
  const hex = cp.toString(16).toUpperCase().padStart(4, '0');
  return `${String.fromCodePoint(cp)} U+${hex}`;
}

// ── colour ────────────────────────────────────────────────────────────
export function lookupColour(name: string, want: 'hex' | 'rgb' | 'both' = 'both'): string | null {
  const n = norm(name).replace(/\b(the|a|colou?r|css)\b/g, ' ').replace(/\s+/g, '').trim();
  let hex = CSS_COLOURS[n];
  if (!hex && /^#?[0-9a-f]{6}$/.test(n)) hex = n.replace('#', '');
  if (!hex && /^#?[0-9a-f]{3}$/.test(n)) hex = n.replace('#', '').split('').map((c) => c + c).join('');
  if (!hex) return null;
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  if (want === 'hex') return `#${hex}`;
  if (want === 'rgb') return `rgb(${r}, ${g}, ${b})`;
  return `#${hex} · rgb(${r}, ${g}, ${b})`;
}

// ── http ──────────────────────────────────────────────────────────────
export function lookupHttp(q: string): string | null {
  const n = norm(q).replace(/\b(the|a|an|status|code|error|for|response)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^\d{3}$/.test(n)) { const t = HTTP_STATUS[n]; return t ? `${n} ${t}` : null; }
  const alias = HTTP_ALIASES[n];
  if (alias) return `${alias} ${HTTP_STATUS[String(alias)]}`;
  for (const [code, text] of Object.entries(HTTP_STATUS)) if (norm(text) === n) return `${code} ${text}`;
  for (const [code, text] of Object.entries(HTTP_STATUS)) if (norm(text).includes(n) && n.length >= 4) return `${code} ${text}`;
  return null;
}

// ── mime ──────────────────────────────────────────────────────────────
export function lookupMime(q: string): string | null {
  const n = norm(q).replace(/\b(a|an|the|file|files|format|type|extension|for)\b/g, ' ').replace(/\s+/g, ' ').replace(/^\./, '').trim();
  return MIME_TYPES[n] ?? MIME_TYPES[n.replace(/\s+/g, '')] ?? null;
}

// ── port ──────────────────────────────────────────────────────────────
export function lookupPort(q: string): string | null {
  const n = norm(q).replace(/\b(the|a|an|default|port|for|of|server|service)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const p = DEFAULT_PORTS[n] ?? DEFAULT_PORTS[n.replace(/\s+/g, '')];
  if (p === undefined) return null;
  return p === 0 ? `${n}: no network port (a file)` : `${n}: ${p}`;
}

// ── convert ───────────────────────────────────────────────────────────
function unitOf(u: string): { family: string; factor: number; unit: string } | null {
  const k = u.toLowerCase().replace(/\.$/, '').trim();
  for (const [family, table] of Object.entries(UNITS)) { if (k in table) return { family, factor: table[k], unit: k }; }
  return null;
}
const TEMP = new Set(['c', 'celsius', 'centigrade', 'f', 'fahrenheit', 'k', 'kelvin']);
function tempTo(v: number, from: string, to: string): number | null {
  const f = from[0], t = to[0];
  const c = f === 'c' ? v : f === 'f' ? (v - 32) * 5 / 9 : f === 'k' ? v - 273.15 : NaN;
  if (!Number.isFinite(c)) return null;
  return t === 'c' ? c : t === 'f' ? c * 9 / 5 + 32 : t === 'k' ? c + 273.15 : null;
}
const fmt = (n: number): string => (Math.abs(n) >= 1e6 || (Math.abs(n) < 1e-3 && n !== 0)) ? n.toExponential(3) : String(Number(n.toPrecision(6)));
export function convertUnits(q: string): string | null {
  const s = norm(q).replace(/\bdegrees?\b/g, '').replace(/°/g, '').replace(/\s+/g, ' ').trim();
  // "5 miles in km", "100 celsius to fahrenheit", "how many feet in a mile", "1 mile in feet"
  let m = s.match(/^(?:convert )?(-?\d+(?:\.\d+)?)\s*([a-z/ ]+?)\s+(?:in|to|into|as)\s+([a-z/ ]+?)$/);
  if (!m) { const hm = s.match(/^how many ([a-z/ ]+?) (?:are |is )?in (?:a |an |one )?([a-z/ ]+?)$/); if (hm) m = ['', '1', hm[2], hm[1]] as unknown as RegExpMatchArray; }
  if (!m) return null;
  const v = Number(m[1]); const from = m[2].trim(), to = m[3].trim();
  if (TEMP.has(from) && TEMP.has(to)) { const r = tempTo(v, from, to); return r === null ? null : `${fmt(v)} ${from} = ${fmt(r)} ${to}`; }
  const a = unitOf(from), b = unitOf(to);
  if (!a || !b || a.family !== b.family) return null;
  const r = v * a.factor / b.factor;
  return `${fmt(v)} ${from} = ${fmt(r)} ${to}`;
}

// ── math: a tiny safe evaluator (no eval) ─────────────────────────────
export function evalMath(q: string): string | null {
  let s = norm(q).replace(/\bcalc(ulate)?\b|\bcompute\b|\bwhat is\b|\bwhats\b|\bequals?\b|=$/g, ' ')
    .replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-').replace(/\btimes\b|\bmultiplied by\b|\bx\b/g, '*').replace(/\bdivided by\b|\bover\b/g, '/')
    .replace(/\bsquare root of\b|\bsqrt(?: of)?\b/g, 'sqrt').replace(/\bto the power of\b|\bpower\b/g, '^').replace(/\bpercent of\b/g, '% of').replace(/\bpi\b/g, 'pi').replace(/\s+/g, ' ').trim();
  const pct = s.match(/^(-?\d+(?:\.\d+)?) ?% of (-?\d+(?:\.\d+)?)$/);
  if (pct) return fmt(Number(pct[1]) / 100 * Number(pct[2]));
  const piTo = s.match(/^pi to (\d+) decimals?$/);
  if (piTo) return Math.PI.toFixed(Math.min(20, Number(piTo[1])));
  const sq = s.match(/^sqrt ?\(?(-?\d+(?:\.\d+)?)\)?$/);
  if (sq) { const v = Number(sq[1]); return v < 0 ? null : fmt(Math.sqrt(v)); }
  if (!/^[\d\s.+\-*/^()pie]+$/.test(s) || !/\d|pi/.test(s)) return null;
  // shunting-yard over + - * / ^ and parentheses
  const toks = s.replace(/pi/g, String(Math.PI)).replace(/\be\b/g, String(Math.E)).match(/\d+(?:\.\d+)?|[+\-*/^()]/g);
  if (!toks) return null;
  const out: number[] = []; const ops: string[] = []; const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
  const apply = (): boolean => { const o = ops.pop()!; const b = out.pop(), a = out.pop(); if (a === undefined || b === undefined) return false; out.push(o === '+' ? a + b : o === '-' ? a - b : o === '*' ? a * b : o === '/' ? a / b : Math.pow(a, b)); return true; };
  let prev = '';
  for (const t of toks) {
    if (/^\d/.test(t)) out.push(Number(t));
    else if (t === '(') ops.push(t);
    else if (t === ')') { while (ops.length && ops[ops.length - 1] !== '(') if (!apply()) return null; if (!ops.length) return null; ops.pop(); }
    else {
      if (t === '-' && (prev === '' || prev === '(' || prev in prec)) { out.push(0); }   // unary minus
      while (ops.length && ops[ops.length - 1] !== '(' && (prec[ops[ops.length - 1]] > prec[t] || (prec[ops[ops.length - 1]] === prec[t] && t !== '^'))) if (!apply()) return null;
      ops.push(t);
    }
    prev = t;
  }
  while (ops.length) { if (ops[ops.length - 1] === '(') return null; if (!apply()) return null; }
  if (out.length !== 1 || !Number.isFinite(out[0])) return null;
  return fmt(out[0]);
}

// ── chemistry ─────────────────────────────────────────────────────────
export function lookupChemistry(keyword: string, q: string): string | null {
  const k = keyword.toLowerCase(); const n = norm(q).replace(/\b(the|of|in|celsius|fahrenheit|kelvin|c|f|k)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const el = ELEMENTS.find((e) => e.name.toLowerCase() === n || e.sym.toLowerCase() === n);
  if (/atomic number/.test(k)) return el ? `${el.name} (${el.sym}): atomic number ${el.n}` : null;
  if (/atomic mass|atomic weight/.test(k)) return el ? `${el.name} (${el.sym}): ${el.mass} u` : null;
  const sub = SUBSTANCES[n] ?? (el ? SUBSTANCES[el.name.toLowerCase()] : undefined);
  if (/boiling/.test(k)) return sub?.boil !== undefined ? `${n}: boils at ${sub.boil} °C` : null;
  if (/melting/.test(k)) return sub?.melt !== undefined ? `${n}: melts at ${sub.melt} °C` : null;
  if (/^ph/.test(k)) return sub?.ph !== undefined ? `${n}: pH ${sub.ph}` : null;
  return null;
}

/** The answer for a keyword + argument, or null when the table has none (also the decision-fill probe in blank-fill.ts). */
export function lookupTable(keyword: string, arg: string, command = ''): string | null {
  const kw = keyword.toLowerCase();
  if (kw === PHRASE_KEYWORD) {
    const calc = calculatorForPhrase(arg);
    if (!calc) return null;
    try { return calc.run(arg.trim(), calcContext()); } catch { return null; }
  }
  const calc = calculatorForKeyword(kw);
  if (calc) {
    if (calc.arg !== 'none' && !arg && !calc.optionalArg) return null;
    const bare = arg.toLowerCase();
    const input = calc.keywordIsArg && !calc.keywords.some((k) => bare.includes(k)) && !(calc.phrase && calc.phrase.test(arg.trim())) ? `${kw} ${arg}`.trim() : arg;
    try { return calc.run(input, calcContext(command)); } catch { return null; }
  }
  const table = tableFor(kw);
  if (!table || !arg) return null;
  let out: string | null = null;
  switch (table) {
    case 'unicode': out = lookupUnicode(arg); return out ? `${arg}: ${out}` : null;
    case 'colour': { const want = /^rgb/.test(kw) ? 'rgb' : /^hex/.test(kw) ? 'hex' : 'both'; out = lookupColour(arg, want); return out ? `${arg}: ${out}` : null; }
    case 'http': return lookupHttp(arg);
    case 'mime': out = lookupMime(arg); return out ? `${arg}: ${out}` : null;
    case 'port': return lookupPort(arg);
    case 'convert': return convertUnits(arg);
    case 'math': out = evalMath(arg); return out !== null ? `${arg} = ${out}` : null;
    case 'chemistry': return lookupChemistry(kw, arg);
  }
}

const MISS: Readonly<Record<TableName, string>> = { unicode: 'not in the table', colour: 'not a CSS colour', http: 'no such status', mime: 'not in the table', port: 'not in the table', convert: 'cannot convert', math: 'cannot compute', chemistry: 'not in the table' };

export class TablesBlank implements Blank {
  readonly name = 'tables';
  readonly readOnly = true;
  async get(keyword?: string, context?: string[]): Promise<string> {
    const kw = keyword ?? '';
    const calc = kw.toLowerCase() === PHRASE_KEYWORD ? calculatorForPhrase((context ?? []).join(' ')) : calculatorForKeyword(kw);
    // A buffer calculator is invoked as [priorTextRaw, capturedArg] (BlankFill
    // builds that pair): the captured argument is the INPUT for an inline-arg
    // calculator (`slug for X`), else a parameter (`count of the`).
    if (calc?.arg === 'buffer') {
      const prior = (context ?? [])[0] ?? '';
      const captured = ((context ?? [])[1] ?? '').trim();
      const inline = calc.inlineArg && captured.length > 0;
      const input = inline ? captured : prior;
      const out = lookupTable(kw, input, inline ? '' : captured);
      // a miss keeps the command in the buffer (`[err]` fills are feedback, never a consumption)
      return out ?? `[err] ${inline ? `${captured.slice(0, 40)}: ` : ''}${calc.miss}`;
    }
    const arg = (context ?? []).join(' ').trim();
    if (calc) return lookupTable(kw, arg) ?? `${arg ? `${arg.slice(0, 40)}: ` : ''}${calc.miss}`;
    const table = tableFor(kw);
    if (!table) return '';
    return lookupTable(kw, arg) ?? `${arg}: ${MISS[table]}`;
  }
}
