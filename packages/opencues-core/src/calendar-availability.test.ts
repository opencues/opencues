/**
 * The availability grammar and the clash: the day and time a sentence names,
 * resolved against a fixed clock; which events overlap; the note's shape.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { captureAvailabilityRef, findClashes, renderHeadsUp } from './calendar-availability';

const NOW = new Date('2026-07-17T09:00:00');   // Fri
const d = (day: number, monthIdx = 6, year = 2026) => ({ year, monthIdx, day });
const EVENTS = [
  { token: '[EVENT 1]', title: 'ALT-DENTIST', start: '2026-07-17T15:00', end: '2026-07-17T15:45' },
  { token: '[EVENT 2]', title: 'ALT-STANDUP', start: '2026-07-17T16:00', end: '2026-07-17T16:30' },
  { token: '[EVENT 3]', title: 'ALT-FOOTBALL', start: '2026-07-18T10:00', end: '2026-07-18T12:00' },
  { token: '[EVENT 4]', title: 'ALT-ALLDAY', start: '2026-07-22T00:00', end: '2026-07-22T23:59', allDay: true },
  { token: '[EVENT 5]', title: 'ALT-FLIGHT', start: '2026-07-25T07:00', end: '2026-07-25T10:00' },
];

describe('captureAvailabilityRef', () => {
  it('resolves the day', () => {
    assert.deepStrictEqual(captureAvailabilityRef("I'm free at 3pm today.", NOW), { days: [d(17)], window: { start: 900, end: 901 }, quote: 'today' });
    assert.deepStrictEqual(captureAvailabilityRef('How about tomorrow morning?', NOW)?.days, [d(18)]);
    assert.deepStrictEqual(captureAvailabilityRef('I can do Monday at 9:30am.', NOW), { days: [d(20)], window: { start: 570, end: 571 }, quote: 'Monday' });
    assert.deepStrictEqual(captureAvailabilityRef('Friday works.', NOW)?.days, [d(17)]);            // today, on a Friday
    assert.deepStrictEqual(captureAvailabilityRef('Next Friday works.', NOW)?.days, [d(24)]);       // never today
    assert.deepStrictEqual(captureAvailabilityRef('Next Saturday at 8am works.', NOW)?.days, [d(25)]);   // the week after
    assert.deepStrictEqual(captureAvailabilityRef('This weekend suits me.', NOW)?.days, [d(18), d(19)]);
    assert.deepStrictEqual(captureAvailabilityRef('Next weekend suits me.', NOW)?.days, [d(25), d(26)]);
    assert.deepStrictEqual(captureAvailabilityRef('Sure, the 22nd works.', NOW)?.days, [d(22)]);
    assert.deepStrictEqual(captureAvailabilityRef('The 3rd is fine.', NOW)?.days, [d(3, 7)]);        // next month
    assert.deepStrictEqual(captureAvailabilityRef('Happy to meet on the 25th of July.', NOW)?.days, [d(25)]);
    assert.deepStrictEqual(captureAvailabilityRef('Let us say August 2.', NOW)?.days, [d(2, 7)]);
    assert.strictEqual(captureAvailabilityRef('I love pizza.', NOW), null);
  });
  it('resolves the window: a point, a range, a part of the day, a bare hour before the day word', () => {
    assert.deepStrictEqual(captureAvailabilityRef("Let's meet at 3:15 this afternoon.", NOW)?.window, { start: 915, end: 916 });
    assert.deepStrictEqual(captureAvailabilityRef('I could do Tuesday between 2 and 4.', NOW)?.window, { start: 840, end: 960 });
    assert.deepStrictEqual(captureAvailabilityRef('Free from 3 till 5 this afternoon.', NOW)?.window, { start: 900, end: 1020 });
    assert.deepStrictEqual(captureAvailabilityRef("I'm free this afternoon.", NOW)?.window, { start: 720, end: 1080 });
    assert.deepStrictEqual(captureAvailabilityRef('Tonight works.', NOW), { days: [d(17)], window: { start: 1080, end: 1440 }, quote: 'Tonight' });
    assert.deepStrictEqual(captureAvailabilityRef('Yes, 3 today is good.', NOW)?.window, { start: 900, end: 901 });
    assert.deepStrictEqual(captureAvailabilityRef('Around 9 tomorrow?', NOW)?.window, { start: 540, end: 541 });
    assert.strictEqual(captureAvailabilityRef('Free all day Saturday.', NOW)?.window, null);
    assert.deepStrictEqual(captureAvailabilityRef('Noon works.', NOW), { days: [d(17)], window: { start: 720, end: 721 }, quote: 'today' });
  });
});

describe('findClashes + renderHeadsUp', () => {
  const ref = (s: string) => captureAvailabilityRef(s, NOW)!;
  const titles = (s: string) => findClashes(ref(s), EVENTS).map((e) => e.title);
  it('a point inside an event, a window overlapping one, a day with an all-day event', () => {
    assert.deepStrictEqual(titles("I'm free at 3pm today."), ['ALT-DENTIST']);
    assert.deepStrictEqual(titles("I'm free at 5pm today."), []);
    assert.deepStrictEqual(titles("I'm free this afternoon."), ['ALT-DENTIST', 'ALT-STANDUP']);
    assert.deepStrictEqual(titles('Free from 3 till 5 this afternoon.'), ['ALT-DENTIST', 'ALT-STANDUP']);
    assert.deepStrictEqual(titles('Wednesday at 10 works.'), ['ALT-ALLDAY']);
    assert.deepStrictEqual(titles('Anytime this weekend.'), ['ALT-FOOTBALL']);
    assert.deepStrictEqual(titles('Tomorrow evening is good.'), []);
  });
  it('the note names the day relatively when near, by date otherwise, and all-day as all day', () => {
    assert.strictEqual(renderHeadsUp(findClashes(ref("I'm free this afternoon."), EVENTS), NOW), 'heads up: ALT-DENTIST today, 3:00–3:45pm; ALT-STANDUP today, 4:00–4:30pm');
    assert.strictEqual(renderHeadsUp(findClashes(ref('Tomorrow morning?'), EVENTS), NOW), 'heads up: ALT-FOOTBALL tomorrow, 10:00–12:00pm');
    assert.strictEqual(renderHeadsUp(findClashes(ref('The 22nd works.'), EVENTS), NOW), 'heads up: ALT-ALLDAY Wed Jul 22, all day');
    assert.strictEqual(renderHeadsUp(findClashes(ref('Next Saturday at 8am.'), EVENTS), NOW), 'heads up: ALT-FLIGHT Sat Jul 25, 7:00–10:00am');
  });
});
