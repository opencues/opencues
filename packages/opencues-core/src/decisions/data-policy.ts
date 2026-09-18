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
}

const Q = String.raw`what(?:'s|s| is| are| does| do| was)?|which|how (?:do|would|can|should) (?:i|you|we)|tell me|give me|show me|i need|i want|please|for me|quickly|is|are|the|a|an|of|for|in|do|does|use|uses|mean|means|meaning|they|we|you|it`;
const w = (extra: string): RegExp => new RegExp(String.raw`\b(?:${Q}|${extra})\b`, 'gi');

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
};

export const DATA_ARG_MAX = 60;
export const DATA_EXPR_MAX = 80;

/** The floor a captured argument passes before it reaches a table (security-audit #23, the AI-callable arg floor). */
export function dataArgWithinFloor(arg: string, expr: boolean): boolean {
  if (!arg) return false;
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
  const arg = seg.replace(/[?!]+\s*$/, '').replace(/[,;:]+/g, ' ').replace(entry.strip, ' ').replace(/\s+/g, ' ').trim();
  return dataArgWithinFloor(arg, entry.expr === true) ? arg : null;
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
