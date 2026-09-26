/**
 * Claim capture — the grammar half of select-then-compute for the
 * contradiction cues. A decision names WHICH claim type a sentence makes
 * (a closed choice, or `none`); this module cuts the operands from the
 * writer's own words; `verifyClaim` in checks.ts computes the truth. The
 * model never emits a value: every field of a captured claim is a verbatim
 * substring of the sentence by construction, which is the same grounding
 * the LLM-extract path enforces after the fact.
 *
 * Precision over recall, as everywhere in this layer: when the grammar
 * cannot find every operand a type needs, the capture returns null and the
 * sentence stays silent. Nothing here reads the clock — resolution against
 * `now` is the verifier's.
 */
import { norm, parseDay, weekdayIndex, monthIndex, type Claim, type WeekdayDateClaim, type BillSplitClaim, type ArithmeticClaim, type WorkdayOnHolidayClaim, type OutdoorPlanWeatherClaim, type TubeLinePlanClaim, type JourneyUnderestimateClaim } from './checks';
import type { JourneyMode } from './journey';

export type ClaimType = Claim['type'];
export const CLAIM_TYPES: ReadonlyArray<ClaimType> = ['weekday_date', 'bill_split', 'arithmetic', 'workday_on_holiday', 'outdoor_plan_weather', 'tube_line_plan', 'journey_underestimate'];

const WEEKDAY_RE = '(?:sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?';
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAY_RE = '(\\d{1,2})(?:st|nd|rd|th)?';
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const money = (s: string): number => parseFloat(s.replace(/[^0-9.]/g, ''));

/** A date reference in the sentence: weekday and/or day-of-month (+ month), with the verbatim quote. */
export interface DateRef { readonly weekday: string | null; readonly day: number | null; readonly month: string | null; readonly quote: string; readonly index: number }

/**
 * The first date reference in the sentence, in any of the shapes the
 * verifier resolves: `Thursday the 24th`, `Monday 25 December`, `Friday,
 * July 24`, `the 25th`, `25th of December`, `December 25`, or a bare
 * weekday. A weekday directly attached to a day keeps both.
 */
export function captureDateRef(sentence: string): DateRef | null {
  const s = sentence;
  const patterns: Array<{ re: RegExp; pick: (m: RegExpMatchArray) => Omit<DateRef, 'quote' | 'index'> }> = [
    // weekday [the] day [month]  /  weekday[,] month day  /  weekday[,] day month
    { re: new RegExp(`\\b(${WEEKDAY_RE})\\b,?\\s+(?:the\\s+)?${DAY_RE}(?:\\s+(?:of\\s+)?(${MONTH_RE})\\b)?`, 'i'), pick: (m) => ({ weekday: m[1], day: parseInt(m[2], 10), month: m[3] ?? null }) },
    { re: new RegExp(`\\b(${WEEKDAY_RE})\\b,?\\s+(${MONTH_RE})\\s+${DAY_RE}\\b`, 'i'), pick: (m) => ({ weekday: m[1], day: parseInt(m[3], 10), month: m[2] }) },
    // day month / month day / the day
    { re: new RegExp(`\\b(?:the\\s+)?${DAY_RE}\\s+(?:of\\s+)?(${MONTH_RE})\\b`, 'i'), pick: (m) => ({ weekday: null, day: parseInt(m[1], 10), month: m[2] }) },
    { re: new RegExp(`\\b(${MONTH_RE})\\s+${DAY_RE}\\b`, 'i'), pick: (m) => ({ weekday: null, day: parseInt(m[2], 10), month: m[1] }) },
    { re: new RegExp(`\\bthe\\s+${DAY_RE}\\b`, 'i'), pick: (m) => ({ weekday: null, day: parseInt(m[1], 10), month: null }) },
    // a bare weekday
    { re: new RegExp(`\\b(${WEEKDAY_RE})\\b`, 'i'), pick: (m) => ({ weekday: m[1], day: null, month: null }) },
  ];
  for (const p of patterns) {
    const m = s.match(p.re);
    if (!m || m.index === undefined) continue;
    const r = p.pick(m);
    if (r.day !== null && !(r.day >= 1 && r.day <= 31)) continue;
    if (r.weekday && weekdayIndex(r.weekday) === null) continue;
    if (r.month && monthIndex(r.month) === null) continue;
    return { ...r, quote: m[0], index: m.index };
  }
  return null;
}

function captureWeekdayDate(sentence: string): WeekdayDateClaim | null {
  const ref = captureDateRef(sentence);
  if (!ref || !ref.weekday || ref.day === null) return null;
  // a bare weekday and a day elsewhere in the sentence are not one date
  return { type: 'weekday_date', weekday: ref.weekday, day: ref.day, month: ref.month, quote: ref.quote };
}

function captureBillSplit(sentence: string): BillSplitClaim | null {
  const per = sentence.match(/(\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?)\s*(?:each|apiece|per person|per head|pp\b|a head)/i);
  if (!per) return null;
  const perPerson = money(per[1]);
  const NUM = '(\\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  const count = sentence.match(new RegExp(`\\b${NUM}\\s*(?:people|persons?|of us|ways|friends|guests|folks|attendees?|individuals?)\\b`, 'i'))
    ?? sentence.match(new RegExp(`\\b(?:among|between|split(?:\\s+\\w+)?|share(?:d)?\\s+(?:with|between)|for)\\s+${NUM}\\b`, 'i'))
    ?? sentence.match(new RegExp(`\\b${NUM}[\\s-]?way\\b`, 'i'));
  if (!count) return null;
  const raw = count[1].toLowerCase();
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NUMBER_WORDS[raw];
  if (!(n >= 2 && n <= 1000)) return null;
  // the total: the largest $-marked figure that is not the per-person one
  const totals = [...sentence.matchAll(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g)].map((m) => ({ q: m[0], v: money(m[0]) })).filter((t) => t.v !== perPerson);
  if (totals.length === 0) return null;
  const total = totals.reduce((a, b) => (b.v > a.v ? b : a));
  if (total.v <= perPerson) return null;
  return { type: 'bill_split', total: total.v, count: n, perPerson, quotes: { total: total.q, count: count[0], perPerson: per[0] } };
}

function captureArithmetic(sentence: string): ArithmeticClaim | null {
  const N = '\\$?\\s?(\\d[\\d,]*(?:\\.\\d+)?)';
  const EQ = '(?:=|is|equals|comes? to|makes|gives|totals?|works out (?:to|at)|leaves)';
  // p% of a = c   /   a plus p% = c   /   a with p% off = c   (before the plain form, which would read `50 plus 20` off `$50 plus 20%`)
  let m = sentence.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)\\s+of\\s+${N}\\s*${EQ}\\s*${N}`, 'i'));
  if (m) return { type: 'arithmetic', expression: `${m[2].replace(/,/g, '')}*${m[1]}/100`, statedResult: money(m[3]), quote: m[0].trim() };
  m = sentence.match(new RegExp(`${N}\\s*(?:plus|\\+|with)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)(?:\\s+(?:tax|vat|tip|on top|added))?\\s*${EQ}\\s*${N}`, 'i'));
  if (m) return { type: 'arithmetic', expression: `${m[1].replace(/,/g, '')}*(1+${m[2]}/100)`, statedResult: money(m[3]), quote: m[0].trim() };
  m = sentence.match(new RegExp(`${N}\\s*(?:minus|less|with|at)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)\\s*(?:off|discount|down)?\\s*${EQ}\\s*${N}`, 'i'));
  if (m) return { type: 'arithmetic', expression: `${m[1].replace(/,/g, '')}*(1-${m[2]}/100)`, statedResult: money(m[3]), quote: m[0].trim() };
  m = sentence.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)\\s+off,?\\s+${N}\\s*${EQ}\\s*${N}`, 'i'));
  if (m) return { type: 'arithmetic', expression: `${m[2].replace(/,/g, '')}*(1-${m[1]}/100)`, statedResult: money(m[3]), quote: m[0].trim() };
  // a × b = c   /   a + b = c   /   a - b = c   /   a / b = c
  m = sentence.match(new RegExp(`${N}\\s*([+\\-*/x×÷]|plus|minus|times|divided by|over)\\s*${N}\\s*(?:%\\s*)?${EQ}\\s*${N}`, 'i'));
  if (m) {
    const op = ({ plus: '+', minus: '-', times: '*', x: '*', '×': '*', 'divided by': '/', over: '/', '÷': '/' } as Record<string, string>)[m[2].toLowerCase()] ?? m[2];
    return { type: 'arithmetic', expression: `${m[1].replace(/,/g, '')}${op}${m[3].replace(/,/g, '')}`, statedResult: money(m[4]), quote: m[0].trim() };
  }
  return null;
}

function captureDated<T extends 'workday_on_holiday' | 'outdoor_plan_weather'>(type: T, sentence: string): (WorkdayOnHolidayClaim | OutdoorPlanWeatherClaim) & { type: T } | null {
  const ref = captureDateRef(sentence);
  if (!ref) return null;
  // quote the whole clause around the date so the flagged span reads as the plan, not a bare weekday
  return { type, weekday: ref.weekday, day: ref.day, month: ref.month, quote: ref.quote } as (WorkdayOnHolidayClaim | OutdoorPlanWeatherClaim) & { type: T };
}

const LINES = ['Bakerloo', 'Central', 'Circle', 'District', 'Hammersmith & City', 'Hammersmith and City', 'Jubilee', 'Metropolitan', 'Northern', 'Piccadilly', 'Victoria', 'Waterloo & City', 'Waterloo and City', 'Elizabeth', 'DLR', 'Overground', 'Liberty', 'Lioness', 'Mildmay', 'Suffragette', 'Weaver', 'Windrush'];
function captureTubeLine(sentence: string): TubeLinePlanClaim | null {
  const alt = LINES.map((l) => l.replace(/&/g, '&')).join('|');
  const m = sentence.match(new RegExp(`\\b(?:the\\s+)?(${alt})(?:\\s+line)?\\b`, 'i'));
  if (!m) return null;
  return { type: 'tube_line_plan', line: m[1], quote: m[0] };
}

function captureJourney(sentence: string): JourneyUnderestimateClaim | null {
  const minutes = sentence.match(/\b(\d{1,3})\s*(?:-\s*)?(?:min(?:ute)?s?|mins)\b/i);
  if (!minutes) return null;
  const statedMinutes = parseInt(minutes[1], 10);
  if (!(statedMinutes > 0)) return null;
  // a place name: capitalised words (with 's, &, -), or a lowercase run up to a stop word
  // public transit is not a walk / cycle / drive claim: the verifier could only mis-estimate it
  if (/\b(train|tube|bus|rail|coach|tram|flight|fly|plane|ferry|underground|overground|metro)\b/i.test(sentence)) return null;
  // a place name: a capitalised run (`King's Cross`, `Isle of Wight`); a lowercase run only inside `from … to …` / `between … and …`
  const CAP = "([A-Z][\\w'&-]*(?:\\s+(?:[A-Z][\\w'&-]*|of the|of|de|du|la|le|upon|on|&))*)";
  const PLACE = `(?:${CAP.slice(1, -1)}|[a-z][\\w'-]*(?:\\s+[a-z][\\w'-]*){0,2})`;
  const pair = sentence.match(new RegExp(`\\b[Ff]rom\\s+(${PLACE})\\s+to\\s+(${PLACE})`, ''))
    ?? sentence.match(new RegExp(`\\b[Bb]etween\\s+(${PLACE})\\s+and\\s+(${PLACE})`, ''))
    ?? sentence.match(new RegExp(`\\b${CAP}\\s+to\\s+${CAP}`, ''));
  if (!pair) return null;
  const clean = (p: string) => p.replace(/\s+(?:in|by|on|at|is|takes|and|for|so|which|that)$/i, '').trim();
  const origin = clean(pair[1]), destination = clean(pair[2]);
  if (!origin || !destination || origin.toLowerCase() === destination.toLowerCase()) return null;
  const lower = sentence.toLowerCase();
  const mode: JourneyMode = /\b(drive|driving|car|taxi|cab|uber)\b/.test(lower) ? 'drive' : /\b(cycle|cycling|bike|biking|ride)\b/.test(lower) ? 'cycle' : 'walk';
  const lo = Math.min(minutes.index ?? 0, pair.index ?? 0), hi = Math.max((minutes.index ?? 0) + minutes[0].length, (pair.index ?? 0) + pair[0].length);
  return { type: 'journey_underestimate', origin, destination, statedMinutes, mode, quote: sentence.slice(lo, hi) };
}

/** Cut the operands of a named claim type from the sentence; null when the grammar cannot ground every field. */
export function captureClaim(type: string, sentence: string): Claim | null {
  switch (type) {
    case 'weekday_date': return captureWeekdayDate(sentence);
    case 'bill_split': return captureBillSplit(sentence);
    case 'arithmetic': return captureArithmetic(sentence);
    case 'workday_on_holiday': return captureDated('workday_on_holiday', sentence);
    case 'outdoor_plan_weather': return captureDated('outdoor_plan_weather', sentence);
    case 'tube_line_plan': return captureTubeLine(sentence);
    case 'journey_underestimate': return captureJourney(sentence);
    default: return null;
  }
}

/** Which claim types the grammar could even ground in this sentence: the decision is offered only these (+ none). */
export function candidateClaimTypes(sentence: string): ClaimType[] {
  return CLAIM_TYPES.filter((t) => captureClaim(t, sentence) !== null);
}

