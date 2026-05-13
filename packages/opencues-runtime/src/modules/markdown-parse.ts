// Lightweight, single-pass parser for the markdown features the runtime
// renders inline. NOT a full CommonMark implementation — we cover the
// subset LLMs emit when given creative-rewrite tasks:
//
//   **bold**      → bold span
//   *italic*      → italic span  (single asterisk only; `**` always wins)
//   `code`        → inline code span
//   ~~strike~~    → strikethrough span
//   # heading     → heading line (level 1-6 via `#`-count; line-level)
//   - item        → list item (line-level; matches `-`, `*`, `+`, `1.`)
//
// Design choices:
//
//   - All-or-nothing range output. Each detection emits a Range
//     (start..end, half-open) into the buffer's character offsets,
//     INCLUDING the syntax markers. Renderers decide whether to dim
//     the markers or not.
//
//   - Display-only. The parser doesn't strip syntax from the buffer —
//     downstream code reads `boldRanges` / `italicRanges` / etc. and
//     layers visual styling on top (ANSI escapes in terminals; per-site
//     mechanisms in chrome).
//
//   - Blank-suppression. Markdown's `*x*` underline collides with the
//     runtime's blank slot syntax (`volume _`, `weather _`). Pass
//     `suppressRanges` (character ranges where blanks live) and the
//     parser drops any italic / strike / code range that overlaps.
//     Bold (`**`) is two-character → no collision; passes through
//     unchanged.
//
//   - No nesting. Bold-inside-italic, code-inside-bold, etc. are not
//     supported — first match wins, the inner candidates fall through
//     as plain text. Matches typical LLM output (rarely nests beyond
//     two levels) and keeps the parser O(n).

export interface ParsedMarkdown {
  bold: readonly Range[];
  italic: readonly Range[];
  code: readonly Range[];
  strike: readonly Range[];
  heading: readonly Range[];
  list: readonly Range[];
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface ParseOptions {
  /** Character ranges where parsing should NOT produce italic / strike
   *  / code spans (typically the runtime's active `_` blank slots).
   *  Ranges that overlap a suppress region are dropped. Bold (`**`) is
   *  immune because its syntax can't collide with a single `_`. */
  readonly suppressRanges?: readonly Range[];
}

/**
 * Parse `text` for markdown spans. Returns six independent range lists,
 * each sorted ascending by start offset.
 */
export function parseMarkdown(text: string, opts: ParseOptions = {}): ParsedMarkdown {
  const suppress = opts.suppressRanges ?? [];
  const bold = findPairedSpans(text, '**', '**');
  const code = filterOverlap(findPairedSpans(text, '`', '`'), suppress);
  const strike = filterOverlap(findPairedSpans(text, '~~', '~~'), suppress);
  // Italic — `*foo*` but NOT inside an already-found bold range (since
  // `**bold**` contains `*bold*` as a substring).
  const italicRaw = findSingleCharSpans(text, '*');
  const italic = filterOverlap(
    italicRaw.filter(r => !overlapsAny(r, bold)),
    suppress,
  );
  // Heading lines.
  const heading = findHeadingLines(text);
  // List items.
  const list = findListItems(text);
  return { bold, italic, code, strike, heading, list };
}

// ─── Span finders ──────────────────────────────────────────────────────

function findPairedSpans(text: string, openTok: string, closeTok: string): Range[] {
  const out: Range[] = [];
  const len = text.length;
  const ol = openTok.length;
  const cl = closeTok.length;
  let i = 0;
  while (i < len) {
    if (text.slice(i, i + ol) !== openTok) { i++; continue; }
    // Find the closing token on the same content (no newlines inside a
    // span — LLMs use `**…**` only inside one line; multi-line bold is
    // rare and would clash with paragraph parsing).
    const searchStart = i + ol;
    let j = searchStart;
    while (j < len) {
      if (text[j] === '\n') break;
      if (text.slice(j, j + cl) === closeTok) {
        // Empty span `**​**` → skip (zero-content).
        if (j > searchStart) {
          out.push({ start: i, end: j + cl });
          i = j + cl;
          break;
        }
        // Empty: advance past to avoid infinite loop.
        j = searchStart + 1;
        break;
      }
      j++;
    }
    if (j >= len || text[j] === '\n') i += ol;  // no close found on line → drop
    else if (out.length === 0 || out[out.length - 1].end <= i) i += ol;
  }
  return out;
}

function findSingleCharSpans(text: string, marker: string): Range[] {
  // Like findPairedSpans but skips occurrences of doubled markers
  // (so `**bold**` doesn't get picked up as `*bold*` italic).
  const out: Range[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (text[i] !== marker) { i++; continue; }
    // Doubled-marker check: skip past `**`.
    if (text[i + 1] === marker) { i += 2; continue; }
    const searchStart = i + 1;
    let j = searchStart;
    while (j < len) {
      if (text[j] === '\n') break;
      if (text[j] === marker && text[j + 1] !== marker && text[j - 1] !== marker) {
        if (j > searchStart) {
          out.push({ start: i, end: j + 1 });
          i = j + 1;
          break;
        }
        j = searchStart + 1;
        break;
      }
      j++;
    }
    if (j >= len || text[j] === '\n') i++;
    else if (out.length === 0 || out[out.length - 1].end <= i) i++;
  }
  return out;
}

function findHeadingLines(text: string): Range[] {
  const out: Range[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function findListItems(text: string): Range[] {
  const out: Range[] = [];
  // Bullet `-` / `*` / `+` OR numbered `1.` style. Whole-line match.
  const re = /^[ \t]*(?:[-*+]|\d+\.)\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ─── Overlap helpers ──────────────────────────────────────────────────

function overlapsAny(r: Range, others: readonly Range[]): boolean {
  for (const o of others) {
    if (r.start < o.end && o.start < r.end) return true;
  }
  return false;
}

function filterOverlap(ranges: readonly Range[], suppress: readonly Range[]): Range[] {
  if (suppress.length === 0) return [...ranges];
  return ranges.filter(r => !overlapsAny(r, suppress));
}
