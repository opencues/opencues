/**
 * Lightweight sentence segmenter — used both by the bench and (in v1)
 * mirrored by the production SentenceCueSource.
 *
 * Strategy: regex-based, prioritises ROBUSTNESS over linguistic perfection.
 *
 *  - Splits on `[.!?]+` followed by whitespace OR end-of-string.
 *  - PRESERVES the terminator on the sentence it terminates.
 *  - PRESERVES leading/trailing whitespace at the buffer level (offsets
 *    so callers can map sentences back to char ranges).
 *
 * Known limitations (acknowledged, not blocking v1):
 *  - "Mr. Jones said hi." gets split at "Mr." — abbreviation handling is
 *    out of scope; user-visible failure is "Jones said hi." becomes its
 *    own pseudo-sentence and gets independently cued. Recoverable.
 *  - URLs containing periods (`https://a.b/c`) get split at each dot.
 *    Mitigated at the cue layer by the SAME/CEDE verdict — code/URL
 *    fragments get filtered out by the LLM as "no useful rewrite".
 *  - Multi-line buffers split per-line at sentence boundaries; newlines
 *    inside a sentence are tolerated (whitespace).
 */

export interface SentenceSpan {
  /** Sentence text, including its terminator if one was present. */
  text: string;
  /** Inclusive char offset in the original buffer. */
  start: number;
  /** Exclusive char offset (end of the terminator, not of the trailing whitespace). */
  end: number;
}

/**
 * Split a buffer into sentences with char offsets.
 *
 * Returns spans whose `text` is the trimmed sentence (no surrounding
 * whitespace) but whose offsets index INTO THE ORIGINAL BUFFER, so
 * callers can splice replacements without recomputing.
 */
export function segmentSentences(buffer: string): SentenceSpan[] {
  if (!buffer) return [];
  const spans: SentenceSpan[] = [];
  // Regex matches a sentence: minimal run of non-terminators followed by
  // one or more terminators (.!?), then either whitespace or EOF.
  const re = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = m.index + raw.indexOf(trimmed[0]);
    const end = start + trimmed.length;
    spans.push({ text: trimmed, start, end });
  }
  return spans;
}
