// East-Asian-Width-aware translation from JS string code-unit
// offsets to terminal cell positions.
//
// The runtime emits highlight / dim ranges in JS string code-unit
// offsets (same units everything else in the runtime uses). Most
// terminal hosts (OpenTUI-backed `shell` + `opencode`) hand those
// offsets straight to a painter that interprets them as terminal
// CELL positions — fine for ASCII (1 code unit = 1 cell) but wrong
// for CJK glyphs (1 code unit = 2 cells, per UAX #11). The span
// then paints over half the visible characters.
//
// This helper does the code-unit → cell conversion on the host side
// so the runtime stays unit-agnostic.

/** Returns the terminal cell width of a code point.
 *
 *  0 for combining marks / variation selectors / ZWJ — they paint
 *    on top of the previous glyph and add zero columns.
 *  2 for East-Asian-Wide / Fullwidth / emoji code points.
 *  1 for everything else.
 *
 *  Approximation of `wcwidth(3)` + a hand-picked emoji block list.
 *  The emoji block covers the ranges modern terminals (xterm, alacritty,
 *  iTerm2, Windows Terminal) actually render at 2 cells; some terminals
 *  render certain pictographs at 1 cell so this is heuristic, not
 *  guaranteed pixel-accurate. */
export function cellWidthForCodePoint(cp: number): number {
  // Zero-width: combining marks, ZWJ, variation selectors.
  if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF) return 0;
  if (cp >= 0x0300 && cp <= 0x036F) return 0; // Combining Diacritical Marks
  if (cp >= 0x1AB0 && cp <= 0x1AFF) return 0; // Combining Diacritical Marks Ext
  if (cp >= 0x1DC0 && cp <= 0x1DFF) return 0; // Combining Diacritical Marks Suppl
  if (cp >= 0x20D0 && cp <= 0x20FF) return 0; // Combining Diacritical Marks for Symbols
  if (cp >= 0xFE00 && cp <= 0xFE0F) return 0; // Variation Selectors
  if (cp >= 0xFE20 && cp <= 0xFE2F) return 0; // Combining Half Marks
  if (cp >= 0xE0100 && cp <= 0xE01EF) return 0; // Variation Selectors Suppl

  if (cp < 0x1100) return 1;

  // East-Asian-Wide / Fullwidth.
  if (cp <= 0x115F) return 2; // Hangul Jamo
  if (cp >= 0x2329 && cp <= 0x232A) return 2; // Angle brackets
  if (cp >= 0x2E80 && cp <= 0x303E) return 2; // CJK Radicals, Kangxi
  if (cp >= 0x3041 && cp <= 0x33FF) return 2; // Hiragana, Katakana, Bopomofo, CJK Symbols
  if (cp >= 0x3400 && cp <= 0x4DBF) return 2; // CJK Unified Ext A
  if (cp >= 0x4E00 && cp <= 0x9FFF) return 2; // CJK Unified
  if (cp >= 0xA000 && cp <= 0xA4CF) return 2; // Yi Syllables / Radicals
  if (cp >= 0xAC00 && cp <= 0xD7A3) return 2; // Hangul Syllables
  if (cp >= 0xF900 && cp <= 0xFAFF) return 2; // CJK Compat Ideographs
  if (cp >= 0xFE30 && cp <= 0xFE4F) return 2; // CJK Compat Forms
  if (cp >= 0xFF00 && cp <= 0xFF60) return 2; // Fullwidth Forms (NOT halfwidth katakana 0xFF61+)
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2; // Fullwidth signs

  // Emoji ranges (most modern terminals render these as 2 cells).
  if (cp >= 0x1F300 && cp <= 0x1F64F) return 2; // Misc Symbols & Pictographs + Emoticons
  if (cp >= 0x1F680 && cp <= 0x1F6FF) return 2; // Transport & Map
  if (cp >= 0x1F700 && cp <= 0x1F77F) return 2; // Alchemical
  if (cp >= 0x1F780 && cp <= 0x1F7FF) return 2; // Geometric Shapes Ext
  if (cp >= 0x1F800 && cp <= 0x1F8FF) return 2; // Supplemental Arrows-C
  if (cp >= 0x1F900 && cp <= 0x1F9FF) return 2; // Supplemental Symbols & Pictographs
  if (cp >= 0x1FA00 && cp <= 0x1FAFF) return 2; // Symbols Ext A
  if (cp >= 0x1FB00 && cp <= 0x1FBFF) return 2; // Symbols for Legacy Computing

  // Supra-BMP CJK Unified Extensions B–G.
  if (cp >= 0x20000 && cp <= 0x2FFFD) return 2;
  if (cp >= 0x30000 && cp <= 0x3FFFD) return 2;

  return 1;
}

/** Total terminal cells needed to render `text[0..codeUnitOffset)`.
 *  Walks code POINTS (not code units) so surrogate pairs count as
 *  one glyph. Returns the cell index that aligns with the given
 *  code-unit offset. */
export function codeUnitsToCells(text: string, codeUnitOffset: number): number {
  if (codeUnitOffset <= 0) return 0;
  const clamped = Math.min(codeUnitOffset, text.length);
  let cells = 0;
  let i = 0;
  while (i < clamped) {
    const cp = text.codePointAt(i)!;
    cells += cellWidthForCodePoint(cp);
    i += cp > 0xFFFF ? 2 : 1;
  }
  return cells;
}
