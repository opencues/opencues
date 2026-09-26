/**
 * Calendar availability — the compute half of select-then-compute for the
 * calendar-conflict cue. A decision answers ONE question about a sentence
 * ("does it claim the writer's availability, or propose a day / time?") from
 * the sentence alone; this module resolves the day and time the sentence
 * names against the clock, checks them against the ingested calendar, and
 * writes the heads-up. The calendar never leaves the machine: not the
 * titles, not the times. The LLM path (`defaults/cues/calendar/CUE.md`)
 * asked the model to do this resolution itself with the busy intervals on
 * the wire; here the model only says whether the sentence is a claim.
 */
import type { CalendarContextEvent } from './calendar-context';

export interface AvailabilityRef {
  /** the calendar days the sentence refers to (local Y/M/D) */
  readonly days: ReadonlyArray<{ year: number; monthIdx: number; day: number }>;
  /** minutes-since-midnight window on those days; null = the whole day */
  readonly window: { start: number; end: number } | null;
  /** how the day was named, for the note */
  readonly quote: string;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAY_RE = '(?:sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?';
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const PARTS: Record<string, [number, number]> = { morning: [8 * 60, 12 * 60], afternoon: [12 * 60, 18 * 60], evening: [18 * 60, 22 * 60], night: [18 * 60, 24 * 60], tonight: [18 * 60, 24 * 60], lunch: [12 * 60, 14 * 60], lunchtime: [12 * 60, 14 * 60] };

const wdIndex = (w: string): number | null => { const n = w.toLowerCase(); const i = WEEKDAYS.indexOf(n); return i >= 0 ? i : (n in WEEKDAY_ABBR ? WEEKDAY_ABBR[n] : null); };
const moIndex = (w: string): number | null => { const n = w.toLowerCase(); const i = MONTHS.indexOf(n); return i >= 0 ? i : (n in MONTH_ABBR ? MONTH_ABBR[n] : null); };
type YMD = { year: number; monthIdx: number; day: number };
const ymd = (d: Date): YMD => ({ year: d.getFullYear(), monthIdx: d.getMonth(), day: d.getDate() });
const plusDays = (d: YMD, n: number): YMD => ymd(new Date(d.year, d.monthIdx, d.day + n));
const weekdayOf = (d: YMD): number => new Date(d.year, d.monthIdx, d.day).getDay();

/** A clock time in the sentence → minutes since midnight. Bare 1–7 read as afternoon, 8–11 as morning. */
function parseClock(h: string, m: string | undefined, ampm: string | undefined): number | null {
  let hour = parseInt(h, 10);
  const min = m ? parseInt(m, 10) : 0;
  if (!(hour >= 0 && hour <= 24) || !(min >= 0 && min < 60)) return null;
  const ap = ampm?.toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && hour < 12) hour += 12;
  else if (ap === 'am' && hour === 12) hour = 0;
  else if (!ap && hour >= 1 && hour <= 7) hour += 12;
  return hour * 60 + min;
}

const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?';

/**
 * Resolve the day(s) and time window a sentence names. Null when it names
 * no day and no time (nothing to check). A time with no day reads as today.
 */
export function captureAvailabilityRef(sentence: string, now: Date): AvailabilityRef | null {
  const s = sentence;
  const today = ymd(now);
  let days: YMD[] | null = null;
  let quote = '';
  let m: RegExpMatchArray | null;
  if ((m = s.match(/\b(today|tonight|this (?:morning|afternoon|evening))\b/i))) { days = [today]; quote = m[0]; }
  else if ((m = s.match(/\btomorrow\b/i))) { days = [plusDays(today, 1)]; quote = m[0]; }
  else if ((m = s.match(/\b(?:this|next)\s+weekend\b/i))) {
    // this weekend = the coming Saturday (today, on a Saturday); next weekend = the one after
    const sat = plusDays(today, ((6 - weekdayOf(today)) + 7) % 7 + (/next/i.test(m[0]) ? 7 : 0));
    days = [sat, plusDays(sat, 1)]; quote = m[0];
  }
  else if ((m = s.match(new RegExp(`\\b(?:(this|next)\\s+)?(${WEEKDAY_RE})\\b(?:\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s+(?:of\\s+)?(${MONTH_RE})\\b)?)?`, 'i')))) {
    const wd = wdIndex(m[2]);
    if (wd === null) return null;
    if (m[3]) {
      const d = resolveDay(parseInt(m[3], 10), m[4] ? moIndex(m[4]) : null, today);
      if (!d) return null;
      days = [d];
    } else {
      // a bare or `this` weekday = its coming occurrence (today, on that weekday); `next` = the one in the week after
      let delta = (wd - weekdayOf(today) + 7) % 7;
      if (m[1]?.toLowerCase() === 'next') delta = delta === 0 ? 7 : delta + 7;
      days = [plusDays(today, delta)];
    }
    quote = m[0];
  }
  else if ((m = s.match(new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b`, 'i'))) || (m = s.match(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')))) {
    const dayFirst = /^\d/.test(m[1]) || /^the/i.test(m[0]);
    const d = resolveDay(parseInt(dayFirst ? m[1] : m[2], 10), moIndex(dayFirst ? m[2] : m[1]), today);
    if (!d) return null;
    days = [d]; quote = m[0];
  }
  else if ((m = s.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/i))) {
    const d = resolveDay(parseInt(m[1], 10), null, today);
    if (!d) return null;
    days = [d]; quote = m[0];
  }

  // the time window: a range, a point, or a part of the day
  let window: { start: number; end: number } | null = null;
  let t: RegExpMatchArray | null;
  if ((t = s.match(new RegExp(`\\b(?:between|from)\\s+${TIME}\\s+(?:and|to|till|until|through|-|–)\\s*${TIME}`, 'i')) ?? s.match(new RegExp(`\\b${TIME}\\s*(?:-|–|to|till|until)\\s*${TIME}`, 'i')))) {
    const a = parseClock(t[1], t[2], t[3] ?? t[6]), b = parseClock(t[4], t[5], t[6]);
    if (a !== null && b !== null && b > a) window = { start: a, end: b };
  } else if ((t = s.match(new RegExp(`\\b(?:at|around|about|by|from|after|say)\\s+${TIME}\\b`, 'i'))
      ?? s.match(new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))\\s*(a\\.?m\\.?|p\\.?m\\.?)?\\b`, 'i'))
      ?? s.match(new RegExp(`\\b(\\d{1,2})()\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b`, 'i'))
      // a bare hour right before the day word: `3 today is good`, `say 9 tomorrow`
      ?? s.match(new RegExp(`\\b(\\d{1,2})()()(?=\\s+(?:today|tomorrow|tonight|this\\s+(?:morning|afternoon|evening)|${WEEKDAY_RE})\\b)`, 'i')))) {
    const p = parseClock(t[1], t[2] || undefined, t[3]);
    if (p !== null) window = { start: p, end: p + 1 };
  } else if ((t = s.match(/\b(noon|midday)\b/i))) {
    window = { start: 12 * 60, end: 12 * 60 + 1 };
  } else if ((t = s.match(/\b(morning|afternoon|evening|night|tonight|lunchtime|lunch)\b/i))) {
    const [a, b] = PARTS[t[1].toLowerCase()];
    window = { start: a, end: b };
  }
  if (!days && !window) return null;
  if (!days) { days = [today]; quote = 'today'; }
  return { days, window, quote };
}

function resolveDay(day: number, monthIdx: number | null, today: YMD): YMD | null {
  if (!(day >= 1 && day <= 31)) return null;
  let year = today.year, month = monthIdx ?? today.monthIdx;
  if (monthIdx !== null) { if (month < today.monthIdx || (month === today.monthIdx && day < today.day)) year += 1; }
  else if (day < today.day) { month += 1; if (month > 11) { month = 0; year += 1; } }
  const d = new Date(year, month, day);
  return d.getMonth() === month ? { year, monthIdx: month, day } : null;
}

const isoOf = (d: YMD): string => `${d.year}-${String(d.monthIdx + 1).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
const minOf = (iso: string): number => { const m = iso.match(/T(\d{2}):(\d{2})/); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0; };

/** The events that clash with the reference: on one of its days, and overlapping its window (any event when the window is the whole day). */
export function findClashes(ref: AvailabilityRef, events: ReadonlyArray<CalendarContextEvent>): CalendarContextEvent[] {
  const out: CalendarContextEvent[] = [];
  for (const e of events) {
    const day = e.start.slice(0, 10);
    if (!ref.days.some((d) => isoOf(d) === day)) continue;
    if (!ref.window || e.allDay) { out.push(e); continue; }
    const a = minOf(e.start), b = e.end.slice(0, 10) === day ? minOf(e.end) : 24 * 60;
    if (a < ref.window.end && ref.window.start < b) out.push(e);
  }
  return out;
}

const clock12 = (min: number): string => { const h = Math.floor(min / 60) % 24, m = min % 60; const ap = h < 12 ? 'am' : 'pm'; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${ap}`; };
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `heads up: Dentist today, 3:00–3:45pm; Conference Wed Jul 22, all day` — the same shape the LLM cue wrote, with real titles (nothing to hydrate). */
export function renderHeadsUp(clashes: ReadonlyArray<CalendarContextEvent>, now: Date): string {
  const today = isoOf(ymd(now)), tomorrow = isoOf(plusDays(ymd(now), 1));
  const parts = clashes.map((e) => {
    const day = e.start.slice(0, 10);
    const d = new Date(`${day}T00:00`);
    const when = day === today ? 'today' : day === tomorrow ? 'tomorrow' : `${SHORT_DAYS[d.getDay()]} ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
    const time = e.allDay ? 'all day' : `${clock12(minOf(e.start)).replace(/[ap]m$/, '')}–${clock12(minOf(e.end))}`;
    return `${e.title} ${when}, ${time}`;
  });
  return `heads up: ${parts.join('; ')}`;
}
