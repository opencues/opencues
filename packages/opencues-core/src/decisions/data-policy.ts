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
  readonly floor?: 'text' | 'expr' | 'calc' | 'raw';
  /** the calculator parses its own keyword (`last friday of october`, `45 minutes ago`): leave it in the argument */
  readonly keepKeyword?: boolean;
  /** a bare keyword (`unix time`, `iso now`): no argument is captured; `buffer`: the calculator reads the text before the command, the captured words are its parameter or inline input */
  readonly arg?: 'none' | 'buffer';
  /** the argument may be empty (`easter` = this year) */
  readonly optional?: boolean;
}

const Q = String.raw`what(?:'s|s| is| are| does| do| was)?|which|how (?:do|would|can|should) (?:i|you|we)|tell me|give me|show me|i need|i want|please|for me|quickly|is|are|the|a|an|of|for|in|do|does|use|uses|mean|means|meaning|they|we|you|it`;
const w = (extra: string): RegExp => new RegExp(String.raw`\b(?:${Q}|${extra})\b`, 'gi');

/** the calculator scaffold: only the question words, so units, dates and operators survive */
const CALC_Q = /\b(?:what(?:'s|s| is| are| does| do| was| would be)?|which|how (?:do|would|can|should) (?:i|you|we)|tell me|give me|show me|i need|i want|please|for me|quickly|calculate|compute|work out|the|a|an)\b/gi;

/** the text / encoding calculators take the writer's words verbatim (an article is data there: `ascii of a`): no word-list strip, only the leading question scaffold */
const RAW_Q = /(?!)/g;

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
  'date-plus': { blank: 'tables', keyword: 'table', keywords: ['from today'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
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
  'nth-weekday': { blank: 'tables', keyword: 'table', keywords: ['nth weekday'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'unix-now': { blank: 'tables', keyword: 'unix time', keywords: ['unix time', 'unix timestamp', 'epoch now', 'epoch time'], strip: CALC_Q, floor: 'calc', arg: 'none' },
  'unix-to-date': { blank: 'tables', keyword: 'unix', keywords: ['unix', 'epoch', 'timestamp'], strip: CALC_Q, floor: 'calc' },
  'iso-now': { blank: 'tables', keyword: 'iso now', keywords: ['iso now', 'iso date', 'iso 8601', 'todays date', 'today\'s date', 'date today'], strip: CALC_Q, floor: 'calc', arg: 'none' },
  'seconds-in': { blank: 'tables', keyword: 'seconds in', keywords: ['seconds in', 'minutes in', 'hours in'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'time-in': { blank: 'tables', keyword: 'time in', keywords: ['time in', 'what time is it in', 'current time in', 'local time in'], strip: CALC_Q, floor: 'calc' },
  'convert-time': { blank: 'tables', keyword: 'convert time', keywords: ['convert time', 'time convert'], strip: CALC_Q, floor: 'calc' },
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
  'choose': { blank: 'tables', keyword: 'table', keywords: ['choose', 'combinations', 'permutations', 'ncr', 'npr'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'probability': { blank: 'tables', keyword: 'probability of', keywords: ['probability of', 'chance of', 'odds of'], strip: CALC_Q, floor: 'calc' },
  'percent-off': { blank: 'tables', keyword: 'table', keywords: ['% off', 'percent off', 'off'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'percent-of-what': { blank: 'tables', keyword: 'table', keywords: ['is what percent of', 'is what % of', 'as a percentage of', 'what percent of'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'percent-change': { blank: 'tables', keyword: 'percent change', keywords: ['percent change', 'percentage change', 'percent increase', 'percent decrease', 'percentage increase', 'percentage decrease', 'change from'], strip: CALC_Q, floor: 'calc' },
  'percent-plus': { blank: 'tables', keyword: 'table', keywords: ['plus %', 'minus %'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'tip': { blank: 'tables', keyword: 'tip', keywords: ['tip'], strip: CALC_Q, floor: 'calc' },
  'split': { blank: 'tables', keyword: 'split', keywords: ['split'], strip: CALC_Q, floor: 'calc' },
  'vat': { blank: 'tables', keyword: 'plus vat', keywords: ['plus vat', 'inc vat', 'including vat', 'with vat', 'ex vat', 'excluding vat', 'without vat', 'minus vat', 'before vat', 'vat on', 'vat'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'compound': { blank: 'tables', keyword: 'compound', keywords: ['compound', 'compound interest', 'grow', 'invest'], strip: CALC_Q, floor: 'calc' },
  'simple-interest': { blank: 'tables', keyword: 'simple interest', keywords: ['simple interest'], strip: CALC_Q, floor: 'calc' },
  'monthly-payment': { blank: 'tables', keyword: 'monthly payment', keywords: ['monthly payment', 'mortgage', 'loan payment', 'repayment on', 'repayments on'], strip: CALC_Q, floor: 'calc' },
  'apr-to-monthly': { blank: 'tables', keyword: 'apr to monthly', keywords: ['apr to monthly', 'monthly rate for', 'apr'], strip: CALC_Q, floor: 'calc' },
  'doubling-time': { blank: 'tables', keyword: 'doubling time', keywords: ['doubling time', 'time to double', 'years to double'], strip: CALC_Q, floor: 'calc' },
  'margin': { blank: 'tables', keyword: 'margin', keywords: ['margin', 'markup', 'profit on'], strip: CALC_Q, floor: 'calc' },
  'break-even': { blank: 'tables', keyword: 'break even', keywords: ['break even', 'breakeven'], strip: CALC_Q, floor: 'calc' },
  'per-hour': { blank: 'tables', keyword: 'table', keywords: ['per hour', 'hourly', 'an hour'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'per-year': { blank: 'tables', keyword: 'table', keywords: ['per year', 'annually', 'a year', 'annual salary'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'unit-price': { blank: 'tables', keyword: 'unit price', keywords: ['unit price', 'price each', 'each'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'discount-to-reach': { blank: 'tables', keyword: 'discount to reach', keywords: ['discount to reach', 'discount from', 'what discount'], strip: CALC_Q, floor: 'calc' },
  'cagr': { blank: 'tables', keyword: 'cagr', keywords: ['cagr', 'growth rate', 'annual growth'], strip: CALC_Q, floor: 'calc' },
  'area-of': { blank: 'tables', keyword: 'area of', keywords: ['area of'], strip: CALC_Q, floor: 'calc' },
  'circumference': { blank: 'tables', keyword: 'circumference of', keywords: ['circumference of', 'circumference', 'perimeter of'], strip: CALC_Q, floor: 'calc' },
  'volume-of': { blank: 'tables', keyword: 'volume of', keywords: ['volume of'], strip: CALC_Q, floor: 'calc' },
  'surface-area': { blank: 'tables', keyword: 'surface area of', keywords: ['surface area of'], strip: CALC_Q, floor: 'calc' },
  'hypotenuse': { blank: 'tables', keyword: 'hypotenuse of', keywords: ['hypotenuse of', 'hypotenuse', 'pythagoras', 'missing side', 'other side'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'distance-between': { blank: 'tables', keyword: 'distance between', keywords: ['distance between', 'distance from'], strip: CALC_Q, floor: 'calc' },
  'deg-rad': { blank: 'tables', keyword: 'in radians', keywords: ['in radians', 'to radians', 'in degrees', 'to degrees'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'trig': { blank: 'tables', keyword: 'sin of', keywords: ['sin of', 'cos of', 'tan of', 'sine of', 'cosine of', 'tangent of', 'sin', 'cos', 'tan'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'slope': { blank: 'tables', keyword: 'angle of slope', keywords: ['angle of slope', 'slope of', 'gradient of', 'slope'], strip: CALC_Q, floor: 'calc' },
  'bmi': { blank: 'tables', keyword: 'bmi', keywords: ['bmi'], strip: CALC_Q, floor: 'calc' },
  'bmr': { blank: 'tables', keyword: 'bmr', keywords: ['bmr', 'basal metabolic rate', 'calories to maintain'], strip: CALC_Q, floor: 'calc' },
  'heart-rate': { blank: 'tables', keyword: 'heart rate zones', keywords: ['heart rate zones', 'heart rate zone', 'max heart rate', 'heart rate'], strip: CALC_Q, floor: 'calc' },
  'pace': { blank: 'tables', keyword: 'pace', keywords: ['pace', 'pace for'], strip: CALC_Q, floor: 'calc' },
  'speed': { blank: 'tables', keyword: 'speed', keywords: ['speed', 'average speed'], strip: CALC_Q, floor: 'calc' },
  'fuel': { blank: 'tables', keyword: 'fuel for', keywords: ['fuel for', 'fuel', 'petrol for', 'litres for'], strip: CALC_Q, floor: 'calc' },
  'mpg': { blank: 'tables', keyword: 'mpg to l/100km', keywords: ['mpg to l/100km', 'l/100km to mpg', 'mpg in l/100km', 'mpg'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'kinetic-energy': { blank: 'tables', keyword: 'kinetic energy of', keywords: ['kinetic energy of', 'kinetic energy'], strip: CALC_Q, floor: 'calc' },
  'free-fall': { blank: 'tables', keyword: 'free fall', keywords: ['free fall', 'freefall', 'drop for', 'fall for'], strip: CALC_Q, floor: 'calc' },
  'ohms-law': { blank: 'tables', keyword: 'ohm\'s law', keywords: ['ohm\'s law', 'ohms law', 'ohm law'], strip: CALC_Q, floor: 'calc' },
  'watts': { blank: 'tables', keyword: 'watts from', keywords: ['watts from', 'watts for', 'power from', 'watts'], strip: CALC_Q, floor: 'calc' },
  'kwh-cost': { blank: 'tables', keyword: 'kwh cost', keywords: ['kwh cost', 'electricity cost', 'cost to run', 'energy cost'], strip: CALC_Q, floor: 'calc' },
  'constant': { blank: 'tables', keyword: 'speed of light', keywords: ['speed of light', 'speed of sound', 'gravitational constant', 'planck constant', 'avogadro constant', 'avogadro', 'boltzmann constant', 'electron charge', 'absolute zero', 'golden ratio', 'astronomical unit', 'light year', 'parsec', 'distance to the moon', 'distance to the sun', 'radius of the earth', 'circumference of the earth', 'value of pi', 'eulers number'], strip: CALC_Q, floor: 'calc', keepKeyword: true, optional: true },
  'gravity-on': { blank: 'tables', keyword: 'gravity on', keywords: ['gravity on', 'escape velocity of', 'day length on', 'year on', 'weight on'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'half-life': { blank: 'tables', keyword: 'half-life', keywords: ['half-life', 'half life', 'remaining after'], strip: CALC_Q, floor: 'calc' },
  'decibels': { blank: 'tables', keyword: 'decibels', keywords: ['decibels', 'db plus', 'add decibels', 'db add'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'wavelength': { blank: 'tables', keyword: 'wavelength of', keywords: ['wavelength of', 'wavelength'], strip: CALC_Q, floor: 'calc' },
  'note-for': { blank: 'tables', keyword: 'note for', keywords: ['note for', 'note at', 'frequency of', 'pitch of'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'bpm': { blank: 'tables', keyword: 'bpm to ms', keywords: ['bpm to ms', 'ms per beat', 'bpm'], strip: CALC_Q, floor: 'calc' },
  'aspect-ratio': { blank: 'tables', keyword: 'aspect ratio of', keywords: ['aspect ratio of', 'aspect ratio', 'ratio of'], strip: CALC_Q, floor: 'calc' },
  'scale': { blank: 'tables', keyword: 'scale', keywords: ['scale', 'resize'], strip: CALC_Q, floor: 'calc' },
  'dpi': { blank: 'tables', keyword: 'pixels for', keywords: ['pixels for', 'dpi for', 'dpi'], strip: CALC_Q, floor: 'calc', keepKeyword: true },
  'download-time': { blank: 'tables', keyword: 'download time', keywords: ['download time', 'transfer time', 'time to download', 'how long to download'], strip: CALC_Q, floor: 'calc' },
  'word-count': { blank: 'tables', keyword: 'word count', keywords: ['word count', 'words in', 'how many words', 'count words'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'character-count': { blank: 'tables', keyword: 'character count', keywords: ['character count', 'char count', 'characters in', 'how many characters', 'letter count'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'sentence-count': { blank: 'tables', keyword: 'sentence count', keywords: ['sentence count', 'how many sentences', 'sentences in'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'line-count': { blank: 'tables', keyword: 'line count', keywords: ['line count', 'how many lines', 'lines in'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'reading-time': { blank: 'tables', keyword: 'reading time', keywords: ['reading time', 'time to read', 'how long to read', 'read time'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'speaking-time': { blank: 'tables', keyword: 'speaking time', keywords: ['speaking time', 'time to say', 'how long to say', 'speech time', 'talk time'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'longest-word': { blank: 'tables', keyword: 'longest word', keywords: ['longest word', 'longest word in'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'most-common-word': { blank: 'tables', keyword: 'most common word', keywords: ['most common word', 'most frequent word', 'top words', 'word frequency'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'count-of': { blank: 'tables', keyword: 'count of', keywords: ['count of', 'occurrences of', 'how many times does'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'reverse': { blank: 'tables', keyword: 'reverse', keywords: ['reverse', 'reversed', 'backwards'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'reverse-words': { blank: 'tables', keyword: 'reverse words', keywords: ['reverse words', 'words reversed', 'reverse word order'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'slug': { blank: 'tables', keyword: 'slug', keywords: ['slug', 'slugify', 'slug for', 'url slug for'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'title-case': { blank: 'tables', keyword: 'title case', keywords: ['title case', 'titlecase', 'capitalize words', 'capitalise words'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'sentence-case': { blank: 'tables', keyword: 'sentence case', keywords: ['sentence case', 'sentencecase'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'upper-case': { blank: 'tables', keyword: 'upper case', keywords: ['upper case', 'uppercase', 'in caps', 'all caps', 'to upper', 'capitalize', 'capitalise'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'lower-case': { blank: 'tables', keyword: 'lower case', keywords: ['lower case', 'lowercase', 'to lower', 'in lowercase'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'snake-case': { blank: 'tables', keyword: 'snake case', keywords: ['snake case', 'snake_case', 'snakecase', 'to snake'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'camel-case': { blank: 'tables', keyword: 'camel case', keywords: ['camel case', 'camelcase', 'camelCase', 'to camel'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'pascal-case': { blank: 'tables', keyword: 'pascal case', keywords: ['pascal case', 'pascalcase', 'PascalCase', 'to pascal'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'kebab-case': { blank: 'tables', keyword: 'kebab case', keywords: ['kebab case', 'kebab-case', 'kebabcase', 'to kebab', 'dash case'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'constant-case': { blank: 'tables', keyword: 'constant case', keywords: ['constant case', 'screaming snake', 'upper snake', 'to constant'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'strip-whitespace': { blank: 'tables', keyword: 'strip whitespace', keywords: ['strip whitespace', 'collapse whitespace', 'trim whitespace', 'remove extra spaces', 'single spaces'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'dedupe-lines': { blank: 'tables', keyword: 'dedupe lines', keywords: ['dedupe lines', 'deduplicate lines', 'unique lines', 'remove duplicate lines', 'dedupe'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'sort-lines': { blank: 'tables', keyword: 'sort lines', keywords: ['sort lines', 'sort lines desc', 'sort lines descending', 'sort lines reverse', 'sort alphabetically', 'sort lines numerically', 'sort'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'number-lines': { blank: 'tables', keyword: 'number the lines', keywords: ['number the lines', 'number lines', 'numbered list', 'add line numbers'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'bullet-lines': { blank: 'tables', keyword: 'bullet the lines', keywords: ['bullet the lines', 'bullet lines', 'bullet list', 'as bullets'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'wrap-at': { blank: 'tables', keyword: 'wrap at', keywords: ['wrap at', 'wrap to', 'hard wrap at', 'rewrap at'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'truncate-to': { blank: 'tables', keyword: 'truncate to', keywords: ['truncate to', 'truncate at', 'cut to', 'first n chars', 'shorten to'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'initials': { blank: 'tables', keyword: 'initials of', keywords: ['initials of', 'initials for', 'initials'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'acronym': { blank: 'tables', keyword: 'acronym for', keywords: ['acronym for', 'acronym of', 'acronym'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'repeat': { blank: 'tables', keyword: 'repeat', keywords: ['repeat', 'repeated', 'times'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'pad-to': { blank: 'tables', keyword: 'pad to', keywords: ['pad to', 'left pad', 'zero pad', 'pad left', 'pad right'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'lorem': { blank: 'tables', keyword: 'lorem', keywords: ['lorem', 'lorem ipsum', 'placeholder text', 'dummy text'], strip: RAW_Q, floor: 'raw', optional: true },
  'base64-encode': { blank: 'tables', keyword: 'base64 for', keywords: ['base64 for', 'base64 encode', 'to base64', 'base64 of', 'base64'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'base64-decode': { blank: 'tables', keyword: 'decode base64', keywords: ['decode base64', 'base64 decode', 'from base64', 'unbase64'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'url-encode': { blank: 'tables', keyword: 'url encode', keywords: ['url encode', 'urlencode', 'percent encode', 'uri encode', 'encode for url'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'url-decode': { blank: 'tables', keyword: 'url decode', keywords: ['url decode', 'urldecode', 'percent decode', 'uri decode'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'html-escape': { blank: 'tables', keyword: 'html escape', keywords: ['html escape', 'escape html', 'html encode', 'html entities for'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'html-unescape': { blank: 'tables', keyword: 'html unescape', keywords: ['html unescape', 'unescape html', 'html decode', 'decode html'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'hex-encode': { blank: 'tables', keyword: 'hex encode', keywords: ['hex encode', 'to hex bytes', 'hex of', 'as hex bytes', 'bytes of'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'hex-decode': { blank: 'tables', keyword: 'hex decode', keywords: ['hex decode', 'from hex bytes', 'decode hex'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'binary-of': { blank: 'tables', keyword: 'binary of', keywords: ['binary of', 'binary for', 'in binary bytes', 'ascii binary'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'ascii-of': { blank: 'tables', keyword: 'ascii of', keywords: ['ascii of', 'ascii for', 'ascii code for', 'char code of', 'code point of', 'codepoint of', 'unicode of'], strip: RAW_Q, floor: 'raw' },
  'unix-permissions': { blank: 'tables', keyword: 'chmod', keywords: ['chmod', 'unix permissions', 'permissions', 'file mode'], strip: RAW_Q, floor: 'raw' },
  'ip-to-int': { blank: 'tables', keyword: 'ip to int', keywords: ['ip to int', 'ip to number', 'ip as integer', 'ip to decimal'], strip: RAW_Q, floor: 'raw' },
  'int-to-ip': { blank: 'tables', keyword: 'int to ip', keywords: ['int to ip', 'number to ip', 'integer to ip'], strip: RAW_Q, floor: 'raw' },
  'cidr': { blank: 'tables', keyword: 'cidr', keywords: ['cidr', 'subnet', 'ip range for', 'netmask for'], strip: RAW_Q, floor: 'raw' },
  'is-valid': { blank: 'tables', keyword: 'is valid', keywords: ['is valid', 'validate', 'is this a valid', 'check format'], strip: RAW_Q, floor: 'raw' },
  'color-contrast': { blank: 'tables', keyword: 'color contrast', keywords: ['color contrast', 'colour contrast', 'contrast ratio', 'contrast between', 'wcag contrast'], strip: RAW_Q, floor: 'raw' },
  'hex-to-hsl': { blank: 'tables', keyword: 'hex to hsl', keywords: ['hex to hsl', 'hsl for', 'hsl of', 'to hsl', 'in hsl'], strip: RAW_Q, floor: 'raw' },
  'lighten': { blank: 'tables', keyword: 'lighten', keywords: ['lighten', 'darken', 'lighter', 'darker'], strip: RAW_Q, floor: 'raw', keepKeyword: true },
  'json-pretty': { blank: 'tables', keyword: 'json pretty', keywords: ['json pretty', 'pretty json', 'format json', 'prettify json'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'json-minify': { blank: 'tables', keyword: 'json minify', keywords: ['json minify', 'minify json', 'compact json', 'json compact'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'json-validate': { blank: 'tables', keyword: 'json validate', keywords: ['json validate', 'validate json', 'is valid json', 'check json'], strip: RAW_Q, floor: 'raw', arg: 'buffer', optional: true },
  'uuid': { blank: 'tables', keyword: 'uuid', keywords: ['uuid', 'new uuid', 'generate uuid', 'guid', 'uuid v4', 'uuid v7'], strip: RAW_Q, floor: 'raw', keepKeyword: true, optional: true },
  'random': { blank: 'tables', keyword: 'random number', keywords: ['random number', 'random between', 'random from', 'random'], strip: RAW_Q, floor: 'raw', optional: true },
  'random-pick': { blank: 'tables', keyword: 'random pick', keywords: ['random pick', 'pick one of', 'pick from', 'choose one of', 'pick one'], strip: RAW_Q, floor: 'raw' },
  'coin-flip': { blank: 'tables', keyword: 'coin flip', keywords: ['coin flip', 'flip a coin', 'heads or tails', 'toss a coin'], strip: RAW_Q, floor: 'raw', arg: 'none' },
  'dice': { blank: 'tables', keyword: 'roll', keywords: ['roll', 'dice', 'roll dice', 'roll a d'], strip: RAW_Q, floor: 'raw', keepKeyword: true, optional: true },
};

export const DATA_ARG_MAX = 60;
export const DATA_EXPR_MAX = 80;
export const DATA_CALC_MAX = 100;
export const DATA_RAW_MAX = 500;

/** The floor a captured argument passes before it reaches a table (security-audit #23, the AI-callable arg floor). */
export function dataArgWithinFloor(arg: string, expr: boolean | 'text' | 'expr' | 'calc' | 'raw'): boolean {
  if (!arg) return false;
  const kind = expr === true ? 'expr' : expr === false ? 'text' : expr;
  // a text / encoding input is the writer's own words, encoded or counted locally and never executed: only length and control chars are floored
  if (kind === 'raw') return arg.length <= DATA_RAW_MAX;
  // a calculator phrase: words, numbers, dates, clock times, fractions, a few operators; never shell / URL / code structure
  if (kind === 'calc') return arg.length <= DATA_CALC_MAX && /^[\p{L}\d\s.,:/'#%+*^()–-]+$/u.test(arg) && !/[a-z_]\(|https?:|\/\//i.test(arg);
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
  let arg = seg.replace(/[?!]+\s*$/, '').replace(entry.floor === 'calc' || entry.floor === 'raw' ? /[;]+/g : /[,;:]+/g, ' ');
  // a buffer calculator: only what follows the keyword is an inline argument; text before it on the same line is the buffer
  if (entry.arg === 'buffer' && entry.keywords) {
    const low = arg.toLowerCase();
    for (const k of [...entry.keywords].sort((a, b) => b.length - a.length)) { const at = low.indexOf(k); if (at >= 0) { arg = arg.slice(at + k.length).trim(); break; } }
  }
  // the calculator's own keyword goes first (before the scaffold strip can break a multi-word one), wherever it sits
  if (entry.keywords && !entry.keepKeyword && entry.arg !== 'buffer') {
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
  // a phrase-routed calculator (`85 is what percent of 340`, `80000 a year per hour`) needs its phrase intact: only the leading scaffold goes
  if (entry.keyword !== 'table') arg = lead(arg.replace(entry.strip, ' ').replace(/\s+/g, ' ').trim());
  // a buffer calculator: `make this lower case`, `turn it into a slug`, `this text as title case` are the command, not the input
  if (entry.arg === 'buffer') arg = arg.replace(/^(?:(?:make|turn|put|convert|change|render|format)\s+(?:this|it|that|the text|the above|everything)\s*(?:into|to|in|as)?|(?:this|it|that|the text|the above)\s*(?:into|to|in|as)?)\s*/i, '').replace(/^(?:for|of|on|this|the text)\s+/i, '');
  if (!arg && entry.optional) return '';
  return dataArgWithinFloor(arg, entry.floor ?? entry.expr === true) ? arg : null;
}

/** The invocation a verdict resolves to under the policy, or null when it resolves to nothing invocable. */
export function resolveDataInvocation(v: TableVerdict, draft: string): { blank: string; keyword: string; action: 'get'; value: string } | null {
  const entry = DATA_POLICY[v.table];
  if (!entry) return null;
  const arg = captureDataArg(v.table, draft);
  if (arg === null) return null;
  // a phrase-routed calculator is named by id: the runtime runs it directly, no phrase grammar in between
  const keyword = entry.keyword === 'table' ? `table:${v.table}` : entry.keyword;
  return { blank: entry.blank, keyword, action: 'get', value: arg };
}

/** The canonical command the blank's own shapes accept for an invocation: `hex for tomato _`, `calc 17 * 23 _`, `capital of france _`. */
export function dataCanonicalCommand(inv: { keyword: string; value: string }): string {
  return `${inv.keyword} ${inv.value} _`;
}
