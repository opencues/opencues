/**
 * The claim grammar — every field a verbatim substring, null when a type's
 * operands are not all there. The bench that decides the questions is
 * private; these pin the capture the sources rely on.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { captureClaim as cc, candidateClaimTypes, captureDateRef } from './capture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const captureClaim = (t: string, s: string): any => cc(t, s);

describe('captureDateRef', () => {
  it('reads every shape the verifier resolves', () => {
    assert.deepStrictEqual(captureDateRef('see you Thursday the 24th'), { weekday: 'Thursday', day: 24, month: null, quote: 'Thursday the 24th', index: 8 });
    assert.strictEqual(captureDateRef('Friday, 24 July 2026 works')?.quote, 'Friday, 24 July');
    assert.deepStrictEqual(captureDateRef('Invoices go out Tuesday, September 1.')?.quote, 'Tuesday, September 1');
    assert.deepStrictEqual(captureDateRef('the 25th of December at 10'), { weekday: null, day: 25, month: 'December', quote: 'the 25th of December', index: 0 });
    assert.strictEqual(captureDateRef('BBQ on the 22nd')?.day, 22);
    assert.strictEqual(captureDateRef('back Monday')?.weekday, 'Monday');
    assert.strictEqual(captureDateRef('no date here'), null);
    assert.strictEqual(captureDateRef('the 40th time'), null);
  });
});

describe('captureClaim', () => {
  it('weekday_date needs a weekday attached to a day; a weekday and a day elsewhere are not one date', () => {
    assert.deepStrictEqual(captureClaim('weekday_date', 'See you Thursday the 24th.'), { type: 'weekday_date', weekday: 'Thursday', day: 24, month: null, quote: 'Thursday the 24th' });
    assert.strictEqual(captureClaim('weekday_date', 'I was there on Saturday and the 24th was a mess.'), null);
    assert.strictEqual(captureClaim('weekday_date', 'Thursday works, or the 24th if you prefer.'), null);
  });
  it('bill_split needs total, headcount and a per-person figure', () => {
    assert.deepStrictEqual(captureClaim('bill_split', 'Dinner was $120 between four of us so $25 each.'), { type: 'bill_split', total: 120, count: 4, perPerson: 25, quotes: { total: '$120', count: 'four of us', perPerson: '$25 each' } });
    assert.strictEqual(captureClaim('bill_split', '$200 for 5 people, so 40 a head.')?.perPerson, 40);
    assert.strictEqual(captureClaim('bill_split', 'Split the $120 bill four ways please.'), null);
    assert.strictEqual(captureClaim('bill_split', 'Six of us chipped in $10 each.'), null);
  });
  it('arithmetic: plain, percent-of, plus-percent, percent-off, in either order', () => {
    assert.deepStrictEqual(captureClaim('arithmetic', 'With tax it is 100 * 1.08 = 110.'), { type: 'arithmetic', expression: '100*1.08', statedResult: 110, quote: '100 * 1.08 = 110' });
    assert.strictEqual(captureClaim('arithmetic', 'So 15% of 240 is 40.')?.expression, '240*15/100');
    assert.strictEqual(captureClaim('arithmetic', 'Adding 20% tip, $50 plus 20% gives $65.')?.expression, '50*(1+20/100)');   // not `50+20`
    assert.strictEqual(captureClaim('arithmetic', 'At 20% off, $80 works out to $60.')?.expression, '80*(1-20/100)');
    assert.strictEqual(captureClaim('arithmetic', 'Rent plus bills: 900 + 250 comes to 1150.')?.statedResult, 1150);
    assert.strictEqual(captureClaim('arithmetic', 'Half of 90 is 45 so we are fine.'), null);
  });
  it('dated plans quote the date reference', () => {
    assert.deepStrictEqual(captureClaim('workday_on_holiday', 'Back in the office Monday, see you then.'), { type: 'workday_on_holiday', weekday: 'Monday', day: null, month: null, quote: 'Monday' });
    assert.strictEqual(captureClaim('outdoor_plan_weather', 'BBQ at ours on the 22nd, bring a salad.')?.day, 22);
    assert.strictEqual(captureClaim('outdoor_plan_weather', 'Going for a run later.'), null);
  });
  it('tube_line_plan needs a named line', () => {
    assert.deepStrictEqual(captureClaim('tube_line_plan', "I'll take the Victoria line to Brixton."), { type: 'tube_line_plan', line: 'Victoria', quote: 'the Victoria line' });
    assert.strictEqual(captureClaim('tube_line_plan', "We'll catch the DLR from Canary Wharf.")?.line, 'DLR');
    assert.strictEqual(captureClaim('tube_line_plan', 'Meet me at Oxford Circus at 6.'), null);
  });
  it('journey_underestimate needs two places and a minute figure; public transit declines', () => {
    assert.deepStrictEqual(captureClaim('journey_underestimate', "It's a 5 minute walk from King's Cross to Camden."), { type: 'journey_underestimate', origin: "King's Cross", destination: 'Camden', statedMinutes: 5, mode: 'walk', quote: "5 minute walk from King's Cross to Camden" });
    assert.strictEqual(captureClaim('journey_underestimate', 'Brighton to Oxford is a 20 minute drive.')?.mode, 'drive');
    assert.strictEqual(captureClaim('journey_underestimate', 'I can cycle from Hackney to Richmond in 10 minutes.')?.mode, 'cycle');
    assert.strictEqual(captureClaim('journey_underestimate', "It's a 10 minute walk from my flat."), null);
    assert.strictEqual(captureClaim('journey_underestimate', 'From Leeds to Manchester the train is 50 minutes.'), null);
    assert.strictEqual(captureClaim('journey_underestimate', 'Give me 10 minutes to walk over.'), null);
  });
  it('an unknown type is null', () => { assert.strictEqual(captureClaim('zorb', 'anything'), null); });
});

describe('candidateClaimTypes', () => {
  it('offers only the types the grammar could ground, nothing for plain prose', () => {
    assert.deepStrictEqual(candidateClaimTypes('Thanks for the update, I will review it this week.'), []);
    assert.deepStrictEqual(candidateClaimTypes('Fancy a hike on Sunday?'), ['workday_on_holiday', 'outdoor_plan_weather']);
    assert.deepStrictEqual(candidateClaimTypes('So 15% of 240 is 40.'), ['arithmetic']);
    assert.deepStrictEqual(candidateClaimTypes('See you Thursday the 24th.'), ['weekday_date', 'workday_on_holiday', 'outdoor_plan_weather']);
  });
});
