// Pure logic for the universal AX daemon — unit-testable without the
// bridge. Offsets everywhere are UTF-16 code units (JS string indexing
// and the AX API agree on this).

/** Single contiguous replacement turning `oldText` into `newText`, or
 *  null when identical. Computed prefix/suffix-first so an animation
 *  frame or a blank fill becomes ONE small AX replace instead of a
 *  whole-value rewrite (which would nuke cursor + formatting). */
export interface Replacement { start: number; length: number; text: string }

export function utf16Diff(oldText: string, newText: string): Replacement | null {
  if (oldText === newText) return null;
  let p = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (p < minLen && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < minLen - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  ) s++;
  return { start: p, length: oldText.length - p - s, text: newText.slice(p, newText.length - s) };
}

/** Standalone-`_` detection at the caret: the char just typed is a
 *  blank marker if it sits at `cursor-1`, is preceded by start-of-text /
 *  whitespace, followed by end / whitespace / closing punctuation, and
 *  was NOT already there (marker count must have grown vs prevText —
 *  cursor moves over an existing `_` must not re-arm). Returns the
 *  marker index or null. */
export function freshMarkerAtCursor(text: string, cursor: number, prevText: string): number | null {
  const idx = cursor - 1;
  if (idx < 0 || text[idx] !== '_') return null;
  const before = idx === 0 ? '' : text[idx - 1];
  if (before !== '' && !/\s/.test(before)) return null;
  const after = idx + 1 < text.length ? text[idx + 1] : '';
  if (after !== '' && !/[\s.,;:!?)\]]/.test(after)) return null;
  if (countMarkers(text) <= countMarkers(prevText)) return null;
  return idx;
}

const MARKER_RE = /(^|\s)_(?=$|[\s.,;:!?)\]])/gm;

export function countMarkers(text: string): number {
  MARKER_RE.lastIndex = 0;
  let n = 0;
  while (MARKER_RE.exec(text) !== null) n++;
  return n;
}

/** Per-bundle soft answer-length budgets: fields with a small VISIBLE
 *  capacity get a "keep it under ~N chars" instruction in the LLM
 *  prompt (never a truncation). Spotlight's search field shows ~37
 *  characters (measured 2026-07-21). Override / extend / disable via
 *  OPENCUES_AX_CHAR_BUDGET="com.apple.Spotlight=50,other.bundle=40"
 *  (a value < 1 removes the entry). */
export const DEFAULT_CHAR_BUDGETS: Readonly<Record<string, number>> = {
  'com.apple.Spotlight': 37,
};

export function charBudgetForBundle(bundle: string, env?: string): number | null {
  const map: Record<string, number> = { ...DEFAULT_CHAR_BUDGETS };
  for (const pair of (env ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const b = pair.slice(0, eq).trim();
    const n = parseInt(pair.slice(eq + 1).trim(), 10);
    if (!b || Number.isNaN(n)) continue;
    if (n < 1) delete map[b];
    else map[b] = n;
  }
  return map[bundle] ?? null;
}

/** Recent-writes echo ring: the daemon's own AX writes come back as
 *  AXValueChanged like any user edit; a change matching one of the
 *  last few written values is our echo, everything else is the
 *  user's. Cleared the moment a user edit wins (their buffer now). */
export class WriteRing {
  private ring: string[] = [];
  constructor(private readonly cap = 8) {}
  record(text: string): void {
    this.ring = this.ring.filter(t => t !== text);
    this.ring.push(text);
    while (this.ring.length > this.cap) this.ring.shift();
  }
  isEcho(text: string): boolean {
    return this.ring.includes(text);
  }
  clear(): void {
    this.ring = [];
  }
}
