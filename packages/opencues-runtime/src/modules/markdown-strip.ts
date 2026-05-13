// Strip markdown markers from text so the buffer shows the rendered
// form (no `**`, `*`, `` ` ``, `~~`, `# `, `- `) while producing
// per-range metadata the renderer uses for ANSI bold / italic / code /
// etc. in terminals — and the chrome adapter dispatches to per-site
// native bold via Lexical / ProseMirror / Draft.js APIs.
//
// Markers stripped:
//
//   **bold**     → bold     + boldRange covering "bold"
//   *italic*     → italic   + italicRange
//   `code`       → code     + codeRange
//   ~~strike~~   → strike   + strikeRange
//   # heading    → heading  + headingRange (line-level)
//   - list item  → list item text + listRange (line-level, marker removed)
//
// All ranges are in STRIPPED-text coordinates (not buffer coords).
// Inline-only by design: spans that cross newlines stay literal.
//
// Round-trip: when the user cycles Down on an LLM-substituted region,
// the runtime restores the ORIGINAL pre-LLM text (the user's typed
// trigger phrase). The stripped form is never round-tripped back to
// the raw markdown — markers are intentionally lost. Callers that need
// the raw form (debug logs, agentic harness dumps) keep a separate copy.

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface MarkdownStripResult {
  /** Text with all markers removed. */
  readonly stripped: string;
  /** Char ranges of the surviving (post-strip) content per style. */
  readonly bold: readonly Range[];
  readonly italic: readonly Range[];
  readonly code: readonly Range[];
  readonly strike: readonly Range[];
  readonly heading: readonly Range[];
  readonly list: readonly Range[];
  /** True when the input contained ANY recognised markdown syntax. */
  readonly hadMarkdown: boolean;
}

export interface StripOptions {
  /** Char ranges (in INPUT coords) where stripping must not fire — for
   *  the runtime's active `_` blank slot positions. When a marker pair
   *  would wrap a suppress region the markers stay literal. */
  readonly suppressRanges?: readonly Range[];
}

/**
 * Strip markdown markers from `text`, returning the stripped string +
 * one Range list per recognised style. Idempotent on input with no
 * markdown.
 */
export function stripMarkdown(text: string, opts: StripOptions = {}): MarkdownStripResult {
  const state: State = {
    stripped: '',
    bold: [], italic: [], code: [], strike: [], heading: [], list: [],
    hadMarkdown: false,
    suppress: opts.suppressRanges ?? [],
  };
  if (text.length === 0) {
    return finalise(state);
  }

  let i = 0;
  const len = text.length;
  while (i < len) {
    const lineStart = i;
    let lineEnd = text.indexOf('\n', i);
    if (lineEnd < 0) lineEnd = len;
    const line = text.slice(lineStart, lineEnd);

    // Heading at line-start.
    const headMatch = line.match(/^(#{1,6})\s+/);
    let lineContentStart = 0;
    let lineIsHeading = false;
    if (headMatch && !overlapsSuppress(lineStart, lineStart + headMatch[0].length, state.suppress)) {
      lineContentStart = headMatch[0].length;
      lineIsHeading = true;
      state.hadMarkdown = true;
    }

    // List item at line-start (only if not a heading).
    let listIndent = '';
    let lineIsList = false;
    if (!lineIsHeading) {
      const listMatch = line.match(/^([ \t]*)([-*+]|\d+\.)\s+/);
      if (listMatch && !overlapsSuppress(lineStart, lineStart + listMatch[0].length, state.suppress)) {
        listIndent = listMatch[1];
        state.stripped += listIndent;
        lineContentStart = listMatch[0].length;
        lineIsList = true;
        state.hadMarkdown = true;
      }
    }

    const lineContentInputStart = lineStart + lineContentStart;
    const lineContentOutputStart = state.stripped.length;
    // Adjust suppress ranges into line-content coords for the inline scan.
    const inlineSuppress = state.suppress
      .filter(r => r.end > lineContentInputStart && r.start < lineEnd)
      .map(r => ({ start: r.start - lineContentInputStart, end: r.end - lineContentInputStart }));
    stripInline(line.slice(lineContentStart), inlineSuppress, state);
    const lineContentOutputEnd = state.stripped.length;

    if (lineIsHeading) {
      state.heading.push({ start: lineContentOutputStart, end: lineContentOutputEnd });
    } else if (lineIsList) {
      // List range covers the indent + content (marker is gone from output).
      state.list.push({ start: lineContentOutputStart - listIndent.length, end: lineContentOutputEnd });
    }

    if (lineEnd < len) {
      state.stripped += '\n';
      i = lineEnd + 1;
    } else {
      i = lineEnd;
    }
  }

  return finalise(state);
}

interface State {
  stripped: string;
  bold: Range[];
  italic: Range[];
  code: Range[];
  strike: Range[];
  heading: Range[];
  list: Range[];
  hadMarkdown: boolean;
  suppress: readonly Range[];
}

function finalise(s: State): MarkdownStripResult {
  return {
    stripped: s.stripped,
    bold: s.bold, italic: s.italic, code: s.code, strike: s.strike,
    heading: s.heading, list: s.list,
    hadMarkdown: s.hadMarkdown,
  };
}

function stripInline(line: string, suppress: readonly Range[], state: State): void {
  let i = 0;
  const len = line.length;
  while (i < len) {
    // **bold**
    if (line.startsWith('**', i)) {
      const close = findClose(line, i + 2, '**');
      if (close > i + 2 && !overlapsSuppress(i, close + 2, suppress)) {
        const inner = line.slice(i + 2, close);
        const start = state.stripped.length;
        state.stripped += inner;
        state.bold.push({ start, end: state.stripped.length });
        state.hadMarkdown = true;
        i = close + 2;
        continue;
      }
    }
    // ~~strike~~
    if (line.startsWith('~~', i)) {
      const close = findClose(line, i + 2, '~~');
      if (close > i + 2 && !overlapsSuppress(i, close + 2, suppress)) {
        const inner = line.slice(i + 2, close);
        const start = state.stripped.length;
        state.stripped += inner;
        state.strike.push({ start, end: state.stripped.length });
        state.hadMarkdown = true;
        i = close + 2;
        continue;
      }
    }
    // `code`
    if (line[i] === '`') {
      const close = findCloseSingleChar(line, i + 1, '`');
      if (close > i + 1 && !overlapsSuppress(i, close + 1, suppress)) {
        const inner = line.slice(i + 1, close);
        const start = state.stripped.length;
        state.stripped += inner;
        state.code.push({ start, end: state.stripped.length });
        state.hadMarkdown = true;
        i = close + 1;
        continue;
      }
    }
    // *italic* (single `*`, not part of `**`)
    if (line[i] === '*' && line[i + 1] !== '*' && line[i - 1] !== '*') {
      const close = findCloseItalicAsterisk(line, i + 1);
      if (close > i + 1 && !overlapsSuppress(i, close + 1, suppress)) {
        const inner = line.slice(i + 1, close);
        const start = state.stripped.length;
        state.stripped += inner;
        state.italic.push({ start, end: state.stripped.length });
        state.hadMarkdown = true;
        i = close + 1;
        continue;
      }
    }
    // Plain character.
    state.stripped += line[i];
    i++;
  }
}

function findClose(line: string, from: number, marker: string): number {
  const len = line.length;
  let i = from;
  while (i < len) {
    if (line.startsWith(marker, i)) return i;
    i++;
  }
  return -1;
}

function findCloseSingleChar(line: string, from: number, marker: string): number {
  const len = line.length;
  let i = from;
  while (i < len) {
    if (line[i] === marker) return i;
    i++;
  }
  return -1;
}

function findCloseItalicAsterisk(line: string, from: number): number {
  const len = line.length;
  let i = from;
  while (i < len) {
    if (line[i] === '*' && line[i + 1] !== '*' && line[i - 1] !== '*') return i;
    i++;
  }
  return -1;
}

function overlapsSuppress(start: number, end: number, suppress: readonly Range[]): boolean {
  for (const r of suppress) {
    if (start < r.end && r.start < end) return true;
  }
  return false;
}
