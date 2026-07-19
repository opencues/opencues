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
