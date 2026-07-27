// Apply RenderDirectives to a host's already-ANSI-rendered string.
//
// The renderer walks the input char-by-char, distinguishing visible characters
// from ANSI escape sequences (\x1b[...m). When the visible cursor reaches a
// directive boundary, the corresponding ANSI escape sequence is inserted before
// the next visible char. Existing ANSI codes are preserved verbatim.
//
// `textOverride` short-circuits — if present, it replaces the entire string.

import type { ColoredRange, Range, RenderDirectives } from './adapter';
import { ansiColorToOpenEscape, ANSI_FG_RESET } from './modules/blank-loading';

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
// Markdown render — terminal ANSI codes for bold / italic / inverse
// (code spans) / strikethrough / underline (headings). The 22/23/27/29/24
// closing codes specifically reset the matching attribute without
// touching colour. Bold close (`22`) doubles as "normal intensity"; this
// is the standard ANSI handling and matches how `tput` emits them.
const ANSI_BOLD_ON = '\x1b[1m';
const ANSI_BOLD_OFF = '\x1b[22m';
const ANSI_ITALIC_ON = '\x1b[3m';
const ANSI_ITALIC_OFF = '\x1b[23m';
const ANSI_CODE_ON = '\x1b[7m';        // inverse video for code spans
const ANSI_CODE_OFF = '\x1b[27m';
const ANSI_STRIKE_ON = '\x1b[9m';
const ANSI_STRIKE_OFF = '\x1b[29m';
// Headings get bold + underline so the first character of `# ` is
// visibly anchored even on terminals that handle bold subtly.
const ANSI_HEADING_ON = '\x1b[1;4m';
const ANSI_HEADING_OFF = '\x1b[22;24m';
// List items get a faint marker dim on the bullet itself; the body
// text reads as normal. Reuses the existing DIM codes — no new escape.

interface Insertion {
  visibleAt: number;
  ansi: string;
  /** Lower order applied first when ties — used to keep open-codes before close-codes. */
  order: number;
}

// Inline cue note — rendered as a dim (gray) bracketed pill on its own line
// below the buffer: `[⚠ - message]`. Display-only: the ANSI dim codes and the
// note text live in the rendered string the host PAINTS, never in the logical
// submit buffer (same channel as every other directive here). v1 placement is
// end-of-render on its own line; span-anchored placement is a follow-up.
//
// The advisory (def.cueTip) arrives as "<icon> <message>" (e.g.
// "⚠ the 19th is a Friday"); render it as "[<icon> - <message>]" so it reads
// as a distinct pill, matching the `[OpenCues: …]` inline-notification shape.
function renderInlineNote(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^(\S+)\s+([\s\S]*)$/);
  const body = m ? `${m[1]} - ${m[2]}` : trimmed;
  return '\n' + ANSI_DIM_ON + '[' + body + ']' + ANSI_DIM_OFF;
}

export function applyDirectives(rendered: string, directives: RenderDirectives | null | undefined): string {
  if (!directives) return rendered;
  if (directives.textOverride !== undefined) return directives.textOverride;

  const noteSuffix = directives.inlineNote && directives.inlineNote.text
    ? renderInlineNote(directives.inlineNote.text)
    : '';

  // Coalesce overlapping/adjacent dim ranges into a flat list of "dim on"
  // / "dim off" boundary points. Without this, a cue-word dim ([29,40])
  // sitting inside a consume-all dim ([0,130]) would emit DIM_OFF at 40
  // and leave chars 40..130 undimmed. The coalesce makes overlapping
  // ranges safe in general.
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
  // Markdown ranges — each independent set produces its own ANSI open
  // / close pair. Inner-style closes (close-orders later) fire BEFORE
  // outer-style closes by their position; ANSI's per-attribute close
  // codes mean overlapping styles compose cleanly (bold-italic both
  // active sees both opens, closes in either order).
  for (const r of coalesceRanges(directives.boldRanges ?? [])) {
    insertions.push({ visibleAt: r.start, ansi: ANSI_BOLD_ON, order: 0 });
    insertions.push({ visibleAt: r.end, ansi: ANSI_BOLD_OFF, order: 1 });
  }
  for (const r of coalesceRanges(directives.italicRanges ?? [])) {
    insertions.push({ visibleAt: r.start, ansi: ANSI_ITALIC_ON, order: 0 });
    insertions.push({ visibleAt: r.end, ansi: ANSI_ITALIC_OFF, order: 1 });
  }
  for (const r of coalesceRanges(directives.codeRanges ?? [])) {
    insertions.push({ visibleAt: r.start, ansi: ANSI_CODE_ON, order: 0 });
    insertions.push({ visibleAt: r.end, ansi: ANSI_CODE_OFF, order: 1 });
  }
  for (const r of coalesceRanges(directives.strikeRanges ?? [])) {
    insertions.push({ visibleAt: r.start, ansi: ANSI_STRIKE_ON, order: 0 });
    insertions.push({ visibleAt: r.end, ansi: ANSI_STRIKE_OFF, order: 1 });
  }
  for (const r of coalesceRanges(directives.headingRanges ?? [])) {
    insertions.push({ visibleAt: r.start, ansi: ANSI_HEADING_ON, order: 0 });
    insertions.push({ visibleAt: r.end, ansi: ANSI_HEADING_OFF, order: 1 });
  }
  for (const r of coalesceRanges(directives.listRanges ?? [])) {
    // List items get dim on the bullet marker only — the body reads
    // as normal text. Marker is the first non-whitespace run.
    insertions.push({ visibleAt: r.start, ansi: ANSI_DIM_ON, order: 0 });
    insertions.push({ visibleAt: r.end, ansi: ANSI_DIM_OFF, order: 1 });
  }
  // Per-range foreground colours (BlankLoadingAnimator emits these for
  // the current loading frame, keyed by colour list in OPENCUES.md).
  // Terminal hosts consume the `ansi` field; chrome consumes `rgb` via
  // its own pipeline (handled in the chrome adapter, not here).
  // Coloured ranges are NOT coalesced — each entry may have its own
  // colour, so merging would lose information. Overlap is the caller's
  // responsibility; in practice the animator emits one range per active
  // slot so overlap is impossible.
  for (const cr of (directives.coloredRanges ?? []) as readonly ColoredRange[]) {
    if (cr.start >= cr.end) continue;
    if (!cr.ansi) continue;
    const open = ansiColorToOpenEscape(cr.ansi);
    if (!open) continue;
    insertions.push({ visibleAt: cr.start, ansi: open, order: 0 });
    insertions.push({ visibleAt: cr.end, ansi: ANSI_FG_RESET, order: 1 });
  }
  if (insertions.length === 0) return rendered + noteSuffix;

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
  return result + noteSuffix;
}
