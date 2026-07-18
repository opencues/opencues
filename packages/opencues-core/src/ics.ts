/**
 * iCalendar (.ics / webcal) parser → life-context event shape.
 *
 * The FIRST real life-context producer (docs/architecture/life-context.md
 * Phase 1b). An `.ics` feed is the near-universal calendar export — Luma,
 * Google, Outlook/M365, Apple iCloud, Fastmail, Meetup, university timetables,
 * etc. all publish one — so a single parser makes almost any calendar a
 * drop-in producer. This module is PURE (no network): the host poller fetches
 * the feed text and hands it here.
 *
 * Output events match `buildLifeContextSnapshot`'s input: `{ title, start,
 * end, allDay?, location? }` with start/end as LOCAL wall-clock ISO
 * `YYYY-MM-DDTHH:MM` (the shape the minute-of-day math + "today" anchor use).
 *
 * Coverage: VEVENT SUMMARY/DTSTART/DTEND/DURATION/LOCATION/RRULE. Times in UTC
 * (`…Z` — what Luma emits), a named zone (`TZID=…`, via Intl), floating
 * (as-is), or all-day (`VALUE=DATE`). Recurrence: DAILY + WEEKLY (INTERVAL,
 * COUNT, UNTIL, BYDAY) expanded within a window; other FREQs fall back to the
 * master instance. See ics.test.ts.
 */

export interface IcsEvent {
  readonly title: string;
  readonly start: string;   // YYYY-MM-DDTHH:MM (local wall-clock)
  readonly end: string;     // YYYY-MM-DDTHH:MM
  readonly allDay?: boolean;
  readonly location?: string;
}

export interface ParseIcsOptions {
  /** Only keep events overlapping [windowStart, windowEnd] (ms epoch). When
   *  omitted, all events are kept and recurrences expand for ~60 days from the
   *  earliest DTSTART. */
  windowStartMs?: number;
  windowEndMs?: number;
  /** Hard cap on total events returned (safety against a pathological feed). */
  maxEvents?: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Unfold RFC-5545 folded lines: a line beginning with a space or tab is a
 *  continuation of the previous line. Handles CRLF and LF. */
function unfold(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Unescape iCalendar TEXT: `\n`→newline (rendered as space), `\,` `\;` `\\`. */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** Split a property line into { name, params, value }. Name+params are before
 *  the first `:`; the value (which may itself contain `:`) is the remainder. */
function splitProp(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = head.split(';');
  const name = segs[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf('=');
    if (eq > 0) params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1);
  }
  return { name, params, value };
}

interface WallTime { y: number; mo: number; d: number; h: number; mi: number; isDate: boolean; }

/** Parse an iCal date/date-time VALUE + its params into an absolute local
 *  wall-clock. Returns null on unparseable input. */
function parseDtValue(value: string, params: Record<string, string>): WallTime | null {
  const isDate = params.VALUE === 'DATE' || /^\d{8}$/.test(value.trim());
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, s = m[6] ? +m[6] : 0;
  const isUtc = m[7] === 'Z';
  if (isDate || !m[4]) return { y, mo, d, h: 0, mi: 0, isDate: true };

  // Resolve to a UTC instant, then re-express in the runtime's LOCAL wall-clock
  // (the daemon's TZ = the user's TZ).
  let instantMs: number;
  if (isUtc) {
    instantMs = Date.UTC(y, mo - 1, d, h, mi, s);
  } else if (params.TZID) {
    instantMs = zonedWallToUtc(y, mo, d, h, mi, s, params.TZID);
  } else {
    // Floating time — interpret in local zone directly (no conversion).
    return { y, mo, d, h, mi, isDate: false };
  }
  const local = new Date(instantMs);
  return { y: local.getFullYear(), mo: local.getMonth() + 1, d: local.getDate(), h: local.getHours(), mi: local.getMinutes(), isDate: false };
}

/** Wall-time in a named zone → UTC epoch ms (two-pass for DST-boundary
 *  correctness). Falls back to treating it as UTC if the zone is unknown. */
function zonedWallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const off1 = zoneOffsetMs(guess, tzid);
    const off2 = zoneOffsetMs(guess - off1, tzid);
    return guess - off2;
  } catch {
    return guess;
  }
}

/** Offset (ms) of `tzid` at a given UTC instant: localWall(tzid) - utc. */
function zoneOffsetMs(instantMs: number, tzid: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = dtf.formatToParts(new Date(instantMs));
  const g: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = +p.value;
  const asIfUtc = Date.UTC(g.year, g.month - 1, g.day, g.hour === 24 ? 0 : g.hour, g.minute, g.second);
  return asIfUtc - instantMs;
}

const iso = (w: WallTime): string =>
  w.isDate ? `${w.y}-${pad2(w.mo)}-${pad2(w.d)}T00:00`
    : `${w.y}-${pad2(w.mo)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}`;

const wallToMs = (w: WallTime): number => new Date(w.y, w.mo - 1, w.d, w.h, w.mi).getTime();

/** Parse an ISO duration (e.g. PT1H30M, P1D) into ms. */
function parseDurationMs(dur: string): number {
  const m = dur.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, w, d, h, mi, s] = m.map(x => (x ? +x : 0));
  return ((w * 7 + d) * 24 * 3600 + h * 3600 + mi * 60 + s) * 1000;
}

interface RawEvent {
  summary?: string;
  location?: string;
  dtStart?: WallTime;
  dtEnd?: WallTime;
  durationMs?: number;
  rrule?: string;
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Parse iCalendar text into life-context events (local wall-clock).
 * Never throws on malformed content — unparseable VEVENTs are skipped.
 */
export function parseIcs(text: string, opts: ParseIcsOptions = {}): IcsEvent[] {
  const lines = unfold(text);
  const raws: RawEvent[] = [];
  let cur: RawEvent | null = null;

  for (const line of lines) {
    const up = line.toUpperCase();
    if (up === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (up === 'END:VEVENT') { if (cur) raws.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = splitProp(line);
    if (!p) continue;
    switch (p.name) {
      case 'SUMMARY': cur.summary = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'DTSTART': cur.dtStart = parseDtValue(p.value, p.params) ?? undefined; break;
      case 'DTEND': cur.dtEnd = parseDtValue(p.value, p.params) ?? undefined; break;
      case 'DURATION': cur.durationMs = parseDurationMs(p.value.trim()); break;
      case 'RRULE': cur.rrule = p.value.trim(); break;
      default: break;
    }
  }

  const events: IcsEvent[] = [];
  const maxEvents = opts.maxEvents ?? 500;
  const winStart = opts.windowStartMs;
  const winEnd = opts.windowEndMs;

  const push = (startW: WallTime, endW: WallTime, title: string, location: string | undefined, allDay: boolean): boolean => {
    if (events.length >= maxEvents) return false;
    const sMs = wallToMs(startW);
    const eMs = wallToMs(endW);
    if (winStart !== undefined && eMs < winStart) return true;   // ended before window — skip, keep scanning
    if (winEnd !== undefined && sMs > winEnd) return true;       // starts after window — skip
    events.push({ title, start: iso(startW), end: iso(endW), ...(allDay ? { allDay: true } : {}), ...(location ? { location } : {}) });
    return true;
  };

  for (const r of raws) {
    if (!r.summary || !r.dtStart) continue;
    const allDay = !!r.dtStart.isDate;
    // Derive end: DTEND, else DTSTART+DURATION, else same as start (allDay → end of day).
    let end: WallTime;
    if (r.dtEnd) {
      end = r.dtEnd;
      if (allDay) end = endOfDay(shiftDays(end, -1)); // iCal all-day DTEND is exclusive
    } else if (r.durationMs) {
      end = msToWall(wallToMs(r.dtStart) + r.durationMs);
    } else {
      end = allDay ? endOfDay(r.dtStart) : r.dtStart;
    }
    const start = allDay ? { ...r.dtStart, h: 0, mi: 0 } : r.dtStart;

    if (!r.rrule) { if (!push(start, end, r.summary, r.location, allDay)) break; continue; }

    // Recurrence — expand within the window.
    const durMs = wallToMs(end) - wallToMs(start);
    const occurrences = expandRrule(start, r.rrule, winStart, winEnd);
    for (const occ of occurrences) {
      const occEnd = msToWall(wallToMs(occ) + durMs);
      if (!push(occ, occEnd, r.summary, r.location, allDay)) break;
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}

function msToWall(ms: number): WallTime {
  const d = new Date(ms);
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), isDate: false };
}
function shiftDays(w: WallTime, n: number): WallTime {
  const d = new Date(w.y, w.mo - 1, w.d + n, w.h, w.mi);
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: w.h, mi: w.mi, isDate: w.isDate };
}
function endOfDay(w: WallTime): WallTime { return { ...w, h: 23, mi: 59, isDate: false }; }

/**
 * Expand a DAILY/WEEKLY RRULE into occurrence start times within the window.
 * INTERVAL, COUNT, UNTIL, BYDAY (weekly) honoured. Other FREQs → master only.
 * Capped at 366 occurrences.
 */
function expandRrule(start: WallTime, rrule: string, winStartMs?: number, winEndMs?: number): WallTime[] {
  const parts: Record<string, string> = {};
  for (const kv of rrule.split(';')) { const eq = kv.indexOf('='); if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1); }
  const freq = (parts.FREQ ?? '').toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return [start]; // fallback: master instance only
  const interval = Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1);
  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : undefined;
  const untilMs = parts.UNTIL ? untilToMs(parts.UNTIL) : undefined;
  const byDay = parts.BYDAY ? parts.BYDAY.split(',').map(c => WEEKDAY_CODES.indexOf(c.trim().toUpperCase().slice(-2))).filter(i => i >= 0) : null;

  const endBoundMs = Math.min(
    winEndMs ?? Date.UTC(start.y + 1, start.mo - 1, start.d), // default ~1yr
    untilMs ?? Number.MAX_SAFE_INTEGER,
  );
  const out: WallTime[] = [];
  const startMs = wallToMs(start);
  const CAP = 366;
  let emitted = 0;

  const consider = (w: WallTime): boolean => {
    const ms = wallToMs(w);
    if (untilMs !== undefined && ms > untilMs) return false;
    if (count !== undefined && emitted >= count) return false;
    emitted++; // COUNT counts every generated occurrence, even pre-window
    if (winStartMs !== undefined && ms < winStartMs) return true;
    if (ms > endBoundMs && (winEndMs === undefined || ms > winEndMs)) return false;
    out.push(w);
    return true;
  };

  if (freq === 'DAILY') {
    for (let i = 0; i < CAP; i++) {
      const w = { ...shiftDays(start, i * interval), h: start.h, mi: start.mi };
      if (!consider(w)) break;
      if (wallToMs(w) > endBoundMs) break;
    }
  } else { // WEEKLY
    const days = byDay && byDay.length ? byDay : [new Date(startMs).getDay()];
    for (let wk = 0; wk < CAP; wk++) {
      const weekBase = shiftDays(start, wk * interval * 7);
      // Move to Sunday of that week, then emit each BYDAY.
      const baseDow = new Date(wallToMs(weekBase)).getDay();
      let stop = false;
      for (const dow of days.slice().sort((a, b) => a - b)) {
        const occ = { ...shiftDays(weekBase, dow - baseDow), h: start.h, mi: start.mi };
        if (wallToMs(occ) < startMs) continue; // skip days before the series start in week 0
        if (!consider(occ)) { stop = true; break; }
      }
      if (stop) break;
      if (wallToMs(weekBase) > endBoundMs) break;
    }
  }
  out.sort((a, b) => wallToMs(a) - wallToMs(b));
  return out;
}

function untilToMs(until: string): number {
  const m = until.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  // UNTIL is UTC; compare against local wall ms is approximate but fine at day granularity.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, 0));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).getTime();
}
