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
import { codeUnitsToCells } from './util/cell-width';

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

// Inline cue note — dim (gray) text `⚠ - message` placed on the line DIRECTLY
// BELOW the flagged span, indented to the span's column (not below the whole
// buffer — that drifts far from the span in a long doc). Display-only: the
// text + its ANSI live in the rendered string the host PAINTS, never in the
// logical submit buffer (same channel as every other directive here).
//
// Connector glyph that ties the note to the span above it.
const INLINE_NOTE_CONNECTOR = '↳';

// The advisory (def.cueTip) arrives as "<icon> <message>" (e.g.
// "⚠ the 19th is a Friday"); render it as "<icon> - <message>", led by the
// `↳` connector at the painter.
function formatInlineNoteText(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^(\S+)\s+([\s\S]*)$/);
  return m ? `${m[1]} - ${m[2]}` : trimmed;
}

/**
 * The full inline-note display string — connector + formatted advisory, e.g.
 * "↳ ⚠ - the 19th is a Friday". Exported so NON-terminal hosts (chrome's
 * span-anchored overlay) paint the SAME text the terminal painter splices in,
 * instead of re-deriving it and drifting. Terminal-side ANSI/indent is layered
 * on separately in applyDirectives; this is the plain text only.
 */
export function inlineNoteDisplayText(cueTip: string): string {
  return INLINE_NOTE_CONNECTOR + ' ' + formatInlineNoteText(cueTip);
}

/**
 * @param firstLineIndent Screen columns the host prepends to the buffer's
 *   FIRST line but NOT to continuation lines (e.g. Claude Code's `❯ ` input
 *   prompt). An inline note is always injected as a continuation line, so a
 *   first-line span sits this many columns further right on screen than its
 *   buffer column — added back so the note stays under the span. Hosts with a
 *   uniform left margin pass 0 (the default).
 */
export function applyDirectives(
  rendered: string,
  directives: RenderDirectives | null | undefined,
  firstLineIndent = 0,
): string {
  if (!directives) return rendered;
  if (directives.textOverride !== undefined) return directives.textOverride;

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
  // Inline cue note — insert as a new indented line right after the visible
  // line that contains the flagged span (span coords are in the same visible
  // space as `rendered`). Placing it here rather than appending at the very
  // end keeps the pill next to the span even in a long buffer. NOTE: this adds
  // visible characters mid-string, so any LATER render handler's ranges (this
  // fn is called once per handler) computed past the insertion point would
  // shift — in practice only DimRender emits inlineNote and it carries its own
  // dim/highlight in the same call, where all insertions are indexed against
  // the same original `rendered`, so its own ranges are unaffected.
  if (directives.inlineNote && directives.inlineNote.text) {
    const note = directives.inlineNote;
    const visible = rendered.replace(/\x1b\[[0-9;]*m/g, '');
    const spanEnd = Math.min(Math.max(0, note.spanEnd), visible.length);
    const spanStart = Math.min(Math.max(0, note.spanStart), visible.length);
    const nl = visible.indexOf('\n', spanEnd);
    const at = nl === -1 ? visible.length : nl;
    const lineStart = visible.lastIndexOf('\n', Math.max(0, spanStart - 1)) + 1;
    // Column = VISUAL cells of the line's prefix, NOT code-point count. CJK /
    // wide glyphs are double-width, so a code-point pad lands the note only
    // halfway under a span preceded by Japanese etc. (the "spans misalign on
    // Japanese" bug). Measure in terminal cells so the note tracks the span.
    const lineText = visible.slice(lineStart, spanStart);
    const col = codeUnitsToCells(lineText, lineText.length);
    // The `↳ ` connector points up at the span; the MESSAGE aligns under the
    // span's column, with the arrow hanging in the margin to its left.
    const prefix = INLINE_NOTE_CONNECTOR + ' ';
    const prefixCells = codeUnitsToCells(prefix, prefix.length);
    // First-line span → add back the host prompt indent the note line (a
    // continuation line) doesn't inherit. lineStart === 0 ⟺ span on line 1.
    const promptPad = lineStart === 0 ? Math.max(0, firstLineIndent) : 0;
    // Message target column = col + promptPad; the connector hangs prefixCells
    // to its left. Fold both into ONE clamp so a span at (or near) column 0
    // yields no leading indent — the arrow just sits at the left edge — instead
    // of being pushed right by the prompt pad.
    const pad = ' '.repeat(Math.max(0, col + promptPad - prefixCells));
    const body = ANSI_DIM_ON + prefix + formatInlineNoteText(note.text) + ANSI_DIM_OFF;
    // order 2 → fires after any dim/highlight close-codes at this boundary.
    insertions.push({ visibleAt: at, ansi: '\n' + pad + body, order: 2 });
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
