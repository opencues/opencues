/**
 * Core's DATA_POLICY (what the decision leg may name) and the runtime's
 * calculator registry (what answers) are two lists that must agree: every
 * calculator id is a policy entry with the same keywords, the same
 * canonical keyword (or the `table` phrase sentinel), and the same
 * keep-keyword rule. Then the whole path for plain phrasings: policy
 * capture → lookupTable → the answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DATA_POLICY, resolveDataInvocation } from '@opencues/core';
import { CALCULATORS, PHRASE_KEYWORD } from './registry';
import { lookupTable, configureCalcEnv } from '../tables';

const NOW = new Date('2026-09-19T11:30:00.000Z');

describe('DATA_POLICY ↔ calculator registry', () => {
  it('every calculator is a policy entry with the same keywords and dispatch rule', () => {
    for (const c of CALCULATORS) {
      const e = DATA_POLICY[c.id];
      expect(e, `policy entry for ${c.id}`).toBeDefined();
      expect(e.blank).toBe('tables');
      expect([...(e.keywords ?? [])]).toEqual([...c.keywords]);
      if (e.keyword === PHRASE_KEYWORD) expect(c.phrase, `${c.id} routes by phrase`).toBeDefined();
      else expect(c.keywords[0]).toBe(e.keyword);
      expect(!!e.keepKeyword).toBe(!!(c.keywordIsArg || e.keyword === PHRASE_KEYWORD));
      expect(e.arg === 'none').toBe(c.arg === 'none');
      expect(!!e.optional).toBe(!!c.optionalArg);
    }
  });
});

describe('a plain phrasing → policy capture → the calculator (no model)', () => {
  beforeAll(() => configureCalcEnv({ now: () => NOW }));
  afterAll(() => configureCalcEnv({ now: () => new Date() }));
  const tzSensitive = new Set(['time-plus', 'time-in', 'convert-time', 'utc-offset', 'is-dst', 'overlap', 'meeting-at']);
  it.each([
    ['days-between', 'how many days between 3 march and 19 september _', '200 days (28.6 weeks)'],
    ['weekday-of', 'what day of the week was 14 july 1789 _', 'Tuesday (14 Jul 1789)'],
    ['date-plus', "what's 90 days from today _", 'Fri 18 Dec 2026'],
    ['until', 'how many weeks until christmas _', '13.9 weeks (97 days, Fri 25 Dec 2026)'],
    ['time-plus', 'in 45 minutes _', '13:15'],
    ['time-plus', 'what time is it 3 hours from now _', '15:30'],
    ['duration-sum', '3 hours 20 minutes plus 1 hour 55 _', '5 h 15 min'],
    ['age', 'how old is someone born 14 march 1990 _', '36 years (since 14 Mar 1990)'],
    ['nth-weekday', 'when is the last friday of october 2026 _', 'Fri 30 Oct 2026'],
    ['easter', 'when is easter _', 'Sun 28 Mar 2027'],
    ['time-in', 'what time is it in tokyo _', '20:30 Sat 19 Sept (GMT+9, UTC+09:00)'],
    ['convert-time', '3pm london in tokyo _', '23:00 Sat 19 Sept in tokyo (GMT+9, UTC+09:00)'],
    ['convert-time', '9am est to utc _', '13:00 Sat 19 Sept in utc (UTC, UTC+00:00)'],
    ['in-words', '1234567 in words _', 'one million, two hundred and thirty-four thousand, five hundred and sixty-seven'],
    ['to-roman', '2024 in roman numerals _', 'MMXXIV'],
    ['from-roman', 'MCMXCIV in numbers _', 'MCMXCIV = 1994'],
    ['to-base', "what's 255 in hex _", '0xff (binary 11111111, octal 377)'],
    ['from-base', '0b1011 in decimal _', '11'],
    ['as-decimal', '3/8 as a decimal _', '0.375'],
    ['as-fraction', '0.375 as a fraction _', '3/8'],
    ['in-words', '1e9 in words _', 'one billion'],
    ['stats', 'average of 3, 5, 8 and 13 _', '7.25'],
    ['choose', '5 choose 2 _', '10 combinations (20 permutations)'],
    ['probability', 'what are the odds of 3 heads in 5 flips _', '31.25% (10/32) exactly · 50% at least 3'],
    ['is-prime', 'is 97 prime _', '97 is prime'],
  ])('%s: "%s"', (table, draft, answer) => {
    const inv = resolveDataInvocation({ table, confidence: 0.9, top: '' }, draft);
    expect(inv, `no invocation for "${draft}"`).not.toBeNull();
    const got = lookupTable(inv!.keyword, inv!.value);
    if (tzSensitive.has(table) && process.env.TZ !== 'Europe/London') { expect(got).not.toBeNull(); return; }
    expect(got, `${inv!.keyword} "${inv!.value}"`).toBe(answer);
  });

  it('the calc floor: URLs, code, shell never reach a calculator', () => {
    for (const draft of ['days between http://x and now _', 'in words $(rm -rf /) _', 'round f(2) to 1 decimal _', 'in hex 255 && echo _']) {
      const table = draft.startsWith('days') ? 'days-between' : draft.startsWith('in words') ? 'in-words' : draft.startsWith('round') ? 'round' : 'to-base';
      expect(resolveDataInvocation({ table, confidence: 0.9, top: '' }, draft), draft).toBeNull();
    }
  });
});
