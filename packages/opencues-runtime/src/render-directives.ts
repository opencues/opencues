// Apply RenderDirectives to a host's already-ANSI-rendered string.
//
// The renderer walks the input char-by-char, distinguishing visible characters
// from ANSI escape sequences (\x1b[...m). When the visible cursor reaches a
// directive boundary, the corresponding ANSI control code is inserted before
// the next visible char. Existing ANSI codes are preserved verbatim.
//
// `textOverride` short-circuits — if present, it replaces the entire string.

import type { Range, RenderDirectives } from './adapter';

/**
 * Sort + merge overlapping or touching ranges. Empty ranges (start >= end)
 * are dropped. The result is non-overlapping in increasing visibleAt order.
 */
interface MutRange { start: number; end: number }

function coalesceRanges(input: readonly Range[]): MutRange[] {
  if (input.length === 0) return [];
  const sorted = input.filter(r => r.start < r.end).slice().sort((a, b) => a.start - b.start);
  const out: MutRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

// Highlight = bright white foreground (not inverse video — inverse on
// some terminals washes out the dim layer underneath, and the user
// prefers "dim everything else, active is bright"). Reset = default fg.
const ANSI_INVERSE_ON = '\x1b[97m';
const ANSI_INVERSE_OFF = '\x1b[39m';
const ANSI_DIM_ON = '\x1b[2m';
const ANSI_DIM_OFF = '\x1b[22m';

interface Insertion {
  visibleAt: number;
  ansi: string;
  /** Lower order applied first when ties — used to keep open-codes before close-codes. */
  order: number;
}

export function applyDirectives(rendered: string, directives: RenderDirectives | null | undefined): string {
  if (!directives) return rendered;
  if (directives.textOverride !== undefined) return directives.textOverride;

  // Coalesce overlapping/adjacent dim ranges into a flat list of "dim on"
  // / "dim off" boundary points. Without this, a cue-word dim ([29,40])
  // sitting inside a consume-all dim ([0,130]) would emit DIM_OFF at 40
  // and leave chars 40..130 undimmed. Step 32 surfaced this; the coalesce
  // makes overlapping ranges safe in general.
  const dimBoundaries = coalesceRanges(directives.dimRanges ?? []);

  const insertions: Insertion[] = [];
  if (directives.highlight) {
    insertions.push({ visibleAt: directives.highlight.start, ansi: ANSI_INVERSE_ON, order: 0 });
    insertions.push({ visibleAt: directives.highlight.end, ansi: ANSI_INVERSE_OFF, order: 1 });
  }
  for (const r of dimBoundaries) {
    insertions.push({ visibleAt: r.start, ansi: ANSI_DIM_ON, order: 0 });
    insertions.push({ visibleAt: r.end, ansi: ANSI_DIM_OFF, order: 1 });
  }
  if (insertions.length === 0) return rendered;

  insertions.sort((a, b) => a.visibleAt - b.visibleAt || a.order - b.order);

  let result = '';
  let visibleIdx = 0;
  let i = 0;
  let nextIns = 0;

  const flush = (): void => {
    while (nextIns < insertions.length && insertions[nextIns].visibleAt <= visibleIdx) {
      result += insertions[nextIns].ansi;
      nextIns += 1;
    }
  };

  while (i < rendered.length) {
    flush();
    if (rendered.charCodeAt(i) === 0x1b && rendered.charAt(i + 1) === '[') {
      const tail = rendered.slice(i, i + 32);
      const m = tail.match(/^\x1b\[[0-9;]*m/);
      if (m) {
        result += m[0];
        i += m[0].length;
        continue;
      }
    }
    result += rendered.charAt(i);
    visibleIdx += 1;
    i += 1;
  }
  // Trailing flush — emit any remaining insertions (e.g. highlight.end past
  // the visible length, or empty ranges past the end). Insertions whose
  // visibleAt overshoots text are still emitted so close-codes always fire.
  while (nextIns < insertions.length) {
    result += insertions[nextIns].ansi;
    nextIns += 1;
  }
  return result;
}
