import { describe, it, expect } from 'vitest';
import type { CalcContext } from './types';
import { DATES, parseDate, parseDuration, easter, isoWeek } from './dates';
import { TIMEZONES, zoneFor, parseClock } from './timezones';
import { NUMBERS, toWords, toRoman, fromRoman, toFraction } from './numbers';
import { CALCULATORS, calculatorForKeyword, calculatorById } from './registry';

// Saturday 19 September 2026, 12:30 in London (BST, UTC+1) → 11:30Z
const NOW = new Date('2026-09-19T11:30:00.000Z');
const ctx: CalcContext = { now: () => NOW, timeZone: 'Europe/London', setting: () => undefined, random: () => 0.5 };
const run = (id: string, arg: string) => calculatorById(id)!.run(arg, ctx);

describe('registry', () => {
  it('ids are unique, every keyword resolves to its calculator, longest keyword wins', () => {
    const ids = CALCULATORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CALCULATORS) for (const k of c.keywords) expect(calculatorForKeyword(k)?.id, `keyword "${k}"`).toBe(c.id);
    expect(calculatorForKeyword('zorb')).toBeNull();
  });
  it('every example runs to its answer on the fixed clock', () => {
    for (const c of CALCULATORS) {
      const [input, want] = c.example;
      const kw = c.keywords.find((k) => input.toLowerCase().startsWith(k)) ?? '';
      const rest = input.slice(kw.length).trim();
      const arg = c.keywordIsArg ? input : rest;
      const got = c.run(c.arg === 'none' ? '' : arg, ctx);
      if (c.generator || c.id === 'unix-now' || c.id === 'iso-now') { expect(got, c.id).not.toBeNull(); continue; }
      expect(got, `${c.id}: "${input}"`).toBe(want);
    }
  });
});

describe('dates', () => {
  it('parses the ways people write a date', () => {
    const d = (s: string, fwd = false) => parseDate(s, ctx, fwd)?.date.toISOString().slice(0, 10) ?? null;
    expect(d('2024-03-01')).toBe('2024-03-01');
    expect(d('14 july 1789')).toBe('1789-07-14');
    expect(d('july 14 1789')).toBe('1789-07-14');
    expect(d('3 march')).toBe('2026-03-03');
    expect(d('3 march', true)).toBe('2027-03-03');      // forward: the next one
    expect(d('march 3rd')).toBe('2026-03-03');
    expect(d('3/3/2024')).toBe('2024-03-03');           // day first
    expect(d('today')).toBe('2026-09-19');
    expect(d('tomorrow')).toBe('2026-09-20');
    expect(d('friday')).toBe('2026-09-25');             // today is a Saturday → next Friday
    expect(d('next saturday')).toBe('2026-09-26');
    expect(d('christmas')).toBe('2026-12-25');
    expect(d('31 february')).toBeNull();
    expect(d('zorb')).toBeNull();
  });
  it('durations: words, compact, mixed; the sum keeps the arithmetic exact', () => {
    expect(parseDuration('3 hours 20 minutes')).toBe(200);
    expect(parseDuration('2h30')).toBe(150);
    expect(parseDuration('1h 55m')).toBe(115);
    expect(parseDuration('90 min')).toBe(90);
    expect(parseDuration('1.5 hours')).toBe(90);
    expect(parseDuration('2 days 4 hours')).toBe(2 * 1440 + 240);
    expect(parseDuration('the risk')).toBeNull();
    expect(run('duration-sum', '3 hours 20 minutes plus 1 hour 55')).toBe('5 h 15 min');
    expect(run('duration-sum', '2h minus 45 min')).toBe('1 h 15 min');
  });
  it('the calendar arithmetic', () => {
    expect(run('days-between', '3 march and 19 september')).toBe('200 days (28.6 weeks)');
    expect(run('weekday-of', '14 july 1789')).toBe('Tuesday (14 Jul 1789)');
    expect(run('date-plus', '90 days from today')).toBe('Fri 18 Dec 2026');
    expect(run('date-plus', '3 weeks from friday')).toBe('Fri 16 Oct 2026');
    expect(run('date-plus', '2 months after 31 jan 2026')).toBe('Tue 31 Mar 2026');
    expect(run('date-plus', '45 days ago')).toBe('Wed 5 Aug 2026');
    expect(run('until', 'christmas')).toBe('13.9 weeks (97 days, Fri 25 Dec 2026)');
    expect(run('since', '1 jan 2026')).toBe('261 days (37.3 weeks)');
    expect(run('time-plus', '45 minutes')).toBe('13:15');
    expect(run('time-plus', '12 hours')).toBe('00:30 Sun 20 Sept');
    expect(run('age', '14 march 1990')).toBe('36 years (since 14 Mar 1990)');
    expect(run('week-number', '19 september 2026')).toBe('week 38 of 2026');
    expect(run('day-of-year', '')).toBe('day 262 of 365');
    expect(run('leap-year', '2100')).toBe('2100 is not a leap year');
    expect(run('quarter-of', '')).toBe('Q3 2026');
    expect(easter(2027).toISOString().slice(0, 10)).toBe('2027-03-28');
    expect(run('easter', '')).toBe('Sun 28 Mar 2027');   // this year's has passed → next
    expect(easter(2024).toISOString().slice(0, 10)).toBe('2024-03-31');
    expect(run('nth-weekday', 'last friday of october 2026')).toBe('Fri 30 Oct 2026');
    expect(run('nth-weekday', 'second tuesday of november 2026')).toBe('Tue 10 Nov 2026');
    expect(run('working-days-between', '1 sep 2026 and 30 sep 2026')).toBe('21 working days (Mon–Fri, no holidays counted)');
    expect(run('unix-to-date', '1700000000')).toBe('Tue 14 Nov 2023 22:13:20 UTC');
    expect(run('unix-now', '')).toBe('1789817400');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toEqual({ week: 53, year: 2026 });
    expect(run('seconds-in', '3 days')).toBe('259200 seconds (4320 minutes, 72 hours)');
    expect(run('days-between', 'zorb and blorb')).toBeNull();
  });
});

describe('timezones', () => {
  it('names → zones', () => {
    expect(zoneFor('tokyo')).toBe('Asia/Tokyo');
    expect(zoneFor('New York')).toBe('America/New_York');
    expect(zoneFor('est')).toBe('America/New_York');
    expect(zoneFor('in london')).toBe('Europe/London');
    expect(zoneFor('Europe/Paris')).toBe('Europe/Paris');
    expect(zoneFor('utc+5')).toBe('Etc/GMT-5');
    expect(zoneFor('zorbville')).toBeNull();
  });
  it('clock words', () => {
    expect(parseClock('3pm')).toBe(15 * 60);
    expect(parseClock('15:00')).toBe(15 * 60);
    expect(parseClock('9.30am')).toBe(9 * 60 + 30);
    expect(parseClock('noon')).toBe(720);
    expect(parseClock('12am')).toBe(0);
    expect(parseClock('3')).toBeNull();
  });
  it('ICU does the offsets and DST', () => {
    expect(run('time-in', 'tokyo')).toBe('20:30 Sat 19 Sept (GMT+9, UTC+09:00)');
    expect(run('convert-time', '3pm london in tokyo')).toBe('23:00 Sat 19 Sept in tokyo (GMT+9, UTC+09:00)');
    expect(run('convert-time', '9am est to utc')).toBe('13:00 Sat 19 Sept in utc (UTC, UTC+00:00)');
    expect(run('utc-offset', 'tokyo')).toBe('UTC+09:00 (Asia/Tokyo, GMT+9)');
    expect(run('is-dst', 'london')).toBe('yes — BST, UTC+01:00 (standard is UTC+00:00)');
    expect(run('is-dst', 'tokyo')).toBe('no — Asia/Tokyo does not observe daylight saving (UTC+09:00)');
    expect(run('overlap', 'london and sydney')).toBe('no overlap of 9–5 (sydney is +9 h from london)');
    expect(run('overlap', 'london and new york')).toBe('14:00–17:00 london = 09:00–12:00 new york (3 h of 9–5)');
    expect(run('meeting-at', '3pm london for new york tokyo')).toBe('London 15:00 · New York 10:00 · Tokyo 23:00');
    expect(run('time-in', 'zorbville')).toBeNull();
  });
});

describe('numbers', () => {
  it('words, roman, fractions', () => {
    expect(toWords(1234567)).toBe('one million, two hundred and thirty-four thousand, five hundred and sixty-seven');
    expect(toWords(1e9)).toBe('one billion');
    expect(toWords(-42.5)).toBe('minus forty-two point five');
    expect(toRoman(2024)).toBe('MMXXIV');
    expect(toRoman(4000)).toBeNull();
    expect(fromRoman('MCMXCIV')).toBe(1994);
    expect(fromRoman('IIII')).toBeNull();
    expect(toFraction(0.375)).toEqual([3, 8]);
    expect(toFraction(1 / 3)).toEqual([1, 3]);
  });
  it('the calculators', () => {
    expect(run('to-base', 'hex 255')).toBe('0xff (binary 11111111, octal 377)');
    expect(run('to-base', 'binary 10')).toBe('0b1010 (hex 0xa, octal 12)');
    expect(run('from-base', '0b1011')).toBe('11');
    expect(run('from-base', '0xff')).toBe('255');
    expect(run('as-decimal', '3/8')).toBe('0.375');
    expect(run('as-fraction', '0.375')).toBe('3/8');
    expect(run('as-fraction', '2.5')).toBe('2 1/2 (5/2)');
    expect(run('as-percent', '3/8')).toBe('37.5%');
    expect(run('round', '3.14159 to 2 decimals')).toBe('3.14');
    expect(run('round', '1234 to the nearest hundred')).toBe('1200');
    expect(run('sig-figs', '0.00123456 to 3')).toBe('0.00123');
    expect(run('ordinal', '22')).toBe('22nd');
    expect(run('ordinal', '113')).toBe('113th');
    expect(run('with-commas', '1234567.5')).toBe('1,234,567.5');
    expect(run('in-millions', '2500000')).toBe('2.5 million');
    expect(run('in-millions', 'lakhs 2500000')).toBe('25 lakh');
    expect(run('factorial', '10')).toBe('3,628,800');
    expect(run('is-prime', '97')).toBe('97 is prime');
    expect(run('is-prime', '91')).toBe('91 is not prime (7 × 13)');
    expect(run('prime-factors', '360')).toBe('2 × 2 × 2 × 3 × 3 × 5 (2³ · 3² · 5)');
    expect(run('gcd', '48 and 180')).toBe('12');
    expect(run('lcm', '4 and 6')).toBe('12');
    expect(run('fibonacci', '20')).toBe('6,765');
    expect(run('nth-root', 'cube root of 27')).toBe('3');
    expect(run('nth-root', '4th root of 81')).toBe('3');
    expect(run('log', 'log base 2 of 1024')).toBe('10');
    expect(run('log', 'ln 1')).toBe('0');
    expect(run('stats', 'mean of 3 5 8 13')).toBe('7.25');
    expect(run('stats', 'median of 3 5 8 13')).toBe('6.5');
    expect(run('stats', 'stats of 3 5 8 13')).toBe('mean 7.25 · median 6.5 · sd 4.35 · min 3 · max 13 · n 4');
    expect(run('sum-of', '1 to 100')).toBe('5050');
    expect(run('sum-of', '12 7 3.5')).toBe('22.5');
    expect(run('choose', '5 choose 2')).toBe('10 combinations (20 permutations)');
    expect(run('probability', '3 heads in 5 flips')).toBe('31.25% (10/32) exactly · 50% at least 3');
    expect(run('in-words', 'the risk')).toBeNull();
    expect(run('to-roman', '4000')).toBeNull();
  });
});
