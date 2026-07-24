/**
 * calendar-sync — the ONE feeds→snapshot implementation (CLI + runtime
 * scheduler + chrome-host all call this; see the mirrored-guard drift
 * lesson for why it must not be copied).
 *
 * Hermetic: injected fs paths under a mkdtemp dir, injected fetch.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  syncCalendarFeeds,
  calendarSyncDue,
  readCalendarFeedUrls,
  CALENDAR_SYNC_TTL_MS,
} from './calendar-sync';

let dir = '';
beforeEach(() => { dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'opencues-cal-sync-')); });
afterEach(() => { realFs.rmSync(dir, { recursive: true, force: true }); });

const fsDep = realFs as unknown as Parameters<typeof calendarSyncDue>[0];

function writeFeeds(lines: string[]): void {
  realFs.writeFileSync(path.join(dir, 'calendar-feeds.txt'), lines.join('\n') + '\n');
}
function writeSnapshot(ingestedAt: string): void {
  realFs.writeFileSync(path.join(dir, 'calendar.json'), JSON.stringify({ ingestedAt, events: [] }));
}
function ics(summary: string, startUtc: string, endUtc: string): string {
  return `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:${startUtc}\nDTEND:${endUtc}\nSUMMARY:${summary}\nEND:VEVENT\nEND:VCALENDAR\n`;
}
function inWindowStamp(hoursAhead: number): { s: string; e: string } {
  const d = new Date(Date.now() + hoursAhead * 3600e3);
  const f = (x: Date): string => x.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const end = new Date(d.getTime() + 3600e3);
  return { s: f(d), e: f(end) };
}

describe('calendarSyncDue — the scheduler due-check', () => {
  it('not due without a feeds file', () => {
    assert.equal(calendarSyncDue(fsDep, dir), false);
  });
  it('due when feeds exist and no snapshot', () => {
    writeFeeds(['https://example.test/a.ics']);
    assert.equal(calendarSyncDue(fsDep, dir), true);
  });
  it('not due when the snapshot is fresh; due once older than the TTL', () => {
    writeFeeds(['https://example.test/a.ics']);
    writeSnapshot(new Date().toISOString());
    assert.equal(calendarSyncDue(fsDep, dir), false);
    writeSnapshot(new Date(Date.now() - CALENDAR_SYNC_TTL_MS - 1000).toISOString());
    assert.equal(calendarSyncDue(fsDep, dir), true);
  });
  it('comment lines and blanks are not feeds', () => {
    writeFeeds(['# disabled https://example.test/x.ics', '']);
    assert.equal(readCalendarFeedUrls(fsDep, dir)?.length, 0);
    assert.equal(calendarSyncDue(fsDep, dir), false);
  });
});

describe('syncCalendarFeeds', () => {
  it('fetches, parses, dedupes across feeds, writes atomically', async () => {
    writeFeeds(['https://example.test/a.ics', 'webcal://example.test/b.ics']);
    const { s, e } = inWindowStamp(24);
    const seen: string[] = [];
    const r = await syncCalendarFeeds({
      fs: fsDep as never, cuesDir: dir,
      fetchImpl: async (url) => {
        seen.push(url);
        // both feeds carry the same event → dedupe to one
        return { ok: true, status: 200, text: async () => ics('Shared Event', s, e) };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.okCount, 2);
    assert.equal(r.events, 1, 'identical start|title deduped');
    assert.ok(seen[1].startsWith('https://'), 'webcal:// upgraded to https://');
    const snap = JSON.parse(realFs.readFileSync(path.join(dir, 'calendar.json'), 'utf8'));
    assert.equal(snap.events.length, 1);
    assert.equal(snap.events[0].title, 'Shared Event');
    assert.ok(snap.ingestedAt);
    assert.equal(realFs.readdirSync(dir).filter(f => f.includes('.tmp-')).length, 0, 'no tmp leftovers');
  });

  it('all feeds failing keeps the previous snapshot (last-good posture)', async () => {
    writeFeeds(['https://example.test/a.ics']);
    writeSnapshot('2026-07-01T00:00:00Z');
    const before = realFs.readFileSync(path.join(dir, 'calendar.json'), 'utf8');
    const r = await syncCalendarFeeds({
      fs: fsDep as never, cuesDir: dir,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(r.ok, false);
    assert.equal(realFs.readFileSync(path.join(dir, 'calendar.json'), 'utf8'), before);
  });

  it('a 200 HTML page is refused (VCALENDAR sniff)', async () => {
    writeFeeds(['https://example.test/login.html']);
    const r = await syncCalendarFeeds({
      fs: fsDep as never, cuesDir: dir,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>sign in</html>' }),
    });
    assert.equal(r.ok, false);
  });

  it('an oversized feed body is refused (size cap, not parsed)', async () => {
    writeFeeds(['https://example.test/huge.ics']);
    // A valid-looking VCALENDAR but larger than the cap — must be dropped
    // before parseIcs, so the run has no successful feed.
    const huge = 'BEGIN:VCALENDAR\n' + 'X-PADDING:' + 'a'.repeat(6 * 1024 * 1024) + '\nEND:VCALENDAR';
    const r = await syncCalendarFeeds({
      fs: fsDep as never, cuesDir: dir,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => huge }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.okCount, 0);
  });

  it('discards its own result when another producer refreshed concurrently', async () => {
    writeFeeds(['https://example.test/a.ics']);
    const { s, e } = inWindowStamp(24);
    const r = await syncCalendarFeeds({
      fs: fsDep as never, cuesDir: dir,
      fetchImpl: async () => {
        // simulate a competing producer winning the race mid-fetch
        writeSnapshot(new Date(Date.now() + 5000).toISOString());
        return { ok: true, status: 200, text: async () => ics('Mine', s, e) };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'superseded');
    const snap = JSON.parse(realFs.readFileSync(path.join(dir, 'calendar.json'), 'utf8'));
    assert.equal(snap.events.length, 0, 'the newer snapshot was NOT clobbered');
  });
});
