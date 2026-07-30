// Deterministic temporal algebra over resolved "when" fields.
// Grammar: "YYYY-MM-DD" | "YYYY-MM-DD AM|PM|EVE" | "YYYY-MM-DD HH:MM"
//        | "YYYY-MM-DD/YYYY-MM-DD"
// Policy (precision-first): a collision must be ESTABLISHED, never
// inferred. Multi-day spans (presence) cover all parts of their days;
// single-day entries with unknown part of day collide with nothing
// sub-day (unknown x anything-not-ALL -> no collision).

export function parseWhen(str) {
  if (!str) return null;
  const range = str.match(/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/);
  if (range) return { start: range[1], end: range[2], part: 'ALL' };
  const m = str.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(AM|PM|EVE|\d{2}:\d{2}))?$/);
  if (!m) return null;
  let part = 'UNKNOWN';
  if (m[2] === 'AM' || m[2] === 'PM' || m[2] === 'EVE') part = m[2];
  else if (m[2]) {
    const h = Number(m[2].slice(0, 2));
    part = h < 12 ? 'AM' : h < 17 ? 'PM' : 'EVE';
  }
  return { start: m[1], end: m[1], part };
}

export function overlaps(a, b) {
  if (!a || !b) return false;
  if (a.start > b.end || b.start > a.end) return false; // ISO strings compare
  if (a.part === 'ALL' || b.part === 'ALL') return true;
  if (a.part === 'UNKNOWN' || b.part === 'UNKNOWN') return false;
  return a.part === b.part;
}

// Open commitments whose whole window is before `now` (date compare).
export function isOverdue(when, nowIso) {
  const w = parseWhen(when);
  return !!w && w.end < nowIso.slice(0, 10);
}

// Is `nowIso` inside a SLOT-LIKE `when`? Slot-like = single day with a
// known part of day (a booked appointment/session). Policy spans and
// date-only entries are excluded: a month-long diet or an unknown-time
// commitment is not a place the user is supposed to BE right now.
export function containsPoint(when, nowIso) {
  const w = parseWhen(when);
  if (!w || w.start !== w.end || w.part === 'ALL' || w.part === 'UNKNOWN') return false;
  const date = nowIso.slice(0, 10);
  if (date !== w.start) return false;
  const h = Number(nowIso.slice(11, 13));
  const part = h < 12 ? 'AM' : h < 17 ? 'PM' : 'EVE';
  return part === w.part;
}
