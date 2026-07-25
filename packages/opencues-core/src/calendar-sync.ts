/**
 * Calendar feed sync — the ONE implementation of feeds → calendar.json.
 *
 * Extracted from the CLI (`opencues calendar sync`) so the runtime's
 * refresh scheduler, the chrome-host process, and the CLI all share it —
 * a hand-copied sync would be the July 2026 mirrored-guard drift class
 * all over again. Callers differ only in how they schedule it:
 *
 *   - CLI: on demand (`opencues calendar sync`).
 *   - Runtime refresh scheduler: due when the snapshot's `ingestedAt`
 *     is older than the resource TTL (15 min) — the snapshot file's own
 *     timestamp is the cross-host, cross-restart clock, so any number
 *     of concurrently-running hosts self-deduplicate.
 *   - chrome-host: same due check on its existing watch loop.
 *
 * Write discipline: atomic (tmp + rename) so a reader never sees a
 * half-written snapshot; a pre-write re-stat discards our result when
 * another producer refreshed while we were fetching (last writer would
 * otherwise clobber a NEWER snapshot with an older fetch).
 */

import { parseIcs } from './ics';

export interface CalendarSyncDeps {
  /** fs facade — pass `require('node:fs')` (kept injectable for tests). */
  readonly fs: {
    readFileSync(p: string, enc: 'utf8'): string;
    writeFileSync(p: string, data: string): void;
    renameSync(a: string, b: string): void;
    mkdirSync(p: string, opts: { recursive: boolean }): void;
    statSync(p: string, opts: { throwIfNoEntry: false }): { mtimeMs: number } | undefined;
    existsSync(p: string): boolean;
  };
  /** Directory holding calendar-feeds.txt + calendar.json (~/.cues or $OPENCUES_HOME). */
  readonly cuesDir: string;
  /** Fetch — defaults to ambient fetch. */
  readonly fetchImpl?: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readonly log?: (msg: string) => void;
  /** Event horizon (days ahead). */
  readonly windowDays?: number;
  /** Per-feed fetch timeout. */
  readonly timeoutMs?: number;
}

export interface CalendarSyncResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly feeds?: number;
  readonly okCount?: number;
  readonly events?: number;
}

export const CALENDAR_FEEDS_BASENAME = 'calendar-feeds.txt';
export const CALENDAR_SNAPSHOT_BASENAME = 'calendar.json';
/** Feed-refresh TTL — the scheduler treats the snapshot as due when its
 *  `ingestedAt` is older than this. */
export const CALENDAR_SYNC_TTL_MS = 15 * 60_000;
/** Upper bound on a single feed body we will parse. A real calendar export is
 *  well under this; a larger response is a misconfigured/compromised/MITM'd feed
 *  and is dropped rather than parsed (bounds memory + parse work on a
 *  pathological body). 5 MB ≈ tens of thousands of events. */
export const CALENDAR_FEED_MAX_CHARS = 5 * 1024 * 1024;

function joinPath(dir: string, base: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + base : `${dir}/${base}`;
}

/** Read active (non-comment) feed URLs; null when no feeds file exists. */
export function readCalendarFeedUrls(fs: CalendarSyncDeps['fs'], cuesDir: string): string[] | null {
  const p = joinPath(cuesDir, CALENDAR_FEEDS_BASENAME);
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  return raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

/** Parse the snapshot's ingestedAt (ms epoch); -1 when missing/unreadable. */
export function calendarSnapshotAgeAnchor(fs: CalendarSyncDeps['fs'], cuesDir: string): number {
  const p = joinPath(cuesDir, CALENDAR_SNAPSHOT_BASENAME);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { ingestedAt?: string };
    const t = parsed?.ingestedAt ? Date.parse(parsed.ingestedAt) : NaN;
    return Number.isFinite(t) ? t : -1;
  } catch { return -1; }
}

/** The scheduler's due-check: feeds configured AND snapshot missing or
 *  older than the TTL. Reading the shared file (not process memory) is
 *  what lets concurrent hosts self-deduplicate. */
export function calendarSyncDue(fs: CalendarSyncDeps['fs'], cuesDir: string, ttlMs: number = CALENDAR_SYNC_TTL_MS, now: number = Date.now()): boolean {
  const urls = readCalendarFeedUrls(fs, cuesDir);
  if (!urls || urls.length === 0) return false;
  const anchor = calendarSnapshotAgeAnchor(fs, cuesDir);
  return anchor < 0 || now - anchor >= ttlMs;
}

/** Fetch every feed → parse → dedupe → atomically write calendar.json.
 *  Never throws; failures keep the previous snapshot (the documented
 *  "last good" posture). */
export async function syncCalendarFeeds(deps: CalendarSyncDeps): Promise<CalendarSyncResult> {
  const { fs, cuesDir } = deps;
  const log = deps.log ?? (() => {});
  const fetchImpl = deps.fetchImpl
    ?? (typeof fetch !== 'undefined' ? (fetch as unknown as NonNullable<CalendarSyncDeps['fetchImpl']>) : undefined);
  if (!fetchImpl) return { ok: false, reason: 'no fetch available' };

  const urls = readCalendarFeedUrls(fs, cuesDir);
  if (!urls || urls.length === 0) return { ok: false, reason: 'no feeds' };

  const startedAt = Date.now();
  const windowDays = deps.windowDays ?? 60;
  const winStartMs = startedAt - 3600e3;
  const winEndMs = startedAt + windowDays * 24 * 3600e3;
  const timeoutMs = deps.timeoutMs ?? 15_000;

  const all: ReturnType<typeof parseIcs> = [];
  let okCount = 0;
  for (const url of urls) {
    try {
      const httpUrl = url.replace(/^webcal:\/\//i, 'https://');
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const to = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
      const res = await fetchImpl(httpUrl, { headers: { 'User-Agent': 'opencues-calendar-sync/1.0' }, redirect: 'follow', signal: ctl?.signal });
      if (to) clearTimeout(to);
      if (!res.ok) { log(`calendar-sync: HTTP ${res.status} — ${url.slice(0, 50)}`); continue; }
      const text = await res.text();
      if (text.length > CALENDAR_FEED_MAX_CHARS) { log(`calendar-sync: feed too large (${text.length} chars) — ${url.slice(0, 50)}`); continue; }
      if (!/BEGIN:VCALENDAR/i.test(text)) { log(`calendar-sync: not iCalendar — ${url.slice(0, 50)}`); continue; }
      all.push(...parseIcs(text, { windowStartMs: winStartMs, windowEndMs: winEndMs, maxEvents: 200 }));
      okCount++;
    } catch (e) {
      log(`calendar-sync: ${(e as Error)?.message ?? e} — ${url.slice(0, 50)}`);
    }
  }
  if (okCount === 0) return { ok: false, reason: 'all feeds failed — snapshot NOT overwritten', feeds: urls.length, okCount };

  const seen = new Set<string>();
  const events = all
    .filter(e => { const k = `${e.start}|${e.title}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 50);

  // Pre-write re-stat: if another producer refreshed while we fetched,
  // ours is the OLDER data — discard rather than clobber.
  const anchorNow = calendarSnapshotAgeAnchor(fs, cuesDir);
  if (anchorNow >= startedAt) {
    log('calendar-sync: another producer refreshed concurrently — discarding this fetch');
    return { ok: true, reason: 'superseded', feeds: urls.length, okCount, events: events.length };
  }

  const snapshotPath = joinPath(cuesDir, CALENDAR_SNAPSHOT_BASENAME);
  const tmpPath = `${snapshotPath}.tmp-${startedAt}`;
  fs.mkdirSync(cuesDir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify({ source: 'opencues calendar sync', ingestedAt: new Date().toISOString(), events }, null, 2) + '\n');
  fs.renameSync(tmpPath, snapshotPath);
  log(`calendar-sync: ${events.length} event(s) from ${okCount}/${urls.length} feed(s)`);
  return { ok: true, feeds: urls.length, okCount, events: events.length };
}
