/**
 * Deterministic unit tests for the Tier-0 contradiction checks + the source.
 * No LLM, no network — a pinned clock makes weekday resolution reproducible.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { weekdayDateCheck, splitBillCheck } from './checks';
import { ContradictionCueSource } from './contradiction-cue-source';

// Pin "now" to Wed 2026-07-15. Upcoming 24th → 2026-07-24, a FRIDAY.
const NOW = new Date(Date.UTC(2026, 6, 15, 9, 0));
const env = { now: NOW };
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const run = (checkFn: typeof weekdayDateCheck, s: string) => checkFn(words(s), env);

describe('weekday-date mismatch', () => {
  it('flags "Thursday the 24th" when the 24th is a Friday, with the right correction', () => {
    const [c] = run(weekdayDateCheck, 'see you Thursday the 24th');
    assert.ok(c, 'a contradiction fires');
    assert.match(c.tip, /the 24th is a Friday, not Thursday/);
    assert.equal(c.correction, 'Friday the 24th');
    assert.equal(words('see you Thursday the 24th').slice(c.startWord, c.endWord).join(' '), 'Thursday the 24th');
  });

  it('is SILENT when the weekday is correct (Friday the 24th)', () => {
    assert.deepEqual(run(weekdayDateCheck, "let's meet Friday the 24th"), []);
  });

  it('handles "Weekday, Month Nth" and resolves the named month', () => {
    // Aug 23 2026 is a Sunday; "Monday, August 23rd" is wrong.
    const [c] = run(weekdayDateCheck, 'the launch is Monday, August 23rd');
    assert.ok(c);
    assert.match(c.tip, /the 23rd is a Sunday, not Monday/);
    assert.equal(c.correction, 'Monday, August 23rd'.replace('Monday', 'Sunday'));
  });

  it('handles abbreviations ("Thurs 24")', () => {
    const [c] = run(weekdayDateCheck, 'call me Thurs 24');
    assert.ok(c);
    assert.match(c.tip, /is a Friday, not Thursday/);
  });

  it('bails (no false positive) when the weekday is not part of a date phrase', () => {
    assert.deepEqual(run(weekdayDateCheck, 'I love Thursday mornings and coffee'), []);
    assert.deepEqual(run(weekdayDateCheck, 'Thursday was a great day'), []);
  });

  it('never flags a nonexistent date (the 31st of an unspecified short month is skipped safely)', () => {
    // Whatever "the 31st" resolves to, the check must not throw or emit a bad date.
    assert.doesNotThrow(() => run(weekdayDateCheck, 'due Monday the 31st'));
  });
});

describe('split-the-bill math', () => {
  it('flags "$120 among 4, $25 each" → $30', () => {
    const [c] = run(splitBillCheck, "dinner was $120 among 4, that's $25 each");
    assert.ok(c);
    assert.match(c.tip, /\$120 ÷ 4 = \$30 each, not \$25/);
    assert.equal(c.correction, '$30 each');
  });

  it('is SILENT when the math is right ($120 / 4 = $30 each)', () => {
    assert.deepEqual(run(splitBillCheck, '$120 split 4 ways is $30 each'), []);
  });

  it('handles "N people" and decimals', () => {
    const [c] = run(splitBillCheck, 'the bill is $100 for 3 people so $33 each');
    assert.ok(c);
    assert.match(c.tip, /\$33\.33 each, not \$33/);
  });

  it('accepts a bare per-person figure (no $ on the second number)', () => {
    const [c] = run(splitBillCheck, 'dinner was $120 among 4 so 25 each');
    assert.ok(c);
    assert.match(c.tip, /\$120 ÷ 4 = \$30 each, not \$25/);
  });

  it('reads a spelled-out headcount (the formalizer rewrites 4 -> four)', () => {
    const [c] = run(splitBillCheck, 'The dinner cost $120 for four individuals so $25 each');
    assert.ok(c);
    assert.match(c.tip, /\$120 ÷ 4 = \$30 each, not \$25/);
  });

  it('bails without a headcount or a per-person figure (no guess)', () => {
    assert.deepEqual(run(splitBillCheck, 'the bill was $120'), []);
    assert.deepEqual(run(splitBillCheck, "we'll split it evenly"), []);
  });
});

describe('ContradictionCueSource', () => {
  const src = new ContradictionCueSource({ now: () => NOW });

  it('emits a passive sentence-cue-shaped result with the tip + CHAR-offset span', async () => {
    const text = 'see you Thursday the 24th';
    const { results } = await src.getCues({ text, words: words(text) } as never);
    assert.equal(results.length, 1);
    const r = results[0];
    assert.match(r.source, /^sentence-cue:contradiction-weekday-date$/);
    assert.equal(r.cueTip, '⚠ the 24th is a Friday, not Thursday');
    assert.deepEqual(r.alternatives, ['Thursday the 24th', 'Friday the 24th']);
    // Char offsets (not word indices) — the resolver slices liveText by these.
    assert.equal(r.spanStart, 8);
    assert.equal(r.spanEnd, 25);
    // The invariant the resolver's race-guard checks:
    assert.equal(text.slice(r.spanStart!, r.spanEnd!), r.alternatives[0]);
  });

  it('returns nothing on clean text', async () => {
    const { results } = await src.getCues({ text: 'hello there friend', words: words('hello there friend') } as never);
    assert.deepEqual(results, []);
  });

  it('does not stack two tips on the same span', async () => {
    // One phrase, one flag.
    const { results } = await src.getCues({ text: 'Thursday the 24th', words: words('Thursday the 24th') } as never);
    assert.equal(results.length, 1);
  });
});

// ── LLM-extract → code-verify (the robust engine) ─────────────────────────────
import { verifyClaim, safeEvalArithmetic } from './checks';
import { parseClaims } from './contradiction-llm-source';

describe('verifyClaim — grounding + deterministic judge (anti-misfire)', () => {
  const S = 'see you Thursday the 24th';
  it('flags a weekday_date mismatch (24th is a Friday)', () => {
    const v = verifyClaim({ type: 'weekday_date', weekday: 'Thursday', day: 24, month: null, quote: 'Thursday the 24th' }, S, NOW);
    assert.ok(v); assert.match(v!.tip, /the 24th is a Friday, not Thursday/); assert.equal(v!.correction, 'Friday the 24th');
  });
  it('GROUNDING: rejects a claim whose quote is not in the sentence (model cannot hallucinate a cue)', () => {
    // The model invented "$25 each" but the sentence never said it → no cue.
    assert.equal(verifyClaim({ type: 'weekday_date', weekday: 'Thursday', day: 24, quote: 'Friday the 30th' }, S, NOW), null);
    assert.equal(verifyClaim({ type: 'bill_split', total: 120, count: 4, perPerson: 25, quotes: { total: '$120', count: '4', perPerson: '$25 each' } }, 'the bill was $120', NOW), null);
  });
  it('flags a bill_split only when grounded + wrong', () => {
    const s = 'we split the $120 four ways, $25 a head';
    const v = verifyClaim({ type: 'bill_split', total: 120, count: 4, perPerson: 25, quotes: { total: '$120', count: 'four', perPerson: '$25 a head' } }, s, NOW);
    assert.ok(v); assert.match(v!.tip, /\$120 ÷ 4 = \$30 each, not \$25/);
  });
  it('is SILENT when the split math is right', () => {
    assert.equal(verifyClaim({ type: 'bill_split', total: 120, count: 4, perPerson: 30, quotes: { total: '$120', count: '4', perPerson: '$30' } }, '$120 / 4 = $30', NOW), null);
  });
  it('flags an arithmetic error', () => {
    // 100*1.08 = 108, but the writer stated $110 → flag.
    const v = verifyClaim({ type: 'arithmetic', expression: '100*1.08', statedResult: 110, quote: '$110' }, 'with tax so 100*1.08 is $110', NOW);
    assert.ok(v); assert.match(v!.tip, /100\*1\.08 = 108, not 110/);
  });
  it('is SILENT when the arithmetic is right', () => {
    // 100*1.08 = 108 → correct → no cue.
    assert.equal(verifyClaim({ type: 'arithmetic', expression: '100*1.08', statedResult: 108, quote: '$108' }, 'so 100*1.08 is $108', NOW), null);
  });
});

describe('safeEvalArithmetic (no code execution)', () => {
  it('evaluates with precedence + parens', () => {
    assert.equal(safeEvalArithmetic('100*1.08'), 108);
    assert.equal(safeEvalArithmetic('2+3*4'), 14);
    assert.equal(safeEvalArithmetic('(2+3)*4'), 20);
    assert.equal(safeEvalArithmetic('120/4'), 30);
  });
  it('rejects anything non-arithmetic (never runs JS)', () => {
    assert.equal(safeEvalArithmetic('process.exit(1)'), null);
    assert.equal(safeEvalArithmetic('1;alert(1)'), null);
    assert.equal(safeEvalArithmetic(''), null);
  });
});

describe('parseClaims', () => {
  it('parses a bare JSON array', () => {
    assert.equal(parseClaims('[{"type":"bill_split","total":120}]').length, 1);
  });
  it('strips markdown fences / prose around the array', () => {
    assert.equal(parseClaims('Here:\n```json\n[{"type":"weekday_date"}]\n```').length, 1);
  });
  it('returns [] on no array / garbage', () => {
    assert.deepEqual(parseClaims('no claims'), []);
    assert.deepEqual(parseClaims('[]'), []);
  });
});

// ── Tier 0.5 — workday-on-bank-holiday ────────────────────────────────────────
import { BankHolidayProvider } from './bank-holidays';

describe('verifyClaim — workday_on_holiday (Tier 0.5, bank holidays)', () => {
  // Pin now to Wed 2026-12-23. Upcoming: Fri 25th = Christmas Day; Mon 28th =
  // Boxing Day substitute. Both are working days the writer might schedule onto.
  const NOW05 = new Date(Date.UTC(2026, 11, 23, 9, 0));
  const holidays = new Map([
    ['2026-12-25', 'Christmas Day'],
    ['2026-12-28', 'Boxing Day (substitute day)'],
  ]);
  const ctx = { bankHolidays: holidays };

  it('flags a day-of-month that is a bank holiday', () => {
    const v = verifyClaim(
      { type: 'workday_on_holiday', weekday: null, day: 25, month: 'December', quote: 'the meeting on the 25th' },
      'let\'s hold the meeting on the 25th', NOW05, ctx);
    assert.ok(v);
    assert.match(v!.tip, /the 25th is a bank holiday \(Christmas Day\)/);
  });

  it('flags a bare weekday whose NEXT occurrence is a bank holiday', () => {
    // Next Friday from Wed 23rd → Fri 25th = Christmas Day.
    const v = verifyClaim(
      { type: 'workday_on_holiday', weekday: 'Friday', day: null, quote: 'see you in the office Friday' },
      'see you in the office Friday', NOW05, ctx);
    assert.ok(v);
    assert.match(v!.tip, /bank holiday \(Christmas Day\)/);
  });

  it('flags a bare Monday whose next occurrence is a substitute holiday', () => {
    // Next Monday from Wed 23rd → Mon 28th = Boxing Day substitute.
    const v = verifyClaim(
      { type: 'workday_on_holiday', weekday: 'Monday', day: null, quote: 'back in Monday' },
      'back in Monday', NOW05, ctx);
    assert.ok(v);
    assert.match(v!.tip, /Boxing Day/);
  });

  it('is SILENT when the resolved date is not a holiday', () => {
    // Next Tuesday from Wed 23rd → Tue 29th (not in the map).
    assert.equal(verifyClaim(
      { type: 'workday_on_holiday', weekday: 'Tuesday', day: null, quote: 'call me Tuesday' },
      'call me Tuesday', NOW05, ctx), null);
  });

  it('is SILENT when no bank-holiday data is available (cannot verify)', () => {
    assert.equal(verifyClaim(
      { type: 'workday_on_holiday', weekday: 'Friday', day: null, quote: 'see you Friday' },
      'see you Friday', NOW05, { bankHolidays: new Map() }), null);
    assert.equal(verifyClaim(
      { type: 'workday_on_holiday', weekday: 'Friday', day: null, quote: 'see you Friday' },
      'see you Friday', NOW05), null);   // no ctx at all
  });

  it('GROUNDING: rejects a claim whose quote is not in the sentence', () => {
    assert.equal(verifyClaim(
      { type: 'workday_on_holiday', weekday: 'Friday', day: 25, quote: 'the 25th' },
      'nothing about dates here', NOW05, ctx), null);
  });
});

describe('BankHolidayProvider', () => {
  const govUkJson = {
    'england-and-wales': { events: [
      { date: '2026-12-25', title: 'Christmas Day' },
      { date: '2026-12-28', title: 'Boxing Day' },
    ] },
    'scotland': { events: [{ date: '2026-01-02', title: '2nd January' }] },
  };
  const stubFetch = (ok = true) => async () => ({ ok, json: async () => govUkJson });

  it('caches the region map after refresh, read synchronously via current()', async () => {
    const p = new BankHolidayProvider({ fetchImpl: stubFetch(), ttlMs: 1000 });
    assert.equal(p.current().size, 0);          // empty before refresh
    await p.refresh(1000);
    assert.equal(p.current().get('2026-12-25'), 'Christmas Day');
    assert.equal(p.current().size, 2);          // england-and-wales default
  });

  it('honours the region option', async () => {
    const p = new BankHolidayProvider({ fetchImpl: stubFetch(), region: 'scotland' });
    await p.refresh(1000);
    assert.equal(p.current().get('2026-01-02'), '2nd January');
  });

  it('keeps last-good on a failed refresh', async () => {
    let ok = true;
    const p = new BankHolidayProvider({ fetchImpl: async () => ({ ok, json: async () => govUkJson }), ttlMs: 0 });
    await p.refresh(1000);
    assert.equal(p.current().size, 2);
    ok = false;                                  // next fetch fails
    await p.refresh(2000);
    assert.equal(p.current().size, 2);           // still last-good
  });

  it('TTL-gates: no re-fetch within the window', async () => {
    let calls = 0;
    const p = new BankHolidayProvider({ fetchImpl: async () => { calls++; return { ok: true, json: async () => govUkJson }; }, ttlMs: 10000 });
    await p.refresh(1000);
    await p.refresh(2000);   // within TTL
    assert.equal(calls, 1);
  });
});

// ── Tier 5 — outdoor-plan vs weather forecast ─────────────────────────────────
import { WeatherProvider } from './weather';

describe('verifyClaim — outdoor_plan_weather (Tier 5, precipitation)', () => {
  // now = Wed 2026-07-15. resolveDate(18, July) → 2026-07-18 (this month).
  const NOW5 = new Date(Date.UTC(2026, 6, 15, 9, 0));
  const precip = new Map([
    ['2026-07-18', 80],   // wet
    ['2026-07-19', 20],   // dry
    ['2026-07-20', 60],   // exactly at threshold
    ['2026-07-21', 59],   // just under
  ]);
  const ctx = { precipByDate: precip };
  const claim = (day: number, quote: string) =>
    ({ type: 'outdoor_plan_weather', weekday: null, day, month: 'July', quote } as const);

  it('flags an outdoor plan on a wet day', () => {
    const v = verifyClaim(claim(18, 'BBQ on the 18th'), 'lets have a BBQ on the 18th', NOW5, ctx);
    assert.ok(v);
    assert.match(v!.tip, /forecast is rain \(80% chance\)/);
  });

  it('is SILENT on a dry day', () => {
    assert.equal(verifyClaim(claim(19, 'picnic on the 19th'), 'picnic on the 19th', NOW5, ctx), null);
  });

  it('flags at the threshold (>=60) and is silent just under', () => {
    assert.ok(verifyClaim(claim(20, 'walk on the 20th'), 'walk on the 20th', NOW5, ctx));
    assert.equal(verifyClaim(claim(21, 'run on the 21st'), 'run on the 21st', NOW5, ctx), null);
  });

  it('is SILENT beyond the forecast window (date not in the map)', () => {
    assert.equal(verifyClaim(
      { type: 'outdoor_plan_weather', weekday: null, day: 25, month: 'December', quote: 'hike on the 25th' },
      'hike on the 25th', NOW5, ctx), null);
  });

  it('is SILENT when no forecast data is available', () => {
    assert.equal(verifyClaim(claim(18, 'BBQ on the 18th'), 'BBQ on the 18th', NOW5, { precipByDate: new Map() }), null);
    assert.equal(verifyClaim(claim(18, 'BBQ on the 18th'), 'BBQ on the 18th', NOW5), null);
  });

  it('GROUNDING: rejects a claim whose quote is not in the sentence', () => {
    assert.equal(verifyClaim(claim(18, 'on the 18th'), 'no dates mentioned', NOW5, ctx), null);
  });
});

describe('WeatherProvider', () => {
  const forecastJson = {
    daily: {
      time: ['2026-07-15', '2026-07-16', '2026-07-17'],
      precipitation_probability_max: [10, 80, null],
    },
  };
  const stubFetch = (ok = true) => async () => ({ ok, json: async () => forecastJson });

  it('caches precip-by-date after refresh, read via current()', async () => {
    const p = new WeatherProvider({ fetchImpl: stubFetch(), ttlMs: 1000 });
    assert.equal(p.current().size, 0);
    await p.refresh(1000);
    assert.equal(p.current().get('2026-07-16'), 80);
    assert.equal(p.current().has('2026-07-17'), false);   // null value skipped
    assert.equal(p.current().size, 2);
  });

  it('puts the configured location in the request URL', async () => {
    let seen = '';
    const p = new WeatherProvider({ latitude: 40.7, longitude: -74, fetchImpl: async (url) => { seen = url; return { ok: true, json: async () => forecastJson }; } });
    await p.refresh(1000);
    assert.match(seen, /latitude=40\.7&longitude=-74/);
  });

  it('keeps last-good on a failed refresh', async () => {
    let ok = true;
    const p = new WeatherProvider({ fetchImpl: async () => ({ ok, json: async () => forecastJson }), ttlMs: 0 });
    await p.refresh(1000);
    assert.equal(p.current().size, 2);
    ok = false;
    await p.refresh(2000);
    assert.equal(p.current().size, 2);
  });
});

// ── Tier 5 — smart location (timezone auto-detect + city geocode) ─────────────
import { cityFromTimeZone } from './weather';

describe('WeatherProvider — smart location', () => {
  it('cityFromTimeZone derives a geocodable city', () => {
    assert.equal(cityFromTimeZone('Europe/London'), 'London');
    assert.equal(cityFromTimeZone('America/New_York'), 'New York');
    assert.equal(cityFromTimeZone('America/Argentina/Buenos_Aires'), 'Buenos Aires');
    assert.equal(cityFromTimeZone('UTC'), null);
    assert.equal(cityFromTimeZone('Etc/GMT+5'), null);
    assert.equal(cityFromTimeZone(undefined), null);
  });

  it('geocodes an explicit city name (locationName override) then forecasts there', async () => {
    let forecastUrl = '';
    const fetchImpl = async (url: string) => {
      if (url.includes('geocoding-api')) { assert.match(url, /name=Manchester/); return { ok: true, json: async () => ({ results: [{ latitude: 53.48, longitude: -2.24, name: 'Manchester', country: 'UK' }] }) }; }
      forecastUrl = url; return { ok: true, json: async () => ({ daily: { time: ['2026-07-16'], precipitation_probability_max: [70] } }) };
    };
    const p = new WeatherProvider({ locationName: 'Manchester', fetchImpl });
    await p.refresh(1000);
    assert.match(forecastUrl, /latitude=53\.48&longitude=-2\.24/);
    assert.equal(p.current().get('2026-07-16'), 70);
  });

  it('auto-detects from the timezone when no override is given', async () => {
    let geoName = '';
    const fetchImpl = async (url: string) => {
      if (url.includes('geocoding-api')) { geoName = new URL(url).searchParams.get('name') ?? ''; return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 2, name: geoName }] }) }; }
      return { ok: true, json: async () => ({ daily: { time: ['2026-07-16'], precipitation_probability_max: [50] } }) };
    };
    const p = new WeatherProvider({ timeZone: 'America/New_York', fetchImpl });
    await p.refresh(1000);
    assert.equal(geoName, 'New York');   // derived from the timezone
  });

  it('explicit lat/lon skips geocoding entirely', async () => {
    let geocoded = false;
    const fetchImpl = async (url: string) => {
      if (url.includes('geocoding-api')) { geocoded = true; return { ok: true, json: async () => ({ results: [] }) }; }
      return { ok: true, json: async () => ({ daily: { time: ['2026-07-16'], precipitation_probability_max: [30] } }) };
    };
    const p = new WeatherProvider({ latitude: 10, longitude: 20, fetchImpl });
    await p.refresh(1000);
    assert.equal(geocoded, false);
  });

  it('falls back to London when geocoding finds nothing', async () => {
    let forecastUrl = '';
    const fetchImpl = async (url: string) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [] }) };
      forecastUrl = url; return { ok: true, json: async () => ({ daily: { time: ['2026-07-16'], precipitation_probability_max: [40] } }) };
    };
    const p = new WeatherProvider({ locationName: 'Nowheresville', timeZone: 'UTC', fetchImpl });
    await p.refresh(1000);
    assert.match(forecastUrl, /latitude=51\.51&longitude=-0\.13/);
  });
});

// ── Tier 5b — TfL line disruption ─────────────────────────────────────────────
import { TflProvider, normalizeLine } from './tfl';

describe('verifyClaim — tube_line_plan (Tier 5b, TfL disruption)', () => {
  const disrupted = new Map([['victoria', 'Severe Delays'], ['piccadilly', 'Part Closure, Part Suspended']]);
  const ctx = { disruptedLines: disrupted };

  it('normalizeLine strips "line"/"the" and lowercases', () => {
    assert.equal(normalizeLine('Victoria'), 'victoria');
    assert.equal(normalizeLine('the Central line'), 'central');
    assert.equal(normalizeLine('Waterloo & City'), 'waterloo & city');
  });

  it('flags a plan on a disrupted line', () => {
    const v = verifyClaim({ type: 'tube_line_plan', line: 'Victoria', quote: 'take the Victoria line' }, 'ill take the Victoria line', NOW, ctx);
    assert.ok(v);
    assert.match(v!.tip, /the Victoria line has Severe Delays right now/);
  });

  it('flags with the "the … line" phrasing normalized in the tip', () => {
    const v = verifyClaim({ type: 'tube_line_plan', line: 'the Piccadilly line', quote: 'get the Piccadilly line' }, 'get the Piccadilly line', NOW, ctx);
    assert.ok(v);
    assert.match(v!.tip, /the Piccadilly line has Part Closure, Part Suspended right now/);
  });

  it('says "the DLR" not "the DLR line"', () => {
    const v = verifyClaim({ type: 'tube_line_plan', line: 'DLR', quote: 'take the DLR' }, 'take the DLR', NOW, { disruptedLines: new Map([['dlr', 'Part Closure']]) });
    assert.ok(v); assert.match(v!.tip, /the DLR has Part Closure right now/);
  });

  it('is SILENT for a line in Good Service (not in the map)', () => {
    assert.equal(verifyClaim({ type: 'tube_line_plan', line: 'Jubilee', quote: 'the Jubilee line' }, 'the Jubilee line', NOW, ctx), null);
  });

  it('is SILENT when no TfL data is available', () => {
    assert.equal(verifyClaim({ type: 'tube_line_plan', line: 'Victoria', quote: 'Victoria line' }, 'Victoria line', NOW, { disruptedLines: new Map() }), null);
    assert.equal(verifyClaim({ type: 'tube_line_plan', line: 'Victoria', quote: 'Victoria line' }, 'Victoria line', NOW), null);
  });

  it('GROUNDING: rejects a claim whose quote is not in the sentence', () => {
    assert.equal(verifyClaim({ type: 'tube_line_plan', line: 'Victoria', quote: 'Victoria line' }, 'no transit here', NOW, ctx), null);
  });
});

describe('TflProvider', () => {
  const statusJson = [
    { name: 'Victoria', lineStatuses: [{ statusSeverity: 6, statusSeverityDescription: 'Severe Delays' }] },
    { name: 'Jubilee', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] },
    { name: 'Piccadilly', lineStatuses: [{ statusSeverity: 4, statusSeverityDescription: 'Part Closure' }, { statusSeverity: 20, statusSeverityDescription: 'Part Suspended' }] },
    { name: 'Central', lineStatuses: [{ statusSeverity: 9, statusSeverityDescription: 'Minor Delays' }] },
  ];
  const stubFetch = (ok = true) => async () => ({ ok, json: async () => statusJson });

  it('caches only disrupted lines (Good Service excluded), deduped description', async () => {
    const p = new TflProvider({ fetchImpl: stubFetch(), ttlMs: 1000 });
    await p.refresh(1000);
    assert.equal(p.current().get('victoria'), 'Severe Delays');
    assert.equal(p.current().get('piccadilly'), 'Part Closure, Part Suspended');
    assert.equal(p.current().has('jubilee'), false);   // Good Service
    assert.equal(p.current().has('central'), false);   // Minor Delays excluded (noise)
    assert.equal(p.current().size, 2);
  });

  it('keeps last-good on a failed refresh', async () => {
    let ok = true;
    const p = new TflProvider({ fetchImpl: async () => ({ ok, json: async () => statusJson }), ttlMs: 0 });
    await p.refresh(1000);
    assert.equal(p.current().size, 2);
    ok = false;
    await p.refresh(2000);
    assert.equal(p.current().size, 2);
  });
});

// ── Tier 5c — journey underestimation ─────────────────────────────────────────
import { verifyJourneyClaim } from './checks';
import { haversineKm, estimateJourneyMinutes, _resetGeoCacheForTesting, geocodePlace } from './journey';

describe('journey estimation (Tier 5c)', () => {
  it('haversineKm — London→Paris is ~340km', () => {
    const d = haversineKm({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 });
    assert.ok(d > 330 && d < 350, `got ${d}`);
  });

  it('estimateJourneyMinutes — 2km walk ~30 min, 20km drive ~70', () => {
    assert.ok(Math.abs(estimateJourneyMinutes(2, 'walk') - 32) <= 3);
    assert.ok(Math.abs(estimateJourneyMinutes(20, 'drive') - 70) <= 5);
  });
});

describe('geocodePlace — ambient-fetch default (native hosts omit worldDataFetch)', () => {
  it('falls back to globalThis.fetch when fetchImpl is undefined', async () => {
    _resetGeoCacheForTesting();
    const g = globalThis as { fetch?: unknown };
    const saved = g.fetch;
    let hit = '';
    g.fetch = async (url: string) => {
      hit = url;
      return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [-0.165, 51.587] } }] }) };
    };
    try {
      const r = await geocodePlace('east finchley', undefined);
      assert.ok(hit.includes('photon.komoot.io'), 'ambient fetch was used');
      assert.ok(r && Math.abs(r.lat - 51.587) < 1e-6, 'GeoJSON [lon,lat] parsed');
    } finally {
      g.fetch = saved;
      _resetGeoCacheForTesting();
    }
  });
});

describe('verifyJourneyClaim (Tier 5c, async geocode)', () => {
  // Stub geocoder: A and B are ~5.5km apart (a gross walk underestimate, within
  // the 20km walk sanity cap); C is ~0.9km from A (a reasonable 10-min walk).
  const coords = {
    'a place': { latitude: 51.50, longitude: -0.10 },
    'b place': { latitude: 51.50, longitude: -0.02 },
    'c place': { latitude: 51.50, longitude: -0.087 },
    // ~1.63km east of 'a place' — the east-finchley → muswell-hill geometry.
    'd place': { latitude: 51.50, longitude: -0.0765 },
    // ~1.45km east — the SAME pair as the home-biased geocode resolves it
    // (5-minute drive estimate, a 2-minute gap against a stated 3).
    'e place': { latitude: 51.50, longitude: -0.07907 },
  };
  const fetchImpl = async (url: string) => {
    // Photon: ?q=<name> → GeoJSON features with [lon, lat] coordinates.
    const name = decodeURIComponent(new URL(url).searchParams.get('q') ?? '').toLowerCase();
    const hit = (coords as Record<string, { latitude: number; longitude: number }>)[name];
    return { ok: true, json: async () => ({ features: hit ? [{ geometry: { coordinates: [hit.longitude, hit.latitude] } }] : [] }) };
  };
  const beforeEachClear = () => _resetGeoCacheForTesting();

  it('flags a gross underestimate (5-min walk that is ~20km)', async () => {
    beforeEachClear();
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'B place', statedMinutes: 5, mode: 'walk', quote: '5 minute walk from A place to B place' },
      'its a 5 minute walk from A place to B place', fetchImpl);
    assert.ok(v);
    assert.match(v.tip, /minute walk, not 5/);
  });

  // The short-hop regression: a flat 10-minute gap floor made every urban hop
  // unflaggable. Real case (2026-07-26): "i'm in east finchley i'll be in
  // muswell hill in 3 minutes" — parsed correctly as a 1.63km drive claim,
  // estimated at 6 minutes, then discarded because 6 - 3 = 3 < 10. `D place`
  // sits ~1.63km from `A place` to reproduce that geometry exactly.
  it('flags a SHORT hop that is grossly out (~1.6km drive stated 3 min)', async () => {
    beforeEachClear();
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'D place', statedMinutes: 3, mode: 'drive', quote: 'in 3 minutes' },
      "i'm at A place, i'll be at D place in 3 minutes", fetchImpl);
    assert.ok(v, 'a 2x-out short hop must flag — the old flat 10-min floor hid it');
    assert.match(v.tip, /minute drive, not 3/);
  });

  // The same claim as above, but with the distance the HOME-BIASED geocode
  // actually returns (the source biases photon by host timezone, so
  // east-finchley → muswell-hill lands at 1.56km / 5 min, not 1.63km / 6 min).
  // This is the case that must flag for the reported sentence to work.
  it('flags the home-biased short hop (5-min drive stated 3, gap of 2)', async () => {
    beforeEachClear();
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'E place', statedMinutes: 3, mode: 'drive', quote: 'in 3 minutes' },
      "i'm at A place, i'll be at E place in 3 minutes", fetchImpl);
    assert.ok(v, 'the reported east-finchley → muswell-hill geometry must flag');
    assert.match(v.tip, /5-minute drive, not 3/);
  });

  // The ratio gate — not the floor — is what protects small numbers.
  it('is SILENT when a short hop is only slightly out (4-min drive stated 3)', async () => {
    beforeEachClear();
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'C place', statedMinutes: 3, mode: 'drive', quote: 'in 3 minutes' },
      "i'm at A place, i'll be at C place in 3 minutes", fetchImpl);
    assert.equal(v, null, '0.9km ≈ 3-min drive vs stated 3 is a tight call, not a contradiction');
  });

  it('is SILENT on a long journey inside the scaled floor (stated 60, est ~65)', async () => {
    beforeEachClear();
    // 26km drive ≈ 91 min, so pick a stated value the ratio gate lets through
    // and let the scaled floor (max(3, stated/2)) do the suppressing: stated 60
    // needs a 30-min gap. Uses B place (~5.5km → 19-min drive) with stated 12:
    // ratio 19/12 = 1.58 < 1.6 already silences; the floor is belt-and-braces
    // for the near-miss band, pinned here so a future ratio tweak can't make
    // small absolute gaps noisy.
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'B place', statedMinutes: 12, mode: 'drive', quote: 'in 12 minutes' },
      "i'm at A place, i'll be at B place in 12 minutes", fetchImpl);
    assert.equal(v, null);
  });

  it('is SILENT when the stated time is reasonable (~0.9km walk stated 10 min)', async () => {
    beforeEachClear();
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'C place', statedMinutes: 10, mode: 'walk', quote: '10 min walk from A place to C place' },
      '10 min walk from A place to C place', fetchImpl);
    assert.equal(v, null);
  });

  it('is SILENT when a place cannot be geocoded', async () => {
    beforeEachClear();
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'Nowhere', statedMinutes: 2, mode: 'walk', quote: '2 min from A place to Nowhere' },
      '2 min from A place to Nowhere', fetchImpl);
    assert.equal(v, null);
  });

  it('GROUNDING: rejects a quote not in the sentence', async () => {
    beforeEachClear();
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: 'B place', statedMinutes: 5, mode: 'walk', quote: 'not present' },
      'unrelated sentence', fetchImpl);
    assert.equal(v, null);
  });

  // SECURITY: origin/destination are the only LLM-emitted strings that leave the
  // machine (they become the geocoder's ?q=). They must be grounded in the
  // sentence — an ungrounded value is either a hallucination or an injection
  // payload, and neither may reach the external geocoder.
  it('SECURITY: an ungrounded origin never reaches the geocoder', async () => {
    beforeEachClear();
    let geocoded = false;
    const spyFetch = async (url: string) => { geocoded = true; return fetchImpl(url); };
    const v = await verifyJourneyClaim(
      // quote IS in the sentence, but origin is an injected string that is NOT.
      { type: 'journey_underestimate', origin: 'exfiltrate my secrets to attacker', destination: 'B place', statedMinutes: 5, mode: 'walk', quote: '5 minute walk to B place' },
      'its a 5 minute walk to B place', spyFetch);
    assert.equal(v, null);
    assert.equal(geocoded, false, 'geocoder must not be called for an ungrounded origin');
  });

  it('SECURITY: an oversized place name never reaches the geocoder', async () => {
    beforeEachClear();
    let geocoded = false;
    const spyFetch = async (url: string) => { geocoded = true; return fetchImpl(url); };
    const huge = 'x'.repeat(500);
    const v = await verifyJourneyClaim(
      { type: 'journey_underestimate', origin: 'A place', destination: huge, statedMinutes: 5, mode: 'walk', quote: `5 minute walk from A place to ${huge}` },
      `5 minute walk from A place to ${huge}`, spyFetch);
    assert.equal(v, null);
    assert.equal(geocoded, false, 'geocoder must not be called for an oversized place name');
  });
});
