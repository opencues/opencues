// Single entry-point for LLM-origin substitution writes that may
// contain markdown. Two flavours, one underlying primitive:
//
//   applyMarkdownAwareSplice(adapter, currentText, start, end, rewrite)
//       Splice-mode: replace [start, end) with stripped rewrite,
//       preserve everything outside that range. Used by FluidBlank
//       (slot-fill) and TransformBlank (target+trigger replace).
//
//   applyMarkdownAwareSubstitution(adapter, rewrite)
//       Convenience wrapper that reads the current buffer and
//       splices over [0, length) — i.e. whole-body replace.
//
// Both flavours strip markdown markers, write the stripped form to
// the host, then emit `markdown.styled` with per-style ranges in
// FINAL-buffer coords (shifted by `start`) so MarkdownRender +
// chrome's per-site write paths can wrap the live DOM in bold /
// italic / strike markup.

import type { HostAdapter } from '../adapter';
import { stripMarkdown, type Range as StripRange } from './markdown-strip';

export interface StyledMarkdownPayload {
  /** The text written to the buffer (post-strip, full new text).
   *  Receivers match their live `getText()` against this to detect
   *  cache drift. */
  readonly text: string;
  readonly bold: readonly StripRange[];
  readonly italic: readonly StripRange[];
  readonly code: readonly StripRange[];
  readonly strike: readonly StripRange[];
  readonly heading: readonly StripRange[];
  readonly list: readonly StripRange[];
}

export interface SubstituteOptions {
  /** Cursor offset to set after the write, in FINAL-buffer coords.
   *  When omitted, defaults to end of the spliced insertion (i.e.
   *  `start + stripped.length`). */
  readonly cursor?: number;
  /** Char-range overlay where markers must stay literal (active blank
   *  slot positions). Passed straight through to stripMarkdown. */
  readonly suppressRanges?: readonly StripRange[];
}

export interface SubstituteResult {
  /** The full new buffer text after the splice. Equals what the
   *  adapter now reports via getText(). */
  readonly newText: string;
  /** Cursor offset that was applied (after clamping). */
  readonly newCursor: number;
  /** The stripped form of the rewrite ONLY (not the full buffer). */
  readonly stripped: string;
  /** True when the input had any markdown syntax. False = no strip
   *  happened; no event fired; receivers stay quiet. */
  readonly hadMarkdown: boolean;
  /** The markdown.styled payload that was emitted (ranges in
   *  final-buffer coords). Returned even when hadMarkdown=false so
   *  callers can inspect the shape; only emitted when hadMarkdown=true. */
  readonly payload: StyledMarkdownPayload;
}

/**
 * Splice the stripped form of `rewriteText` into `currentText`
 * between `[start, end)`. Mirrors FluidBlank's classic splice
 * (`text.slice(0,start) + answer + text.slice(end)`) with markdown
 * handling layered on. Used by both FluidBlank (slot fill) and
 * TransformBlank (body+trigger replace) so the write path stays
 * identical in shape.
 *
 * Coordinate model: input ranges from stripMarkdown live in
 * rewrite-stripped coords (0..stripped.length). We shift them by
 * `start` so the emitted markdown.styled payload's ranges index
 * into the FINAL buffer. Receivers (MarkdownRender, chrome's
 * applyMarkdownStyling) don't need to know about splicing.
 */
export function applyMarkdownAwareSplice(
  adapter: HostAdapter,
  currentText: string,
  start: number,
  end: number,
  rewriteText: string,
  opts: SubstituteOptions = {},
): SubstituteResult {
  // Markdown pass-through: the host says the CURRENT target renders
  // markers itself (Discord shows **bold** styled at send) and has no
  // styling surface of its own — stripping would silently destroy the
  // styling with nowhere to re-render it. Write the rewrite verbatim;
  // no markdown.styled event fires (there is no receiver to paint it).
  // Hosts without the hook — every in-process host — take the
  // strip+render path below byte-identically.
  if (adapter.markdownPassthrough?.()) {
    const rawText = currentText.slice(0, start) + rewriteText + currentText.slice(end);
    const rawCursor = Math.min(Math.max(0, opts.cursor ?? (start + rewriteText.length)), rawText.length);
    if (adapter.pushText) {
      adapter.pushText(rawText, rawCursor);
    } else {
      adapter.setText(rawText);
      adapter.setCursorOffset(rawCursor);
      adapter.forceRender();
    }
    return {
      newText: rawText,
      newCursor: rawCursor,
      stripped: rewriteText,
      hadMarkdown: false,
      payload: { text: rawText, bold: [], italic: [], code: [], strike: [], heading: [], list: [] },
    };
  }

  const result = stripMarkdown(rewriteText, { suppressRanges: opts.suppressRanges });
  const newText = currentText.slice(0, start) + result.stripped + currentText.slice(end);

  // Cursor default — end of the inserted (stripped) section.
  // Clamp so the cursor never lands past the end of the buffer.
  const requested = opts.cursor ?? (start + result.stripped.length);
  const newCursor = Math.min(Math.max(0, requested), newText.length);

  if (adapter.pushText) {
    adapter.pushText(newText, newCursor);
  } else {
    adapter.setText(newText);
    adapter.setCursorOffset(newCursor);
    adapter.forceRender();
  }

  // Shift the per-style ranges from rewrite-stripped coords into
  // final-buffer coords (add `start` to each endpoint).
  const shift = (rs: readonly StripRange[]): readonly StripRange[] =>
    rs.map(r => ({ start: r.start + start, end: r.end + start }));
  const payload: StyledMarkdownPayload = {
    text: newText,
    bold: shift(result.bold),
    italic: shift(result.italic),
    code: shift(result.code),
    strike: shift(result.strike),
    heading: shift(result.heading),
    list: shift(result.list),
  };

  if (result.hadMarkdown) {
    adapter.emitEvent?.('markdown.styled', payload as unknown as Record<string, unknown>);
  }

  return {
    newText,
    newCursor,
    stripped: result.stripped,
    hadMarkdown: result.hadMarkdown,
    payload,
  };
}

/**
 * Whole-body convenience wrapper: splices over the entire current
 * buffer. Equivalent to `applyMarkdownAwareSplice(adapter, getText(),
 * 0, getText().length, rewriteText, opts)`.
 *
 * Kept as its own export because most TransformBlank/AgentRewrite
 * callers don't compute splice ranges; they hand in a whole new body
 * and let this wrapper do the bookkeeping.
 */
export function applyMarkdownAwareSubstitution(
  adapter: HostAdapter,
  rewriteText: string,
  opts: SubstituteOptions = {},
): SubstituteResult {
  const currentText = adapter.getText();
  return applyMarkdownAwareSplice(adapter, currentText, 0, currentText.length, rewriteText, opts);
}
