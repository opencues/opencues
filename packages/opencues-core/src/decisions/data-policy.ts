/**
 * Data tables on the decision layer — the runtime's policy half for the
 * `table` verdict (security-audit.md row #32, the same tier-2 rule as
 * device-policy.ts).
 *
 * A decision leg may name WHICH offline table a `_` asks for: a unicode
 * symbol, a CSS colour, an HTTP status, a MIME type, a default port, a unit
 * conversion, arithmetic, a chemistry constant, a country fact. The answer
 * is then DATA the runtime holds (`tables` and `countries` in
 * `@opencues/runtime`), never generation, so the whole lookup runs with no
 * LLM at all. This file decides what such a verdict may invoke:
 *
 *   - only the two shipped built-ins named here, by table id; a user blank
 *     is never selectable this way;
 *   - the argument is CAPTURED FROM THE DRAFT by grammar (the question
 *     scaffold and the table's own trigger words stripped), never a model
 *     string — the model can only pick a table id;
 *   - the captured argument passes a floor (length, control chars, and for
 *     the two expression tables a numeric-expression alphabet);
 *   - the table itself is the last gate: the runtime looks the argument up
 *     BEFORE it fills, and a miss falls through to the chat fan-out, so a
 *     plain phrasing the table cannot answer costs nothing but the verdict.
 */

import { segmentStart } from '../segment';

export interface TableVerdict {
  /** the table id the leg chose (a `DATA_POLICY` key) */
  readonly table: string;
  readonly confidence: number;
  /** the top options, for the log */
  readonly top: string;
}

export interface DataPolicyEntry {
  /** the built-in that answers */
  readonly blank: 'tables' | 'countries';
  /** the keyword the blank's own shapes accept, which names the table inside it */
  readonly keyword: string;
  /** scaffold + trigger words to strip from the draft; what remains is the argument */
  readonly strip: RegExp;
  /** the argument is a numeric expression (`5 miles to km`, `17 * 23`) and keeps its operators */
  readonly expr?: boolean;
  /** every keyword phrase the calculator answers to; a leading or trailing one is stripped from the argument unless `keepKeyword` */
  readonly keywords?: readonly string[];
  /** which floor the argument passes: `text` (a name), `expr` (numbers + operators), `calc` (a calculator phrase: numbers, units, dates, clock times, a few operators) */
  readonly floor?: 'text' | 'expr' | 'calc';
  /** the calculator parses its own keyword (`last friday of october`, `45 minutes ago`): leave it in the argument */
  readonly keepKeyword?: boolean;
  /** a bare keyword (`unix time`, `iso now`): no argument is captured */
  readonly arg?: 'none';
  /** the argument may be empty (`easter` = this year) */
  readonly optional?: boolean;
}

const Q = String.raw`what(?:'s|s| is| are| does| do| was)?|which|how (?:do|would|can|should) (?:i|you|we)|tell me|give me|show me|i need|i want|please|for me|quickly|is|are|the|a|an|of|for|in|do|does|use|uses|mean|means|meaning|they|we|you|it`;
const w = (extra: string): RegExp => new RegExp(String.raw`\b(?:${Q}|${extra})\b`, 'gi');

/** the calculator scaffold: only the question words, so units, dates and operators survive */
const CALC_Q = /\b(?:what(?:'s|s| is| are| does| do| was| would be)?|which|how (?:do|would|can|should) (?:i|you|we)|tell me|give me|show me|i need|i want|please|for me|quickly|calculate|compute|work out|the|a|an)\b/gi;

/** Tier 2: the two shipped offline built-ins, by table id. Never a user blank. */
export const DATA_POLICY: Readonly<Record<string, DataPolicyEntry>> = {
  unicode:          { blank: 'tables', keyword: 'unicode for', strip: w(String.raw`unicode|code ?point|codepoint|character|char|glyph|type|write|insert|get|make|symbol|sign|to`) },
  hex:              { blank: 'tables', keyword: 'hex for', strip: w(String.raw`hex(?:adecimal)?|code|value|colou?r|css|html|to`) },
  rgb:              { blank: 'tables', keyword: 'rgb for', strip: w(String.raw`rgb|value|values|colou?r|css|html|to|as`) },
  http:             { blank: 'tables', keyword: 'http status for', strip: w(String.raw`http|status|code|error|response|number|return|send|should|when|to|i`) },
  mime:             { blank: 'tables', keyword: 'mime type for', strip: w(String.raw`mime|media|content|type|file|files|format|extension|to`) },
  port:             { blank: 'tables', keyword: 'default port for', strip: w(String.raw`default|port|number|server|service|run(?:s)? on|listen(?:s)? on|on|to|by`) },
  convert:          { blank: 'tables', keyword: 'convert', strip: /\b(?:what(?:'s|s| is)?|convert|please|for me|equals|equal to|in terms of)\b/gi, expr: true },
  calc:             { blank: 'tables', keyword: 'calc', strip: /\b(?:what(?:'s|s| is)?|calc(?:ulate)?|compute|how much is|the answer to|the result of|please|for me|quickly|equals?)\b/gi, expr: true },
  'atomic-number':  { blank: 'tables', keyword: 'atomic number of', strip: w(String.raw`atomic|number|element|periodic|table|on`) },
  'atomic-mass':    { blank: 'tables', keyword: 'atomic mass of', strip: w(String.raw`atomic|mass|weight|element|periodic|table|on`) },
  'boiling-point':  { blank: 'tables', keyword: 'boiling point of', strip: w(String.raw`boiling|boil|boils|point|temperature|temp|at|when|celsius|fahrenheit|kelvin|degrees`) },
  'melting-point':  { blank: 'tables', keyword: 'melting point of', strip: w(String.raw`melting|melt|melts|point|temperature|temp|at|when|celsius|fahrenheit|kelvin|degrees`) },
  ph:               { blank: 'tables', keyword: 'ph of', strip: w(String.raw`ph|level|value|acidity|acidic|alkaline|how acidic`) },
  capital:          { blank: 'countries', keyword: 'capital of', strip: w(String.raw`capital|city|country`) },
  population:       { blank: 'countries', keyword: 'population of', strip: w(String.raw`population|how many people|people|live|lives|living|country|big`) },
  currency:         { blank: 'countries', keyword: 'currency of', strip: w(String.raw`currency|money|pay with|pay|country`) },
  languages:        { blank: 'countries', keyword: 'languages of', strip: w(String.raw`languages?|spoken|speak|speaks|they|people|country|official`) },
  area:             { blank: 'countries', keyword: 'area of', strip: w(String.raw`area|size|how big|big|large|country|km|square`) },
  region:           { blank: 'countries', keyword: 'region of', strip: w(String.raw`region|continent|where|located|country|part|world`) },
  // ── the calculators (packages/opencues-runtime/src/blanks/calc/, pinned by its calc-policy drift test) ──
  'days-between': { blank: 'tables', keyword: 'days between', keywords: ['days between'], strip: CALC_Q, floor: 'calc' },
  'weeks-between': { blank: 'tables', keyword: 'weeks between', keywords: ['weeks between'], strip: CALC_Q, floor: 'calc' },
  'working-days-between': { blank: 'tables', keyword: 'working days between', keywords: ['working days between', 'business days between', 'weekdays between'], strip: CALC_Q, floor: 'calc' },
  'weekday-of': { blank: 'tables', keyword: 'weekday of', keywords: ['weekday of', 'day of the week for', 'day of the week was', 'day of the week is', 'what day was', 'what day is'], strip: CALC_Q, floor: 'calc' },
  'date-plus': { blank: 'tables', keyword: 'from today', keywords: ['from today', 'after', 'before'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'until': { blank: 'tables', keyword: 'days until', keywords: ['days until', 'weeks until', 'how long until', 'until', 'days to', 'countdown to'], strip: CALC_Q, floor: 'calc' },
  'since': { blank: 'tables', keyword: 'days since', keywords: ['days since', 'weeks since', 'how long since', 'since'], strip: CALC_Q, floor: 'calc' },
  'time-plus': { blank: 'tables', keyword: 'table', keywords: ['from now', 'ago'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'duration-sum': { blank: 'tables', keyword: 'duration', keywords: ['duration', 'total time', 'add times', 'time plus'], strip: CALC_Q, floor: 'calc' },
  'age': { blank: 'tables', keyword: 'age if born', keywords: ['age if born', 'age for', 'how old is someone born', 'age'], strip: CALC_Q, floor: 'calc' },
  'week-number': { blank: 'tables', keyword: 'week number of', keywords: ['week number of', 'iso week of', 'week of the year for', 'week number'], strip: CALC_Q, floor: 'calc', optional: true },
  'day-of-year': { blank: 'tables', keyword: 'day of the year for', keywords: ['day of the year for', 'day of year', 'day number of'], strip: CALC_Q, floor: 'calc', optional: true },
  'leap-year': { blank: 'tables', keyword: 'is a leap year', keywords: ['is a leap year', 'leap year'], strip: CALC_Q, floor: 'calc' },
  'quarter-of': { blank: 'tables', keyword: 'quarter of', keywords: ['quarter of', 'which quarter is', 'quarter'], strip: CALC_Q, floor: 'calc', optional: true },
  'easter': { blank: 'tables', keyword: 'easter', keywords: ['easter', 'easter sunday', 'when is easter'], strip: CALC_Q, floor: 'calc', optional: true },
  'nth-weekday': { blank: 'tables', keyword: 'last', keywords: ['last', 'first', 'second', 'third', 'fourth'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'unix-now': { blank: 'tables', keyword: 'unix time', keywords: ['unix time', 'unix timestamp', 'epoch now', 'epoch time'], strip: CALC_Q, floor: 'calc', arg: 'none' },
  'unix-to-date': { blank: 'tables', keyword: 'unix', keywords: ['unix', 'epoch', 'timestamp'], strip: CALC_Q, floor: 'calc' },
  'iso-now': { blank: 'tables', keyword: 'iso now', keywords: ['iso now', 'iso date', 'iso 8601', 'todays date', 'today\'s date', 'date today'], strip: CALC_Q, floor: 'calc', arg: 'none' },
  'seconds-in': { blank: 'tables', keyword: 'seconds in', keywords: ['seconds in', 'minutes in', 'hours in'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'time-in': { blank: 'tables', keyword: 'time in', keywords: ['time in', 'what time is it in', 'current time in', 'local time in'], strip: CALC_Q, floor: 'calc' },
  'convert-time': { blank: 'tables', keyword: 'table', keywords: ['convert time', 'time convert'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'utc-offset': { blank: 'tables', keyword: 'utc offset of', keywords: ['utc offset of', 'utc offset for', 'timezone of', 'time zone of', 'gmt offset of'], strip: CALC_Q, floor: 'calc' },
  'is-dst': { blank: 'tables', keyword: 'is it dst in', keywords: ['is it dst in', 'is it daylight saving in', 'dst in', 'daylight saving in'], strip: CALC_Q, floor: 'calc' },
  'overlap': { blank: 'tables', keyword: 'overlap between', keywords: ['overlap between', 'working hours overlap', 'office overlap'], strip: CALC_Q, floor: 'calc' },
  'meeting-at': { blank: 'tables', keyword: 'meeting at', keywords: ['meeting at', 'call at'], strip: CALC_Q, floor: 'calc' },
  'in-words': { blank: 'tables', keyword: 'in words', keywords: ['in words', 'spell out', 'number to words'], strip: CALC_Q, floor: 'calc' },
  'to-roman': { blank: 'tables', keyword: 'in roman numerals', keywords: ['in roman numerals', 'roman numeral for', 'to roman', 'roman'], strip: CALC_Q, floor: 'calc' },
  'from-roman': { blank: 'tables', keyword: 'from roman', keywords: ['from roman', 'roman numeral', 'in numbers', 'in arabic'], strip: CALC_Q, floor: 'calc' },
  'to-base': { blank: 'tables', keyword: 'in hex', keywords: ['in hex', 'in binary', 'in octal', 'to hex', 'to binary', 'to octal', 'in base'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'from-base': { blank: 'tables', keyword: 'in decimal', keywords: ['in decimal', 'to decimal', 'from hex', 'from binary', 'from octal', 'decimal of'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'as-decimal': { blank: 'tables', keyword: 'as a decimal', keywords: ['as a decimal', 'as decimal', 'to decimal fraction'], strip: CALC_Q, floor: 'calc' },
  'as-fraction': { blank: 'tables', keyword: 'as a fraction', keywords: ['as a fraction', 'as fraction', 'to fraction'], strip: CALC_Q, floor: 'calc' },
  'as-percent': { blank: 'tables', keyword: 'as a percent', keywords: ['as a percent', 'as percent', 'as a percentage', 'to percent'], strip: CALC_Q, floor: 'calc' },
  'scientific': { blank: 'tables', keyword: 'in scientific notation', keywords: ['in scientific notation', 'scientific notation', 'in standard form'], strip: CALC_Q, floor: 'calc' },
  'round': { blank: 'tables', keyword: 'round', keywords: ['round', 'rounded'], strip: CALC_Q, floor: 'calc' },
  'sig-figs': { blank: 'tables', keyword: 'significant figures', keywords: ['significant figures', 'sig figs', 'to sf'], strip: CALC_Q, floor: 'calc' },
  'ordinal': { blank: 'tables', keyword: 'ordinal for', keywords: ['ordinal for', 'ordinal of', 'ordinal'], strip: CALC_Q, floor: 'calc' },
  'with-commas': { blank: 'tables', keyword: 'with commas', keywords: ['with commas', 'with thousands separators', 'format number'], strip: CALC_Q, floor: 'calc' },
  'in-millions': { blank: 'tables', keyword: 'in millions', keywords: ['in millions', 'in billions', 'in thousands', 'in lakhs', 'in crores', 'short form'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'factorial': { blank: 'tables', keyword: 'factorial of', keywords: ['factorial of', 'factorial'], strip: CALC_Q, floor: 'calc' },
  'is-prime': { blank: 'tables', keyword: 'is prime', keywords: ['is prime', 'is it prime', 'prime check'], strip: CALC_Q, floor: 'calc' },
  'prime-factors': { blank: 'tables', keyword: 'prime factors of', keywords: ['prime factors of', 'factorise', 'factorize', 'factors of'], strip: CALC_Q, floor: 'calc' },
  'gcd': { blank: 'tables', keyword: 'gcd of', keywords: ['gcd of', 'gcd', 'hcf of', 'greatest common divisor of', 'highest common factor of'], strip: CALC_Q, floor: 'calc' },
  'lcm': { blank: 'tables', keyword: 'lcm of', keywords: ['lcm of', 'lcm', 'lowest common multiple of', 'least common multiple of'], strip: CALC_Q, floor: 'calc' },
  'fibonacci': { blank: 'tables', keyword: 'fibonacci', keywords: ['fibonacci', 'fib'], strip: CALC_Q, floor: 'calc' },
  'nth-root': { blank: 'tables', keyword: 'cube root of', keywords: ['cube root of', 'nth root', 'root of'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'log': { blank: 'tables', keyword: 'log base', keywords: ['log base', 'log of', 'log', 'ln of', 'ln'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'stats': { blank: 'tables', keyword: 'mean of', keywords: ['mean of', 'median of', 'mode of', 'stdev of', 'standard deviation of', 'average of', 'stats of', 'variance of', 'range of'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'sum-of': { blank: 'tables', keyword: 'sum of', keywords: ['sum of', 'total of', 'add up'], strip: CALC_Q, floor: 'calc' },
  'choose': { blank: 'tables', keyword: 'choose', keywords: ['choose', 'combinations', 'permutations', 'ncr', 'npr'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'probability': { blank: 'tables', keyword: 'probability of', keywords: ['probability of', 'chance of', 'odds of'], strip: CALC_Q, floor: 'calc' },
};

export const DATA_ARG_MAX = 60;
export const DATA_EXPR_MAX = 80;
export const DATA_CALC_MAX = 100;

/** The floor a captured argument passes before it reaches a table (security-audit #23, the AI-callable arg floor). */
export function dataArgWithinFloor(arg: string, expr: boolean | 'text' | 'expr' | 'calc'): boolean {
  if (!arg) return false;
  const kind = expr === true ? 'expr' : expr === false ? 'text' : expr;
  // a calculator phrase: words, numbers, dates, clock times, fractions, a few operators; never shell / URL / code structure
  if (kind === 'calc') return arg.length <= DATA_CALC_MAX && /^[\p{L}\d\s.,:/'#%+*^()–-]+$/u.test(arg) && !/[a-z]\s*\(|https?:|\/\//i.test(arg);
  expr = kind === 'expr';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(arg)) return false;
  // an expression carries a number, or is the `how many X in a Y` form the converter reads as 1
  // numbers, operators, unit words; never a call or a member access (`f(`, `.x`)
  if (expr) return arg.length <= DATA_EXPR_MAX && /^[\d\s.,+\-*/^%()a-z°]+$/i.test(arg) && !/[a-z]\s*\(|\.[a-z]/i.test(arg) && (/\d/.test(arg) || /^how many /.test(arg));
  return arg.length <= DATA_ARG_MAX && /^[\p{L}\d\s.'#-]+$/u.test(arg);
}

/** The argument a verdict captures from the draft under the policy, or null. */
export function captureDataArg(table: string, draft: string): string | null {
  const entry = DATA_POLICY[table];
  if (!entry) return null;
  const us = draft.lastIndexOf('_');
  const seg = draft.slice(segmentStart(draft, us >= 0 ? us : draft.length), us >= 0 ? us : draft.length);
  if (entry.arg === 'none') return '';
  // a calculator keeps commas and colons (`1,234`, `15:00`); the plain tables never needed them
  let arg = seg.replace(/[?!]+\s*$/, '').replace(entry.floor === 'calc' ? /[;]+/g : /[,;:]+/g, ' ');
  // the calculator's own keyword goes first (before the scaffold strip can break a multi-word one), wherever it sits
  if (entry.keywords && !entry.keepKeyword) {
    const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const k of [...entry.keywords].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(String.raw`(?:^|\s)${esc(k)}(?=\s|$)`, 'i');
      if (re.test(arg)) { arg = arg.replace(re, ' '); break; }
    }
  }
  // question scaffold that survives the word list (`how many`, `when is`, `what time is it`), before and after it
  const LEAD = /^(?:how many|how much|how long|how far|how big|when is|when was|when does|what time is it|what time|time is it|is it|was it|whats|what's|what is|what was|what|tell me|give me)\s+/i;
  // (the expression tables keep `how many X in a Y`, which the converter reads as 1 Y)
  const lead = (a: string): string => { if (entry.floor !== 'calc') return a; for (let i = 0; i < 3; i++) a = a.replace(LEAD, ''); return a.replace(/(?:^|\s+)(?:is it|it|(?<!from\s)right now|(?<!from\s)now)$/i, ''); };
  arg = lead(arg.replace(/\s+/g, ' ').trim());
  arg = lead(arg.replace(entry.strip, ' ').replace(/\s+/g, ' ').trim());
  if (!arg && entry.optional) return '';
  return dataArgWithinFloor(arg, entry.floor ?? entry.expr === true) ? arg : null;
}

/** The invocation a verdict resolves to under the policy, or null when it resolves to nothing invocable. */
export function resolveDataInvocation(v: TableVerdict, draft: string): { blank: string; keyword: string; action: 'get'; value: string } | null {
  const entry = DATA_POLICY[v.table];
  if (!entry) return null;
  const arg = captureDataArg(v.table, draft);
  if (arg === null) return null;
  return { blank: entry.blank, keyword: entry.keyword, action: 'get', value: arg };
}

/** The canonical command the blank's own shapes accept for an invocation: `hex for tomato _`, `calc 17 * 23 _`, `capital of france _`. */
export function dataCanonicalCommand(inv: { keyword: string; value: string }): string {
  return `${inv.keyword} ${inv.value} _`;
}
