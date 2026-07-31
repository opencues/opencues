// Deterministic temporal algebra over resolved "when" fields.
// Grammar: "YYYY-MM-DD" | "YYYY-MM-DD AM|PM|EVE" | "YYYY-MM-DD HH:MM"
//        | "YYYY-MM-DD/YYYY-MM-DD"
// Policy (precision-first): a collision must be ESTABLISHED, never
// inferred. Multi-day spans (presence) cover all parts of their days;
// single-day entries with unknown part of day collide with nothing
// sub-day (unknown x anything-not-ALL -> no collision).

const partOf = (tok) => {
  if (tok === 'AM' || tok === 'PM' || tok === 'EVE') return tok;
  if (!tok) return 'UNKNOWN';
  const h = Number(tok.slice(0, 2));
  return h < 12 ? 'AM' : h < 17 ? 'PM' : 'EVE';
};
const WDNAME = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const weekdayOf = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();

export function parseWhen(str) {
  if (!str) return null;
  // Recurring pattern: "WEEKLY:mon,wed 18:00" | "WEEKLY:daily eve"
  const wk = str.match(/^WEEKLY:([a-z,]+)(?:\s+(AM|PM|EVE|\d{2}:\d{2}))?$/i);
  if (wk) {
    const days = wk[1].toLowerCase() === 'daily'
      ? new Set([0, 1, 2, 3, 4, 5, 6])
      : new Set(wk[1].toLowerCase().split(',').map(d => WDNAME[d]).filter(d => d !== undefined));
    return days.size ? { weekly: days, part: partOf(wk[2]) } : null;
  }
  const range = str.match(/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
  if (range) return { start: range[1], end: range[2], part: 'ALL' };
  const m = str.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(AM|PM|EVE|\d{2}:\d{2}))?$/);
  if (!m) return null;
  return { start: m[1], end: m[1], part: partOf(m[2]) };
}

const partsCollide = (a, b) => {
  if (a === 'ALL' || b === 'ALL') return true;
  if (a === 'UNKNOWN' || b === 'UNKNOWN') return false;
  return a === b;
};
// Does a dated entry hit any occurrence of a weekly pattern?
function datedHitsWeekly(dated, weekly) {
  const days = spanDays(dated);
  if (days === null) return true; // span ≥ 7 days covers every weekday
  return days.some(d => weekly.weekly.has(weekdayOf(d)));
}
function spanDays(w) {
  const out = [];
  let d = new Date(w.start + 'T00:00:00Z');
  const end = new Date(w.end + 'T00:00:00Z');
  if ((end - d) / 86400000 >= 7) return null;
  for (; d <= end; d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

export function overlaps(a, b) {
  if (!a || !b) return false;
  if (a.weekly && b.weekly) {
    if (![...a.weekly].some(d => b.weekly.has(d))) return false;
    return partsCollide(a.part, b.part);
  }
  if (a.weekly || b.weekly) {
    const [wk, dated] = a.weekly ? [a, b] : [b, a];
    if (!datedHitsWeekly(dated, wk)) return false;
    return partsCollide(wk.part, dated.part);
  }
  if (a.start > b.end || b.start > a.end) return false; // ISO strings compare
  return partsCollide(a.part, b.part);
}

// Open commitments whose whole window is before `now` (date compare).
// Weekly patterns never go overdue.
export function isOverdue(when, nowIso) {
  const w = parseWhen(when);
  return !!w && !w.weekly && w.end < nowIso.slice(0, 10);
}

// ── Deterministic deixis ──────────────────────────────────────────
// The model never does calendar arithmetic. It emits a RELATIVE
// reference (whenRef) in a tiny vocabulary; the runtime resolves it
// against the utterance timestamp with real date arithmetic.
// Vocabulary:
//   day:  "today" | "tonight" | "tomorrow" | "mon".."sun" (next
//         strictly-future occurrence) | "day <1-31>" (next occurrence
//         of that day-of-month) | "YYYY-MM-DD"
//         — optionally followed by " am" | " pm" | " eve" | " HH:MM"
//   span: "<day> .. <day>" | "until <day>" | "this month"
const WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const fmt = (d) => d.toISOString().slice(0, 10);

function splitPart(tok) {
  tok = tok.trim().toLowerCase();
  let part = null;
  const pm = tok.match(/\s+(am|pm|eve|\d{1,2}:\d{2})$/);
  if (pm) { part = pm[1]; tok = tok.slice(0, pm.index).trim(); }
  if (tok === 'tonight') { tok = 'today'; part = part ?? 'eve'; }
  return { tok, part };
}

function resolveDayTok(tok, base) {
  if (tok === 'today') return base;
  if (tok === 'tomorrow') return addDays(base, 1);
  if (tok === 'yesterday') return addDays(base, -1);
  const last = tok.match(/^last (\w+)$/);
  if (last && WD[last[1]] !== undefined) {
    let d = addDays(base, -1);
    while (d.getUTCDay() !== WD[last[1]]) d = addDays(d, -1);
    return d;
  }
  if (WD[tok] !== undefined) {
    let d = addDays(base, 1);
    while (d.getUTCDay() !== WD[tok]) d = addDays(d, 1);
    return d;
  }
  const m = tok.match(/^day (\d{1,2})$/);
  if (m) {
    let d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Number(m[1])));
    if (d < base) d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, Number(m[1])));
    return d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) return new Date(tok + 'T00:00:00Z');
  return null;
}

export function resolveWhenRef(ref, tsIso) {
  if (!ref || !tsIso) return null;
  const base = new Date(tsIso.slice(0, 10) + 'T00:00:00Z');
  ref = String(ref).trim().toLowerCase();
  // Recurring: "weekly mon,wed 18:00" | "daily [part]" — a pattern,
  // not a date; no resolution against the timestamp needed.
  const wk = ref.match(/^(?:every|weekly)\s+([a-z, +]+?)(\s+(?:am|pm|eve|\d{1,2}:\d{2}))?$/)
    ?? (ref.match(/^daily(\s+(?:am|pm|eve|\d{1,2}:\d{2}))?$/) ? ['', 'daily', ref.match(/^daily(.*)$/)[1]] : null);
  if (wk) {
    const days = wk[1].trim() === 'daily' ? 'daily'
      : wk[1].split(/[,+]/).map(s => s.trim()).filter(s => WDNAME[s] !== undefined).join(',');
    if (!days) return null;
    const part = (wk[2] ?? '').trim();
    const suffix = !part ? '' : part === 'am' ? ' AM' : part === 'pm' ? ' PM' : part === 'eve' ? ' EVE' : ' ' + part.padStart(5, '0');
    return `WEEKLY:${days}${suffix}`;
  }
  if (ref === 'this month') {
    const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    return `${fmt(base)}/${fmt(end)}`;
  }
  const until = ref.match(/^until (.+)$/);
  if (until) {
    const d = resolveDayTok(splitPart(until[1]).tok, base);
    return d ? `${fmt(base)}/${fmt(d)}` : null;
  }
  const from = ref.match(/^from (.+)$/);
  if (from) {
    const d = resolveDayTok(splitPart(from[1]).tok, base);
    return d ? `${fmt(d)}/2099-12-31` : null; // open-ended span
  }
  const span = ref.split('..');
  if (span.length === 2) {
    const a = resolveDayTok(splitPart(span[0]).tok, base);
    const b = a && resolveDayTok(splitPart(span[1]).tok, a);
    return a && b ? `${fmt(a)}/${fmt(b)}` : null;
  }
  const { tok, part } = splitPart(ref);
  const d = resolveDayTok(tok, base);
  if (!d) return null;
  const suffix = !part ? ''
    : part === 'am' ? ' AM' : part === 'pm' ? ' PM' : part === 'eve' ? ' EVE'
    : ' ' + part.padStart(5, '0');
  return fmt(d) + suffix;
}

// Is `nowIso` inside a SLOT-LIKE `when`? Slot-like = single day with a
// known part of day (a booked appointment/session). Policy spans and
// date-only entries are excluded: a month-long diet or an unknown-time
// commitment is not a place the user is supposed to BE right now.
export function containsPoint(when, nowIso) {
  const w = parseWhen(when);
  if (!w) return false;
  const h = Number(nowIso.slice(11, 13));
  const nowPart = h < 12 ? 'AM' : h < 17 ? 'PM' : 'EVE';
  if (w.weekly) {
    // A recurring slot with a known part counts (weekly class, shift).
    if (w.part === 'ALL' || w.part === 'UNKNOWN') return false;
    return w.weekly.has(weekdayOf(nowIso.slice(0, 10))) && w.part === nowPart;
  }
  if (w.start !== w.end || w.part === 'ALL' || w.part === 'UNKNOWN') return false;
  if (nowIso.slice(0, 10) !== w.start) return false;
  return nowPart === w.part;
}
