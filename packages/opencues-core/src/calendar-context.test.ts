/**
 * Unit tests for the calendar-context module (Phase 1a). Runs under node:test
 * (same convention as blank-context.test.ts / system-context consumers).
 *
 * Deterministic — no LLM. Pins:
 *   - buildCalendarContextSnapshot — token assignment, probe-and-include, catalog
 *   - renderCalendarContextCatalog — off/empty → '', on → times-in-clear + tokens
 *   - the hydration round-trip via postProcessContext (token → real title)
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildCalendarContextSnapshot, renderCalendarContextCatalog } from './calendar-context';
import { postProcessContext } from './identity-context';

const EVENTS = [
  { title: 'Dentist',        start: '2026-07-17T14:00', end: '2026-07-17T15:00', location: '5 High St Clinic' },
  { title: 'Team standup',   start: '2026-07-17T16:00', end: '2026-07-17T16:30' },
  { title: 'Conference',     start: '2026-07-22T00:00', end: '2026-07-22T23:59', allDay: true },
];

describe('buildCalendarContextSnapshot', () => {
  it('assigns sequential [EVENT N] tokens and builds a token→title catalog', () => {
    const snap = buildCalendarContextSnapshot(EVENTS);
    assert.deepEqual(snap.events.map((e) => e.token), ['[EVENT 1]', '[EVENT 2]', '[EVENT 3]']);
    assert.equal(snap.catalog.get('[EVENT 1]'), 'Dentist');
    assert.equal(snap.catalog.get('[EVENT 2]'), 'Team standup');
    assert.equal(snap.catalog.get('[EVENT 3]'), 'Conference');
  });

  it('drops events missing a start or a title (probe-and-include)', () => {
    const snap = buildCalendarContextSnapshot([
      { title: 'Real', start: '2026-07-17T09:00', end: '2026-07-17T10:00' },
      { title: '', start: '2026-07-18T09:00', end: '2026-07-18T10:00' },
      { title: 'NoStart', start: '', end: '2026-07-19T10:00' },
    ]);
    assert.equal(snap.events.length, 1);
    assert.equal(snap.events[0].title, 'Real');
    assert.equal(snap.events[0].token, '[EVENT 1]');
  });

  it('preserves a caller-supplied token when present', () => {
    const snap = buildCalendarContextSnapshot([{ token: '[MEETING]', title: 'X', start: '2026-07-17T09:00', end: '2026-07-17T10:00' }]);
    assert.equal(snap.events[0].token, '[MEETING]');
    assert.equal(snap.catalog.get('[MEETING]'), 'X');
  });

  it('tokenizes LOCATION into [EVENT N LOCATION] + catalog when present, none otherwise', () => {
    const snap = buildCalendarContextSnapshot(EVENTS);
    // Dentist (event 1) has a location → its own token, in the catalog.
    assert.equal(snap.events[0].locationToken, '[EVENT 1 LOCATION]');
    assert.equal(snap.catalog.get('[EVENT 1 LOCATION]'), '5 High St Clinic');
    // Events without a location get no location token (and none in the catalog).
    assert.equal(snap.events[1].locationToken, undefined);
    assert.equal(snap.catalog.has('[EVENT 2 LOCATION]'), false);
  });
});

describe('renderCalendarContextCatalog', () => {
  it('returns empty string when off or empty (no-op)', () => {
    const snap = buildCalendarContextSnapshot(EVENTS);
    assert.equal(renderCalendarContextCatalog(snap, 'off'), '');
    assert.equal(renderCalendarContextCatalog(buildCalendarContextSnapshot([]), 'on'), '');
    assert.equal(renderCalendarContextCatalog(undefined, 'on'), '');
  });

  it('renders times as numeric minute-intervals (the "maths" substrate) + a 12h gloss, titles as tokens', () => {
    const block = renderCalendarContextCatalog(buildCalendarContextSnapshot(EVENTS), 'on');
    // Numeric minutes-since-midnight interval + weekday + 12h gloss.
    assert.match(block, /\[EVENT 1\]: Fri 2026-07-17, mins 840–900 \(2:00pm–3:00pm\)/);
    assert.match(block, /\[EVENT 2\]: Fri 2026-07-17, mins 960–990 \(4:00pm–4:30pm\)/);
    // All-day rendered as the full-day interval.
    assert.match(block, /\[EVENT 3\]: Wed 2026-07-22, all day \(mins 0–1439\)/);
    // The real titles NEVER appear in the prompt block (they're behind tokens).
    assert.doesNotMatch(block, /Dentist|Team standup|Conference/);
  });

  it('renders LOCATION as its token (never the raw address) — PII stays local', () => {
    const block = renderCalendarContextCatalog(buildCalendarContextSnapshot(EVENTS), 'on');
    // Event 1's location is shown as a token after `@`, not the real place.
    assert.match(block, /\[EVENT 1\]: Fri 2026-07-17, mins 840–900 \(2:00pm–3:00pm\) @ \[EVENT 1 LOCATION\]/);
    assert.doesNotMatch(block, /5 High St Clinic/);
    // Events with no location carry no `@` location clause.
    assert.match(block, /\[EVENT 2\]: Fri 2026-07-17, mins 960–990 \(4:00pm–4:30pm\)\n/);
  });

  it('surfaces ingestedAt as a refresh marker when provided', () => {
    const block = renderCalendarContextCatalog(buildCalendarContextSnapshot(EVENTS, '2026-07-17T09:00'), 'on');
    assert.match(block, /last refreshed 2026-07-17T09:00/);
  });

  it('renders a live CURRENT MOMENT anchor when nowIso given', () => {
    const block = renderCalendarContextCatalog(buildCalendarContextSnapshot(EVENTS), 'on', '2026-07-18T10:30');
    assert.match(block, /CURRENT MOMENT/);
    assert.match(block, /it is now Sat 2026-07-18, 10:30am \(minutes-since-midnight 630\)/);
    // No "PASSED → drop" instruction — availability is date-scoped so it's
    // redundant, and it used to suppress recall. Recall is folded into the
    // LOOKUP rule (past OR future), which the lookup-fix reworded from the
    // earlier standalone "RECALL / when was X" phrasing.
    assert.doesNotMatch(block, /has already PASSED/);
    assert.match(block, /LOOKUP questions ask you to NAME an event \(past OR future\)/);
  });

  it('omits the live now-anchor sentence when nowIso is absent', () => {
    const block = renderCalendarContextCatalog(buildCalendarContextSnapshot(EVENTS), 'on');
    assert.doesNotMatch(block, /it is now/);
  });
});

describe('hydration round-trip', () => {
  it('postProcessContext substitutes [EVENT N] → the real title', () => {
    const snap = buildCalendarContextSnapshot(EVENTS);
    const out = postProcessContext('[EVENT 1]', { catalog: snap.catalog, originalBody: 'am i free _' }).output;
    assert.equal(out, 'Dentist');
  });

  it('hydrates a token embedded in prose', () => {
    const snap = buildCalendarContextSnapshot(EVENTS);
    const out = postProcessContext('Busy 2–3pm ([EVENT 1])', { catalog: snap.catalog, originalBody: 'am i free at 2pm _' }).output;
    assert.equal(out, 'Busy 2–3pm (Dentist)');
  });

  it('hydrates [EVENT N LOCATION] → the real location (where-is lookup)', () => {
    const snap = buildCalendarContextSnapshot(EVENTS);
    const out = postProcessContext('[EVENT 1] — at [EVENT 1 LOCATION]', { catalog: snap.catalog, originalBody: 'where is my next event _' }).output;
    assert.equal(out, 'Dentist — at 5 High St Clinic');
  });
});
