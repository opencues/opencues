/**
 * Unit tests for the .ics parser. Run under node:test.
 *
 * TZ is pinned to UTC (process.env.TZ + `TZ=UTC` on the runner) so UTC-time
 * assertions are deterministic — the parser converts to the RUNTIME's local
 * wall-clock, which under TZ=UTC equals the UTC time.
 */
process.env.TZ = 'UTC';

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseIcs } from './ics';

const wrap = (vevents: string): string =>
  `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//test//EN\n${vevents}\nEND:VCALENDAR\n`;

describe('parseIcs — basics', () => {
  it('parses a floating-time VEVENT (title, start, end, location)', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Team standup\nDTSTART:20260717T090000\nDTEND:20260717T093000\nLOCATION:Room 4\nEND:VEVENT`,
    ));
    assert.equal(ev.length, 1);
    assert.equal(ev[0].title, 'Team standup');
    assert.equal(ev[0].start, '2026-07-17T09:00');
    assert.equal(ev[0].end, '2026-07-17T09:30');
    assert.equal(ev[0].location, 'Room 4');
    assert.ok(!ev[0].allDay);
  });

  it('parses UTC times (Luma-shaped) to local wall-clock', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Launch party\nDTSTART:20260717T150000Z\nDTEND:20260717T154500Z\nEND:VEVENT`,
    ));
    assert.equal(ev[0].start, '2026-07-17T15:00'); // TZ=UTC → unchanged
    assert.equal(ev[0].end, '2026-07-17T15:45');
  });

  it('parses an all-day event (VALUE=DATE), DTEND exclusive', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Conference\nDTSTART;VALUE=DATE:20260722\nDTEND;VALUE=DATE:20260723\nEND:VEVENT`,
    ));
    assert.equal(ev[0].allDay, true);
    assert.equal(ev[0].start, '2026-07-22T00:00');
    assert.equal(ev[0].end, '2026-07-22T23:59'); // exclusive DTEND collapsed to same day
  });

  it('derives end from DURATION when DTEND absent', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Focus\nDTSTART:20260717T090000\nDURATION:PT1H30M\nEND:VEVENT`,
    ));
    assert.equal(ev[0].start, '2026-07-17T09:00');
    assert.equal(ev[0].end, '2026-07-17T10:30');
  });

  it('unfolds folded lines and unescapes TEXT', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Long title that is fol\n ded across lines\\, with comma\nDTSTART:20260717T090000\nDTEND:20260717T093000\nEND:VEVENT`,
    ));
    assert.equal(ev[0].title, 'Long title that is folded across lines, with comma');
  });

  it('sorts multiple events by start and skips ones missing summary/dtstart', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Later\nDTSTART:20260718T090000\nDTEND:20260718T093000\nEND:VEVENT\n` +
      `BEGIN:VEVENT\nSUMMARY:Earlier\nDTSTART:20260717T090000\nDTEND:20260717T093000\nEND:VEVENT\n` +
      `BEGIN:VEVENT\nDTSTART:20260717T100000\nEND:VEVENT`, // no summary → skipped
    ));
    assert.equal(ev.length, 2);
    assert.equal(ev[0].title, 'Earlier');
    assert.equal(ev[1].title, 'Later');
  });

  it('never throws on malformed input', () => {
    assert.doesNotThrow(() => parseIcs('not a calendar at all'));
    assert.deepEqual(parseIcs(''), []);
    assert.doesNotThrow(() => parseIcs('BEGIN:VEVENT\nSUMMARY:x\nDTSTART:garbage\nEND:VEVENT'));
  });
});

describe('parseIcs — recurrence', () => {
  it('expands a WEEKLY;COUNT=3 rule into 3 weekly occurrences', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Weekly sync\nDTSTART:20260717T090000\nDTEND:20260717T093000\nRRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT`,
    ));
    assert.equal(ev.length, 3);
    assert.deepEqual(ev.map(e => e.start), ['2026-07-17T09:00', '2026-07-24T09:00', '2026-07-31T09:00']);
  });

  it('expands DAILY;INTERVAL=2;COUNT=3', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Every other day\nDTSTART:20260717T080000\nDTEND:20260717T081500\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=3\nEND:VEVENT`,
    ));
    assert.deepEqual(ev.map(e => e.start), ['2026-07-17T08:00', '2026-07-19T08:00', '2026-07-21T08:00']);
  });

  it('honours a window — recurrences outside are dropped', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Weekly\nDTSTART:20260717T090000\nDTEND:20260717T093000\nRRULE:FREQ=WEEKLY;COUNT=10\nEND:VEVENT`,
    ), { windowStartMs: new Date(2026, 6, 20).getTime(), windowEndMs: new Date(2026, 6, 30).getTime() });
    // Only the 2026-07-24 occurrence falls in [07-20, 07-30].
    assert.deepEqual(ev.map(e => e.start), ['2026-07-24T09:00']);
  });

  it('falls back to the master instance for an unsupported FREQ (MONTHLY)', () => {
    const ev = parseIcs(wrap(
      `BEGIN:VEVENT\nSUMMARY:Monthly\nDTSTART:20260717T090000\nDTEND:20260717T100000\nRRULE:FREQ=MONTHLY;COUNT=6\nEND:VEVENT`,
    ));
    assert.equal(ev.length, 1);
    assert.equal(ev[0].start, '2026-07-17T09:00');
  });
});

describe('parseIcs — realistic Luma feed', () => {
  it('parses a Luma-style VEVENT (UTC, CRLF folding, escaped location)', () => {
    const luma = [
      'BEGIN:VCALENDAR',
      'PRODID:-//lu.ma//EN',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:evt-abc123@lu.ma',
      'SUMMARY:OpenCues Community Meetup',
      'DTSTART:20260720T180000Z',
      'DTEND:20260720T200000Z',
      'LOCATION:The Grind Coffee\\, 123 Main St\\, London',
      'DESCRIPTION:Join us!',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const ev = parseIcs(luma);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].title, 'OpenCues Community Meetup');
    assert.equal(ev[0].start, '2026-07-20T18:00');
    assert.equal(ev[0].end, '2026-07-20T20:00');
    assert.equal(ev[0].location, 'The Grind Coffee, 123 Main St, London');
  });
});
