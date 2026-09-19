/**
 * Dates & durations — calendar arithmetic on the proleptic Gregorian
 * calendar, computed in UTC on whole days so a DST change never makes a
 * day 23 hours long. The clock comes from the context.
 */
import type { Calculator, CalcContext } from './types';
import { fmt, NUM, num } from './types';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const monthIndex = (s: string): number => MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3)));
const weekdayIndex = (s: string): number => WEEKDAYS.findIndex((w) => w.startsWith(s.slice(0, 3)));
const DAY = 86_400_000;

/** A calendar day as a UTC-midnight Date. */
export const utcDay = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m, d));
const todayUtc = (ctx: CalcContext): Date => {
  const n = ctx.now();
  return utcDay(n.getFullYear(), n.getMonth(), n.getDate());   // the host's local calendar day
};
const validYmd = (y: number, m: number, d: number): boolean => {
  const t = utcDay(y, m, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d;
};

/** Named days that never move. */
const NAMED: Record<string, [number, number]> = { christmas: [11, 25], 'christmas day': [11, 25], 'christmas eve': [11, 24], 'new year': [0, 1], "new year's day": [0, 1], 'new years day': [0, 1], 'new years': [0, 1], "new year's eve": [11, 31], 'new years eve': [11, 31], halloween: [9, 31], 'valentines day': [1, 14], "valentine's day": [1, 14], 'valentines': [1, 14], 'boxing day': [11, 26], 'april fools': [3, 1] };

export interface ParsedDate { date: Date; hadYear: boolean }

/**
 * Parse a date as a person writes it: `2024-03-01`, `14 july 1789`,
 * `july 14 1789`, `3 march`, `march 3rd`, `3/3/2024` (day first), `today`,
 * `tomorrow`, `yesterday`, `friday` (the next one), `next friday`,
 * `christmas`. A month-day with no year is THIS year unless `forward` asks
 * for the next occurrence.
 */
export function parseDate(raw: string, ctx: CalcContext, forward = false): ParsedDate | null {
  const s = raw.toLowerCase().replace(/[,.]+$/, '').replace(/\b(the|of|on)\b/g, ' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\s+/g, ' ').trim();
  const today = todayUtc(ctx);
  const year = today.getUTCFullYear();
  if (s === 'today' || s === 'now') return { date: today, hadYear: true };
  if (s === 'tomorrow') return { date: new Date(today.getTime() + DAY), hadYear: true };
  if (s === 'yesterday') return { date: new Date(today.getTime() - DAY), hadYear: true };
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(?:next |this )?([a-z]+day)$/)) && weekdayIndex(m[1]) >= 0) {
    const want = weekdayIndex(m[1]);
    let delta = (want - today.getUTCDay() + 7) % 7;
    if (delta === 0 || s.startsWith('next ')) delta = delta === 0 ? 7 : delta;
    return { date: new Date(today.getTime() + delta * DAY), hadYear: true };
  }
  const monthDayOf = (mo: number, d: number, y?: number): ParsedDate | null => {
    if (y !== undefined) return validYmd(y, mo, d) ? { date: utcDay(y, mo, d), hadYear: true } : null;
    if (!validYmd(year, mo, d) && !(mo === 1 && d === 29)) return null;
    let date = validYmd(year, mo, d) ? utcDay(year, mo, d) : utcDay(year + 1, mo, d);
    if (forward && date.getTime() < today.getTime()) date = utcDay(year + 1, mo, d);
    return { date, hadYear: false };
  };
  const named = NAMED[s.replace(/^(next|this) /, '')];
  if (named) return monthDayOf(named[0], named[1]);
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return monthDayOf(Number(m[2]) - 1, Number(m[3]), Number(m[1]));
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) return monthDayOf(Number(m[2]) - 1, Number(m[1]), Number(m[3]));   // day first
  if ((m = s.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/)) && monthIndex(m[2]) >= 0) return monthDayOf(monthIndex(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined);
  if ((m = s.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/)) && monthIndex(m[1]) >= 0) return monthDayOf(monthIndex(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
  if ((m = s.match(/^([a-z]+) (\d{4})$/)) && monthIndex(m[1]) >= 0) return monthDayOf(monthIndex(m[1]), 1, Number(m[2]));
  if ((m = s.match(/^(\d{4})$/))) return monthDayOf(0, 1, Number(m[1]));
  return null;
}

/** parseDate over the longest suffix that parses: `day number is today` → today, `born in march 1990` → march 1990 */
export function parseDateLoose(raw: string, ctx: CalcContext, forward = false): ParsedDate | null {
  const words = raw.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) { const p = parseDate(words.slice(i).join(' '), ctx, forward); if (p) return p; }
  return null;
}

export const fmtDate = (d: Date): string => `${WEEKDAYS[d.getUTCDay()][0].toUpperCase()}${WEEKDAYS[d.getUTCDay()].slice(1, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1, 3)} ${d.getUTCFullYear()}`;
const plural = (n: number, w: string): string => `${fmt(n)} ${w}${Math.abs(n) === 1 ? '' : 's'}`;
const daysBetween = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / DAY);

/** `3 hours 20 minutes`, `2h30`, `1h 55m`, `90 min`, `1.5 hours`, `2 days 4 hours` → minutes */
export function parseDuration(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
  let mins = 0, any = false;
  const compact = s.match(/^(\d+)h(?:\s*(\d{1,2})m?)?$/);
  if (compact) return Number(compact[1]) * 60 + Number(compact[2] ?? 0);
  const re = new RegExp(String.raw`(${NUM})\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`, 'g');
  let m: RegExpExecArray | null; let hours = false; let consumed = '';
  while ((m = re.exec(s))) {
    any = true; consumed += m[0] + ' ';
    const v = num(m[1]); const u = m[2][0];
    if (u === 'h') hours = true;
    mins += u === 'w' ? v * 7 * 1440 : u === 'd' ? v * 1440 : u === 'h' ? v * 60 : u === 'm' ? v : v / 60;
  }
  // `1 hour 55`: a trailing bare number after hours is minutes
  const tail = s.replace(re, '').trim().match(/^(\d{1,2})$/);
  if (any && hours && tail) mins += Number(tail[1]);
  return any ? mins : null;
}
export function fmtDuration(mins: number): string {
  const sign = mins < 0 ? '-' : ''; mins = Math.abs(mins);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = Math.round(mins % 60 * 100) / 100;
  const parts: string[] = [];
  if (d) parts.push(plural(d, 'day'));
  if (h) parts.push(`${h} h`);
  if (m || parts.length === 0) parts.push(`${fmt(m)} min`);
  return sign + parts.join(' ');
}

const twoDates = (arg: string, ctx: CalcContext): [Date, Date] | null => {
  const m = arg.toLowerCase().match(/^(?:from )?(.+?)\s+(?:and|to|until|till|-|–)\s+(.+)$/);
  if (!m) return null;
  const a = parseDate(m[1], ctx), b = parseDate(m[2], ctx, true);
  if (!a || !b) return null;
  return [a.date, b.date];
};

/** Anonymous Gregorian algorithm for Easter Sunday. */
export function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31), day = ((h + l - 7 * mm + 114) % 31) + 1;
  return utcDay(y, month - 1, day);
}
export const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export function isoWeek(d: Date): { week: number; year: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((t.getTime() - y0.getTime()) / DAY + 1) / 7), year: t.getUTCFullYear() };
}
const dayOfYear = (d: Date): number => daysBetween(utcDay(d.getUTCFullYear(), 0, 1), d) + 1;

const fmtClock = (d: Date, tz: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);
const fmtLocalDate = (d: Date, tz: string): string => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(d);

export const DATES: readonly Calculator[] = [
  { id: 'days-between', family: 'dates', keywords: ['days between'], arg: 'segment', example: ['days between 3 march 2026 and 19 september 2026', '200 days (28.6 weeks)'], miss: 'cannot read two dates',
    run(arg, ctx) { const p = twoDates(arg, ctx); if (!p) return null; const d = daysBetween(p[0], p[1]); return `${plural(d, 'day')}${Math.abs(d) >= 14 ? ` (${fmt(Math.round(Math.abs(d) / 7 * 10) / 10)} weeks)` : ''}`; } },
  { id: 'weeks-between', family: 'dates', keywords: ['weeks between'], arg: 'segment', example: ['weeks between 1 jan 2026 and 1 mar 2026', '8.4 weeks (59 days)'], miss: 'cannot read two dates',
    run(arg, ctx) { const p = twoDates(arg, ctx); if (!p) return null; const d = daysBetween(p[0], p[1]); return `${fmt(Math.round(d / 7 * 10) / 10)} weeks (${plural(d, 'day')})`; } },
  { id: 'working-days-between', family: 'dates', keywords: ['working days between', 'business days between', 'weekdays between'], arg: 'segment', example: ['working days between 1 sep 2026 and 30 sep 2026', '21 working days (Mon–Fri, no holidays counted)'], miss: 'cannot read two dates',
    run(arg, ctx) { const p = twoDates(arg, ctx); if (!p) return null; let n = 0; const [a, b] = p[0] <= p[1] ? p : [p[1], p[0]]; for (let t = a.getTime(); t < b.getTime(); t += DAY) { const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) n++; } return `${n} working days (Mon–Fri, no holidays counted)`; } },
  { id: 'weekday-of', family: 'dates', keywords: ['weekday of', 'day of the week for', 'day of the week was', 'day of the week is', 'what day was', 'what day is'], arg: 'segment', example: ['weekday of 14 july 1789', 'Tuesday (14 Jul 1789)'], miss: 'cannot read the date',
    run(arg, ctx) { const p = parseDateLoose(arg, ctx); if (!p) return null; const w = WEEKDAYS[p.date.getUTCDay()]; return `${w[0].toUpperCase()}${w.slice(1)} (${fmtDate(p.date).slice(4)})`; } },
  { id: 'date-plus', family: 'dates', keywords: ['from today'], arg: 'segment', keywordIsArg: true, phrase: new RegExp(String.raw`^(?:${NUM})\s*(?:days?|weeks?|months?|years?)\s+(?:from|after|before)\s+\S.*$|^\S.*\s+(?:plus|minus)\s+(?:${NUM})\s*(?:days?|weeks?|months?|years?)$`, 'i'), example: ['90 days from today', 'Fri 18 Dec 2026'], miss: 'cannot read the offset',
    run(arg, ctx) {
      // `90 days from today`, `3 weeks from friday`, `2 months after 1 jan`, `date plus 45 days`, `45 days ago`
      const s = arg.toLowerCase().trim();
      let m = s.match(new RegExp(String.raw`^(${NUM})\s*(days?|weeks?|months?|years?)\s+(?:from|after|before|ago)\s*(.*)$`)) ?? s.match(new RegExp(String.raw`^(${NUM})\s*(days?|weeks?|months?|years?)\s+(ago)$`));
      let base: ParsedDate | null; let n: number; let unit: string; let sign = 1;
      if (m) { n = num(m[1]); unit = m[2][0]; const rest = (m[3] ?? '').trim(); if (/before/.test(s) || rest === 'ago' || /ago$/.test(s)) sign = -1; base = parseDate(rest && rest !== 'ago' ? rest : 'today', ctx); }
      else { m = s.match(new RegExp(String.raw`^(.+?)\s+(?:plus|\+|minus|-)\s+(${NUM})\s*(days?|weeks?|months?|years?)$`)); if (!m) return null; base = parseDate(m[1], ctx); n = num(m[2]); unit = m[3][0]; if (/\s(minus|-)\s/.test(s)) sign = -1; }
      if (!base) return null; n *= sign;
      const d = base.date;
      const out = unit === 'd' ? new Date(d.getTime() + n * DAY) : unit === 'w' ? new Date(d.getTime() + n * 7 * DAY) : unit === 'm' ? utcDay(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()) : utcDay(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate());
      return fmtDate(out);
    } },
  { id: 'until', family: 'dates', keywords: ['days until', 'weeks until', 'how long until', 'until', 'days to', 'countdown to'], arg: 'segment', example: ['weeks until christmas', '13.9 weeks (97 days, Fri 25 Dec 2026)'], miss: 'cannot read the date',
    run(arg, ctx) { const p = parseDateLoose(arg, ctx, true); if (!p) return null; const d = daysBetween(todayUtc(ctx), p.date); return `${fmt(Math.round(d / 7 * 10) / 10)} weeks (${plural(d, 'day')}, ${fmtDate(p.date)})`; } },
  { id: 'since', family: 'dates', keywords: ['days since', 'weeks since', 'how long since', 'since'], arg: 'segment', example: ['days since 1 jan 2026', '261 days (37.3 weeks)'], miss: 'cannot read the date',
    run(arg, ctx) { const p = parseDateLoose(arg, ctx); if (!p) return null; const d = daysBetween(p.date, todayUtc(ctx)); return `${plural(d, 'day')} (${fmt(Math.round(d / 7 * 10) / 10)} weeks)`; } },
  { id: 'time-plus', family: 'dates', keywords: ['from now', 'ago'], arg: 'segment', keywordIsArg: true, phrase: new RegExp(String.raw`^(?:in\s+)?(?:${NUM})\s*(?:minutes?|mins?|hours?|hrs?|h|m|seconds?|secs?|s|days?|weeks?|months?|years?)(?:\s+(?:and\s+)?(?:${NUM})\s*(?:minutes?|mins?|m))?(?:\s+(?:from now|ago))?$`, 'i'), example: ['in 45 minutes', '13:15'], miss: 'cannot read the duration',
    run(arg, ctx) {
      // a day-or-longer offset is a calendar answer, not a clock one
      const dm = arg.toLowerCase().match(new RegExp(String.raw`(${NUM})\s*(days?|weeks?|months?|years?)`));
      if (dm) return DATES.find((c) => c.id === 'date-plus')!.run(`${dm[1]} ${dm[2]} ${/\bago\b/.test(arg) ? 'ago' : 'from today'}`, ctx); const s = arg.toLowerCase().replace(/\bfrom now\b|\bago\b/g, '').trim(); const mins = parseDuration(s); if (mins === null) return null; const sign = /\bago\b/.test(arg) ? -1 : 1; const t = new Date(ctx.now().getTime() + sign * mins * 60_000); const sameDay = fmtLocalDate(t, ctx.timeZone) === fmtLocalDate(ctx.now(), ctx.timeZone); return sameDay ? fmtClock(t, ctx.timeZone) : `${fmtClock(t, ctx.timeZone)} ${fmtLocalDate(t, ctx.timeZone)}`; } },
  { id: 'duration-sum', family: 'dates', keywords: ['duration', 'total time', 'add times', 'time plus'], arg: 'segment', example: ['duration 3 hours 20 minutes plus 1 hour 55', '5 h 15 min'], miss: 'cannot read the durations',
    run(arg) { const parts = arg.toLowerCase().split(/\s+(?:plus|\+|and|,)\s+|\s*\+\s*/); let total = 0; const minus: number[] = []; for (const p of parts) { const seg = p.split(/\s+minus\s+|\s+-\s+/); const first = parseDuration(seg[0]); if (first === null) return null; total += first; for (const q of seg.slice(1)) { const v = parseDuration(q); if (v === null) return null; minus.push(v); } } for (const v of minus) total -= v; return fmtDuration(total); } },
  { id: 'age', family: 'dates', keywords: ['age if born', 'age for', 'how old is someone born', 'age'], arg: 'segment', example: ['age if born 14 march 1990', '36 years (since 14 Mar 1990)'], miss: 'cannot read the birth date',
    run(arg, ctx) { const p = parseDateLoose(arg, ctx); if (!p) return null; const t = todayUtc(ctx); let y = t.getUTCFullYear() - p.date.getUTCFullYear(); if (t.getUTCMonth() < p.date.getUTCMonth() || (t.getUTCMonth() === p.date.getUTCMonth() && t.getUTCDate() < p.date.getUTCDate())) y--; return `${plural(y, 'year')} (since ${fmtDate(p.date).slice(4)})`; } },
  { id: 'week-number', family: 'dates', keywords: ['week number of', 'iso week of', 'week of the year for', 'week number'], arg: 'segment', optionalArg: true, example: ['iso week of 19 september 2026', 'week 38 of 2026'], miss: 'cannot read the date',
    run(arg, ctx) { const p = parseDateLoose(arg || 'today', ctx); if (!p) return null; const w = isoWeek(p.date); return `week ${w.week} of ${w.year}`; } },
  { id: 'day-of-year', family: 'dates', keywords: ['day of the year for', 'day of year', 'day number of'], arg: 'segment', optionalArg: true, example: ['day of year 19 september 2026', 'day 262 of 365'], miss: 'cannot read the date',
    run(arg, ctx) { const p = parseDateLoose(arg || 'today', ctx); if (!p) return null; return `day ${dayOfYear(p.date)} of ${isLeap(p.date.getUTCFullYear()) ? 366 : 365}`; } },
  { id: 'leap-year', family: 'dates', keywords: ['is a leap year', 'leap year'], arg: 'segment', example: ['leap year 2028', '2028 is a leap year'], miss: 'cannot read the year',
    run(arg) { const m = arg.match(/(\d{4})/); if (!m) return null; const y = Number(m[1]); return `${y} is ${isLeap(y) ? '' : 'not '}a leap year`; } },
  { id: 'quarter-of', family: 'dates', keywords: ['quarter of', 'which quarter is', 'quarter'], arg: 'segment', optionalArg: true, example: ['quarter of 19 september 2026', 'Q3 2026'], miss: 'cannot read the date',
    run(arg, ctx) { const p = parseDateLoose(arg || 'today', ctx); if (!p) return null; return `Q${Math.floor(p.date.getUTCMonth() / 3) + 1} ${p.date.getUTCFullYear()}`; } },
  { id: 'easter', family: 'dates', keywords: ['easter', 'easter sunday', 'when is easter'], arg: 'segment', optionalArg: true, example: ['easter 2027', 'Sun 28 Mar 2027'], miss: 'cannot read the year',
    run(arg, ctx) { const m = arg.match(/(\d{4})/); let y = m ? Number(m[1]) : ctx.now().getFullYear(); if (!m && easter(y).getTime() < todayUtc(ctx).getTime()) y++; return fmtDate(easter(y)); } },
  { id: 'nth-weekday', family: 'dates', keywords: ['nth weekday'], arg: 'segment', keywordIsArg: true, phrase: /^(?:the )?(?:first|1st|second|2nd|third|3rd|fourth|4th|last)\s+[a-z]+day\s+(?:of|in)\s+[a-z]+(?:\s+\d{4})?$/i, example: ['last friday of october 2026', 'Fri 30 Oct 2026'], miss: 'cannot read which weekday of which month',
    run(arg, ctx) {
      const m = (arg.toLowerCase().match(/^(?:the )?(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+([a-z]+day)\s+(?:of|in)\s+([a-z]+)(?:\s+(\d{4}))?$/));
      if (!m || weekdayIndex(m[2]) < 0 || monthIndex(m[3]) < 0) return null;
      const want = weekdayIndex(m[2]), mo = monthIndex(m[3]), y = m[4] ? Number(m[4]) : ctx.now().getFullYear();
      if (m[1] === 'last') { let d = utcDay(y, mo + 1, 0); while (d.getUTCDay() !== want) d = new Date(d.getTime() - DAY); return fmtDate(d); }
      const nth = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 }[m[1]]!;
      let d = utcDay(y, mo, 1); while (d.getUTCDay() !== want) d = new Date(d.getTime() + DAY);
      d = new Date(d.getTime() + (nth - 1) * 7 * DAY); return d.getUTCMonth() === mo ? fmtDate(d) : null;
    } },
  { id: 'unix-now', family: 'dates', keywords: ['unix time', 'unix timestamp', 'epoch now', 'epoch time'], arg: 'none', example: ['unix time', '1789999999'], miss: '',
    run(_arg, ctx) { return String(Math.floor(ctx.now().getTime() / 1000)); } },
  { id: 'unix-to-date', family: 'dates', keywords: ['unix', 'epoch', 'timestamp'], arg: 'segment', example: ['unix 1700000000', 'Tue 14 Nov 2023 22:13:20 UTC'], miss: 'not a unix timestamp',
    run(arg) { const m = arg.match(/(?:^|\D)(\d{9,13})(?!\d)/); if (!m) return null; const ms = m[1].length > 10 ? Number(m[1]) : Number(m[1]) * 1000; const d = new Date(ms); return `${fmtDate(d)} ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }).format(d)} UTC`; } },
  { id: 'iso-now', family: 'dates', keywords: ['iso now', 'iso date', 'iso 8601', 'todays date', "today's date", 'date today'], arg: 'none', example: ['iso now', '2026-09-19T12:30:00.000Z'], miss: '',
    run(_arg, ctx) { return ctx.now().toISOString(); } },
  { id: 'seconds-in', family: 'dates', keywords: ['seconds in', 'minutes in', 'hours in'], arg: 'segment', keywordIsArg: true, example: ['seconds in 3 days', '259200 seconds (4320 minutes, 72 hours)'], miss: 'cannot read the duration',
    run(arg, ctx) { void ctx; const mins = parseDuration(arg); if (mins === null) return null; return `${fmt(mins * 60)} seconds (${fmt(mins)} minutes, ${fmt(mins / 60)} hours)`; } },
];
