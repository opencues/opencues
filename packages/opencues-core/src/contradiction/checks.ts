/**
 * Contradiction checks — the "local gate → mismatch test" heart of the
 * contradiction-cue layer (docs/research/life-context-concepts/contradiction-cues.md).
 *
 * Each check is a PURE function over the buffer's words + a small environment
 * (the clock for Tier 0; later tiers add cached data). It returns zero or more
 * `Contradiction`s — a word-index span to flag, an optional in-place correction,
 * and the one-line tip the status bar shows. No LLM, no network: Tier-0 cues are
 * deterministic date/number arithmetic against the buffer itself, so they are
 * free, universal, and fast (the "ship these first" tier).
 *
 * Design rules honoured (from the concept doc):
 *  - precision over recall — a wrong cue trains distrust, so every check bails
 *    to silence on any ambiguity rather than guessing.
 *  - the correction is DATA, never generation (we compute the weekday / the
 *    arithmetic; we never ask a model to).
 */

export interface Contradiction {
  /** Word index of the first flagged word (inclusive). */
  readonly startWord: number;
  /** Word index just past the last flagged word (exclusive). */
  readonly endWord: number;
  /** Optional corrected phrase offered as the cycle alternative (alt[1]). */
  readonly correction?: string;
  /** One-line advisory shown in the status bar (no leading glyph). */
  readonly tip: string;
  /** Which check fired — becomes part of the cue source id. */
  readonly check: string;
}

/** Ambient facts a check may consult. Tier 0 needs only the clock; later tiers
 *  widen this (bank holidays, weather, transit …) without changing the shape. */
export interface ContradictionEnv {
  /** "Now", injected so checks are deterministic under test. */
  readonly now: Date;
}

export type ContradictionCheck = (words: readonly string[], env: ContradictionEnv) => Contradiction[];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** Strip surrounding punctuation and lowercase, for token matching. */
function norm(w: string): string { return w.toLowerCase().replace(/^[^a-z0-9$]+|[^a-z0-9]+$/g, ''); }

/** Parse an ordinal/cardinal day-of-month token ("24th", "3rd", "24"). 1–31 or null. */
function parseDay(w: string): number | null {
  const m = norm(w).match(/^(\d{1,2})(st|nd|rd|th)?$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  return d >= 1 && d <= 31 ? d : null;
}

function weekdayIndex(w: string): number | null {
  const n = norm(w);
  const full = WEEKDAYS.indexOf(n);
  if (full >= 0) return full;
  return n in WEEKDAY_ABBR ? WEEKDAY_ABBR[n] : null;
}

function monthIndex(w: string): number | null {
  const n = norm(w);
  const full = MONTHS.indexOf(n);
  if (full >= 0) return full;
  return n in MONTH_ABBR ? MONTH_ABBR[n] : null;
}

/** UTC-stable weekday (0=Sun) for a Y/M/D — avoids TZ drift. */
function weekdayOf(year: number, monthIdx: number, day: number): number {
  return new Date(Date.UTC(year, monthIdx, day)).getUTCDay();
}

/** Is (year, monthIdx, day) a real calendar date? (rejects the 30th of Feb etc.) */
function isRealDate(year: number, monthIdx: number, day: number): boolean {
  const d = new Date(Date.UTC(year, monthIdx, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === monthIdx && d.getUTCDate() === day;
}

/**
 * Resolve which concrete date the writer means by a bare day (+ optional month).
 * Bare "the 24th" → the NEXT 24th from `now` (this month if not past, else next).
 * "August 24th" → the 24th of that August (this year, or next year if already past).
 * Returns null if the date isn't real (so we never flag a nonexistent date).
 */
function resolveDate(day: number, monthIdx: number | null, now: Date): { year: number; monthIdx: number; day: number } | null {
  const ty = now.getFullYear(), tm = now.getMonth(), td = now.getDate();
  let year: number, month: number;
  if (monthIdx !== null) {
    year = ty; month = monthIdx;
    if (month < tm || (month === tm && day < td)) year += 1;      // that month already passed → next year
  } else {
    year = ty; month = tm;
    if (day < td) { month += 1; if (month > 11) { month = 0; year += 1; } }  // this month's day passed → next month
  }
  return isRealDate(year, month, day) ? { year, monthIdx: month, day } : null;
}

/** Replace the weekday name at the start of a token, keeping trailing punctuation
 *  ("Monday," → "Sunday,"). */
function swapWeekday(token: string, newWeekday: string): string {
  const n = norm(token);
  const start = token.toLowerCase().indexOf(n);
  const trailing = start >= 0 ? token.slice(start + n.length) : '';
  return newWeekday + trailing;
}

/** Swap the weekday name inside a multi-word phrase ("Thursday the 24th" →
 *  "Friday the 24th"), preserving spacing + the rest of the phrase. Replaces the
 *  first token that IS a weekday (via the per-token swapWeekday, so "Monday,"
 *  keeps its comma). If no weekday token is found the phrase is returned as-is. */
function swapWeekdayInPhrase(phrase: string, newWeekday: string): string {
  const parts = phrase.split(/(\s+)/);   // keep the whitespace separators
  for (let k = 0; k < parts.length; k++) {
    if (weekdayIndex(parts[k]) !== null) { parts[k] = swapWeekday(parts[k], newWeekday); break; }
  }
  return parts.join('');
}

const ordinalSuffix = (d: number): string => {
  if (d >= 11 && d <= 13) return 'th';
  return (['th', 'st', 'nd', 'rd'][d % 10] ?? 'th');
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * WEEKDAY–DATE MISMATCH — the ship-first flagship. "see you Thursday the 24th"
 * when the 24th is a Friday. Matches `<weekday> [the] <day>` and
 * `<weekday>[,] <month> <day>`; computes the real weekday and flags a mismatch,
 * offering the right weekday as the correction.
 */
export const weekdayDateCheck: ContradictionCheck = (words, env) => {
  const out: Contradiction[] = [];
  for (let i = 0; i < words.length; i++) {
    const wd = weekdayIndex(words[i]);
    if (wd === null) continue;
    // Look ahead a few tokens for an optional month then a day, skipping only
    // the filler word "the" / "of" / a comma-word. Anything else breaks the phrase.
    let j = i + 1, monthIdx: number | null = null;
    const FILLER = new Set(['the', 'of', '']);
    let steps = 0;
    while (j < words.length && steps < 4) {
      const n = norm(words[j]);
      const mi = monthIndex(words[j]);
      const day = parseDay(words[j]);
      if (day !== null) {
        const resolved = resolveDate(day, monthIdx, env.now);
        if (!resolved) break;
        const actual = weekdayOf(resolved.year, resolved.monthIdx, resolved.day);
        if (actual !== wd) {
          out.push({
            startWord: i,
            endWord: j + 1,
            // Correction = the phrase with the weekday name swapped for the real
            // one, trailing punctuation ("Monday," → "Sunday,") preserved.
            correction: [swapWeekday(words[i], cap(WEEKDAYS[actual])), ...words.slice(i + 1, j + 1)].join(' '),
            tip: `the ${day}${ordinalSuffix(day)} is a ${cap(WEEKDAYS[actual])}, not ${cap(WEEKDAYS[wd])}`,
            check: 'weekday-date',
          });
        }
        break;
      }
      if (mi !== null) { monthIdx = mi; j++; steps++; continue; }
      if (FILLER.has(n)) { j++; steps++; continue; }
      break;   // an unrelated word — this weekday isn't part of a date phrase
    }
  }
  return out;
};

/**
 * SPLIT-THE-BILL MATH — "$120 among 4, that's $25 each" when it's $30. Extracts
 * a bill total, a headcount, and a stated per-person figure from the sentence and
 * checks the division. Bails unless all three are present and unambiguous.
 */
export const splitBillCheck: ContradictionCheck = (words) => {
  const text = words.join(' ');
  // The bill total must carry a currency mark; the per-person figure may be bare
  // ("$120 among 4 so 25 each") — people drop the $ on the second number.
  const totalMatch = text.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/);
  if (!totalMatch) return [];
  const perMatch = text.match(/\$?\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:each|apiece|per person|per head|pp\b|a head)/i);
  if (!perMatch) return [];
  const per = parseFloat(perMatch[1].replace(/,/g, ''));
  // headcount: a digit OR a spelled-out number ("four") — the formalizer often
  // rewrites "4" → "four", so both must count. "<N> people/…", "among/for <N>",
  // "<N> ways/way".
  const NUM = '(\\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  const countMatch = text.match(new RegExp(`\\b${NUM}\\s*(?:people|persons?|of us|ways|friends|guests|folks|attendees?|individuals?)\\b`, 'i'))
    ?? text.match(new RegExp(`\\b(?:among|between|split(?:\\s+\\w+)?|share(?:d)?\\s+(?:with|between)|for)\\s+${NUM}\\b`, 'i'))
    ?? text.match(new RegExp(`\\b${NUM}[\\s-]?way\\b`, 'i'));
  if (!countMatch) return [];
  const raw = countMatch[1].toLowerCase();
  const count = /^\d+$/.test(raw) ? parseInt(raw, 10)
    : ({ two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 } as Record<string, number>)[raw] ?? NaN;
  if (!(count >= 2 && count <= 100)) return [];
  // total = the largest $-marked figure that isn't the per-person figure.
  const allMoney = [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
  const total = Math.max(...allMoney.filter((v) => v !== per));
  if (!isFinite(total) || total <= per) return [];
  const correct = total / count;
  // round to cents; flag only a real discrepancy (> 1 cent).
  if (Math.abs(correct - per) <= 0.01) return [];
  // anchor on the per-person number token (the one followed by "each"/…).
  let startWord = words.length - 1;
  const perNum = perMatch[1].replace(/,/g, '');
  for (let k = 0; k < words.length; k++) {
    if (words[k].replace(/[^0-9.]/g, '') === perNum && /each|apiece|person|head|pp/i.test(`${words[k + 1] ?? ''} ${words[k + 2] ?? ''}`)) { startWord = k; break; }
  }
  const fmt = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
  return [{
    startWord,
    endWord: Math.min(startWord + 2, words.length),
    correction: `${fmt(correct)} each`,
    tip: `${fmt(total)} ÷ ${count} = ${fmt(correct)} each, not ${fmt(per)}`,
    check: 'split-bill',
  }];
};

/** The Tier-0 check set (buffer + clock only — no data, no LLM). */
// ── LLM-extracted, code-verified claims ───────────────────────────────────────
//
// The LLM's ONLY job is to parse the sentence into a structured, GROUNDED claim
// (every value quoted verbatim). It never judges correctness. These verifiers
// are the judge: they (1) re-check every quote is literally present in the
// sentence — so the model cannot hallucinate a value into a false cue — and
// (2) compute the truth deterministically and compare. A cue fires ONLY when
// grounding passes AND the math/date disagrees.

export interface WeekdayDateClaim {
  readonly type: 'weekday_date';
  readonly weekday: string;
  readonly day: number;
  readonly month?: string | null;
  readonly quote: string;
}
export interface BillSplitClaim {
  readonly type: 'bill_split';
  readonly total: number;
  readonly count: number;
  readonly perPerson: number;
  readonly quotes: { readonly total: string; readonly count: string; readonly perPerson: string };
}
export interface ArithmeticClaim {
  readonly type: 'arithmetic';
  readonly expression: string;
  readonly statedResult: number;
  readonly quote: string;
}
export type Claim = WeekdayDateClaim | BillSplitClaim | ArithmeticClaim;

export interface VerifiedContradiction {
  readonly quote: string;
  readonly tip: string;
  readonly correction?: string;
  readonly check: string;
}

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

/** Verify a grounded claim: contradiction only when every quote is literally
 *  present AND the computed truth disagrees. This is the anti-misfire backstop. */
export function verifyClaim(claim: Claim, sentence: string, now: Date): VerifiedContradiction | null {
  const present = (q: string) => typeof q === 'string' && q.length > 0 && sentence.includes(q);
  switch (claim.type) {
    case 'weekday_date': {
      if (!present(claim.quote)) return null;
      const wd = weekdayIndex(claim.weekday);
      if (wd === null || !(claim.day >= 1 && claim.day <= 31)) return null;
      const monthIdx = claim.month ? monthIndex(claim.month) : null;
      const resolved = resolveDate(claim.day, monthIdx, now);
      if (!resolved) return null;
      const actual = weekdayOf(resolved.year, resolved.monthIdx, resolved.day);
      if (actual === wd) return null;
      return {
        quote: claim.quote,
        tip: `the ${claim.day}${ordinalSuffix(claim.day)} is a ${cap(WEEKDAYS[actual])}, not ${cap(WEEKDAYS[wd])}`,
        // Swap ONLY the weekday word inside the verbatim quote (the quote is a
        // phrase — "Thursday the 24th" — so swapWeekday, which is per-token, must
        // run on the weekday token alone, not the whole string).
        correction: swapWeekdayInPhrase(claim.quote, cap(WEEKDAYS[actual])),
        check: 'weekday-date',
      };
    }
    case 'bill_split': {
      const { total, count, perPerson, quotes } = claim;
      if (!quotes || !present(quotes.total) || !present(quotes.count) || !present(quotes.perPerson)) return null;
      if (!(count >= 2 && count <= 1000) || total <= 0 || perPerson <= 0 || total <= perPerson) return null;
      const correct = total / count;
      if (near(correct, perPerson)) return null;
      const fmt = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
      return {
        quote: quotes.perPerson,
        tip: `${fmt(total)} ÷ ${count} = ${fmt(correct)} each, not ${fmt(perPerson)}`,
        correction: `${fmt(correct)} each`,
        check: 'bill-split',
      };
    }
    case 'arithmetic': {
      if (!present(claim.quote)) return null;
      const value = safeEvalArithmetic(claim.expression);
      if (value === null || near(value, claim.statedResult)) return null;
      const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
      return { quote: claim.quote, tip: `${claim.expression} = ${fmtN(value)}, not ${fmtN(claim.statedResult)}`, check: 'arithmetic' };
    }
    default:
      return null;
  }
}

/** Evaluate a simple arithmetic expression (+ - * / % and parens) with NO code
 *  execution (a tiny shunting-yard) — the LLM's `expression` can never run JS. */
export function safeEvalArithmetic(expr: string): number | null {
  if (typeof expr !== 'string' || !/^[\d\s.+\-*/%()]+$/.test(expr)) return null;
  const toks = expr.match(/\d+\.?\d*|[+\-*/%()]/g);
  if (!toks) return null;
  const out: number[] = [], ops: string[] = [];
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  const apply = () => {
    const op = ops.pop()!; const b = out.pop(); const a = out.pop();
    if (typeof a !== 'number' || typeof b !== 'number') throw new Error('bad');
    out.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b);
  };
  try {
    for (const t of toks) {
      if (/^\d/.test(t)) out.push(parseFloat(t));
      else if (t === '(') ops.push(t);
      else if (t === ')') { while (ops.length && ops[ops.length - 1] !== '(') apply(); ops.pop(); }
      else { while (ops.length && prec[ops[ops.length - 1]] >= prec[t]) apply(); ops.push(t); }
    }
    while (ops.length) apply();
    const r = out.pop();
    return typeof r === 'number' && isFinite(r) && out.length === 0 ? r : null;
  } catch { return null; }
}

export const TIER0_CHECKS: readonly ContradictionCheck[] = [weekdayDateCheck, splitBillCheck];
