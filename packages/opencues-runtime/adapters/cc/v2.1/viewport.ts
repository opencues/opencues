// CC input-zone VIEWPORT translation.
//
// CC renders tall buffers through a scrolled viewport: the string the S3
// seam hands `applyRender` is only the VISIBLE lines, while DynDef spans,
// highlight state and cue spans are all in FULL-buffer coordinates. Before
// Sep 2026 the render ctx was built from the slice, so any span outside a
// scrolled viewport failed DimRender's stale-def guard (`defSpanLive`) and
// silently lost its dim / inline note / highlight — first reported as
// "`draft email _` doesn't go grey" (the multi-line email rewrite is taller
// than the input zone; reproduced identically on 2.1.206 and 2.1.236, so a
// runtime bug, not a host-version one).
//
// The fix: locate the slice inside the full buffer, hand handlers the FULL
// text (spans validate again), then translate every directive range back
// into slice coordinates before painting. When the slice can't be located
// (CC soft-wrap inserts characters, or the buffer mutated mid-render) we
// fall back to the pre-fix behaviour byte-for-byte — never guess offsets.
//
// Both functions are pure; coordinates are in the ZWS-stripped visible
// space on both sides (the same space handlers have always emitted in).

import type { RenderDirectives, Range, ColoredRange, HighlightRange, InlineNote } from '../../../src/adapter';

export interface ViewportMatch {
  /** Slice start within the full text (visible coords). */
  readonly offset: number;
  /** Slice length. */
  readonly length: number;
}

/**
 * Locate the rendered viewport slice inside the full buffer text.
 * Returns null when the slice is not a contiguous substring (soft-wrap
 * inserted characters, mid-render mutation) — callers must then fall back
 * to slice-as-ctx behaviour.
 *
 * Ambiguity (a repetitive buffer where the slice occurs more than once) is
 * resolved toward the occurrence containing the cursor — the viewport
 * follows the caret in CC — falling back to the first occurrence when the
 * cursor sits in none of them.
 */
export function locateViewportSlice(fullText: string, sliceText: string, cursor: number): ViewportMatch | null {
  // CC's rendered string appends ONE cursor-cell space that isn't buffer
  // content ("HELLO WORLD" renders as "HELLO WORLD "). Try the exact slice
  // first (the pad can be real content), then retry with a single trailing
  // space trimmed. Never trim more than one — beyond the cursor cell,
  // trailing spaces are user text.
  const exact = locateRaw(fullText, sliceText, cursor);
  if (exact) return exact;
  if (sliceText.endsWith(' ')) return locateRaw(fullText, sliceText.slice(0, -1), cursor);
  return null;
}

function locateRaw(fullText: string, sliceText: string, cursor: number): ViewportMatch | null {
  if (sliceText.length === 0 || sliceText.length > fullText.length) return null;
  if (sliceText === fullText) return { offset: 0, length: fullText.length };
  const first = fullText.indexOf(sliceText);
  if (first < 0) return null;
  if (fullText.indexOf(sliceText, first + 1) < 0) return { offset: first, length: sliceText.length };
  for (let idx = first; idx >= 0; idx = fullText.indexOf(sliceText, idx + 1)) {
    if (cursor >= idx && cursor <= idx + sliceText.length) return { offset: idx, length: sliceText.length };
  }
  return { offset: first, length: sliceText.length };
}

function shiftClip<T extends Range>(r: T, offset: number, sliceLen: number): T | null {
  const start = Math.max(r.start - offset, 0);
  const end = Math.min(r.end - offset, sliceLen);
  if (start >= end) return null;
  return { ...r, start, end };
}

function shiftClipList<T extends Range>(rs: readonly T[] | undefined, offset: number, sliceLen: number): T[] | undefined {
  if (!rs || rs.length === 0) return rs as T[] | undefined;
  const out: T[] = [];
  for (const r of rs) {
    const t = shiftClip(r, offset, sliceLen);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Translate directives computed against the FULL buffer into the viewport
 * slice's coordinate space. Ranges are shifted by -offset and clipped to
 * the slice; ranges falling entirely outside the viewport are dropped
 * (their content isn't on screen). `textOverride` is sliced only when its
 * length matches the full text (the glimmer whole-buffer override); any
 * other length is passed through untouched — its semantics are unknown
 * here and mangling it would corrupt the paint.
 */
export function translateDirectivesToViewport(
  d: RenderDirectives,
  offset: number,
  sliceLen: number,
  fullLen: number,
): RenderDirectives {
  if (offset === 0 && sliceLen >= fullLen) return d;

  let textOverride = d.textOverride;
  if (textOverride !== undefined && textOverride.length === fullLen) {
    textOverride = textOverride.slice(offset, offset + sliceLen);
  }

  let highlight: HighlightRange | undefined;
  if (d.highlight) highlight = shiftClip(d.highlight, offset, sliceLen) ?? undefined;

  let inlineNote: InlineNote | null | undefined = d.inlineNote;
  if (inlineNote) {
    // Cursor-gated: the caret is inside the span, so at least part of the
    // span is on screen in practice — but a fully off-screen span must not
    // anchor a note at a clamped fake position.
    if (inlineNote.spanEnd <= offset || inlineNote.spanStart >= offset + sliceLen) {
      inlineNote = null;
    } else {
      inlineNote = {
        ...inlineNote,
        spanStart: Math.max(inlineNote.spanStart - offset, 0),
        spanEnd: Math.min(inlineNote.spanEnd - offset, sliceLen),
      };
    }
  }

  return {
    ...d,
    ...(textOverride !== undefined ? { textOverride } : {}),
    dimRanges: shiftClipList(d.dimRanges, offset, sliceLen),
    boldRanges: shiftClipList(d.boldRanges, offset, sliceLen),
    italicRanges: shiftClipList(d.italicRanges, offset, sliceLen),
    codeRanges: shiftClipList(d.codeRanges, offset, sliceLen),
    strikeRanges: shiftClipList(d.strikeRanges, offset, sliceLen),
    headingRanges: shiftClipList(d.headingRanges, offset, sliceLen),
    listRanges: shiftClipList(d.listRanges, offset, sliceLen),
    coloredRanges: shiftClipList(d.coloredRanges as readonly ColoredRange[] | undefined, offset, sliceLen),
    highlight,
    inlineNote,
  };
}
