/**
 * buildCalendarContextIngest — native calendar.json → live resolver holder.
 *
 * Pins the July 2026 native-consumer gap: chrome's bootstrap read the
 * snapshot but no native band did, so the calendar-conflict cue and
 * fluid-blank availability answers were silently inert on CC/OC/gemini/
 * shell. The helper reads $OPENCUES_HOME/calendar.json (shard-friendly),
 * falls back to ~/.cues/calendar.json, tokenises via core's
 * buildCalendarContextSnapshot, and refreshes mtime-gated on a timer.
 *
 * Hermetic per the PR #41 pattern: every test runs against a mkdtemp
 * OPENCUES_HOME; the real ~/.cues is never touched.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCalendarContextIngest, type CalendarContextHolder } from './boot-common';

const noopLog = (): void => {};

function expectEq(actual: unknown, wanted: unknown, msg?: string): void {
  expect(actual, msg).toEqual(wanted);
}


let tmpHome = '';
let savedOverride: string | undefined;
const holders: CalendarContextHolder[] = [];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-cal-ingest-'));
  savedOverride = process.env['OPENCUES_HOME'];
  process.env['OPENCUES_HOME'] = tmpHome;
});

afterEach(() => {
  for (const h of holders.splice(0)) h.stop();
  if (savedOverride === undefined) delete process.env['OPENCUES_HOME'];
  else process.env['OPENCUES_HOME'] = savedOverride;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeSnapshot(events: unknown[], ingestedAt = '2026-07-20T10:00:00Z'): void {
  fs.writeFileSync(
    path.join(tmpHome, 'calendar.json'),
    JSON.stringify({ source: 'test', ingestedAt, events }, null, 2),
  );
}

function build(refreshMs?: number): CalendarContextHolder {
  const h = buildCalendarContextIngest(noopLog, refreshMs ? { refreshMs } : {});
  expect(h, 'holder constructed in a Node environment with core built').toBeTruthy();
  holders.push(h!);
  return h!;
}

describe('buildCalendarContextIngest', () => {
  it('loads events with [EVENT N] tokens and a hydration catalog', () => {
    writeSnapshot([
      { title: 'Dentist', start: '2026-07-21T15:00', end: '2026-07-21T16:00', location: 'Harley Street' },
      { title: 'Standup', start: '2026-07-22T09:30', end: '2026-07-22T09:45' },
    ]);
    const h = build();
    expectEq(h.events.length, 2);
    expectEq(h.events[0].token, '[EVENT 1]');
    expectEq(h.events[0].title, 'Dentist');
    expectEq(h.catalog.get('[EVENT 1]'), 'Dentist');
    expectEq(h.catalog.get('[EVENT 1 LOCATION]'), 'Harley Street');
    expectEq(h.ingestedAt, '2026-07-20T10:00:00Z');
  });

  it('is inert (empty holder) when no snapshot exists', () => {
    const h = build();
    expectEq(h.events.length, 0);
    expectEq(h.catalog.size, 0);
  });

  it('survives a malformed snapshot without throwing, keeping prior contents', () => {
    writeSnapshot([{ title: 'Kept', start: '2026-07-21T15:00', end: '2026-07-21T16:00' }]);
    const h = build();
    expectEq(h.events.length, 1);
    fs.writeFileSync(path.join(tmpHome, 'calendar.json'), '{ not json');
    // force a re-read attempt via a fresh holder tick (mtime changed)
    expect(() => {
      // direct second load through a new holder: malformed must not throw
      const h2 = build();
      expectEq(h2.events.length, 0, 'fresh holder never saw good data');
    }).not.toThrow();
    expectEq(h.events.length, 1, 'existing holder keeps last good data');
  });

  it('drops events missing start/title (probe-and-include contract)', () => {
    writeSnapshot([
      { title: 'Good', start: '2026-07-21T15:00', end: '2026-07-21T16:00' },
      { title: 'No start' },
      { start: '2026-07-23T10:00', end: '2026-07-23T11:00' },
    ]);
    const h = build();
    expectEq(h.events.length, 1);
    expectEq(h.events[0].title, 'Good');
  });

  it('re-reads on mtime change within the refresh cadence', async () => {
    writeSnapshot([{ title: 'One', start: '2026-07-21T15:00', end: '2026-07-21T16:00' }]);
    const h = build(50);
    expectEq(h.events.length, 1);
    await new Promise(r => setTimeout(r, 20));
    writeSnapshot([
      { title: 'One', start: '2026-07-21T15:00', end: '2026-07-21T16:00' },
      { title: 'Two', start: '2026-07-22T15:00', end: '2026-07-22T16:00' },
    ]);
    // wait past at least one refresh tick
    await new Promise(r => setTimeout(r, 200));
    expectEq(h.events.length, 2, 're-ingest applied without restart');
    expectEq(h.catalog.get('[EVENT 2]'), 'Two');
  });
});
