// Buffer-cursor → target-cursor translation for TransformBlank's APPLY pass.
//
// The EXTRACT pass produces a `target` string that's USUALLY a substring of
// the buffer (everything except the trigger phrase), but not strictly so —
// the LLM may have whitespace-normalised, trimmed, or otherwise rephrased.
//
// To anchor positional instructions ("insert X here _") at the user's caret,
// the APPLY pass needs to inject a [CURSOR] sentinel into the target at the
// position corresponding to the buffer cursor. This module does that
// translation, with three defined fall-back behaviours:
//
//   1. Buffer cursor < 0 OR target is empty
//        → return -1 (caller skips injection; LLM runs cursor-blind).
//
//   2. Target found as substring at offset `startIdx` in buffer
//        → translated cursor = (buffer cursor) - startIdx, clamped to
//          [0, target.length].
//
//   3. Target NOT a substring (LLM rephrased)
//        → fall back to a proportional approximation: scale buffer cursor
//          by (target.length / buffer.length), clamped. Lossy but usable.
//          When buffer is empty, return -1.
//
// All three paths return a number in `[-1, target.length]`. -1 means
// "skip cursor injection".

/**
 * Map a cursor offset from buffer coordinates into target coordinates so
 * the APPLY pass can inject a [CURSOR] sentinel at the right spot inside
 * the target text.
 */
export function translateBufferCursorToTargetCursor(
  buffer: string,
  bufferCursor: number,
  target: string,
): number {
  if (bufferCursor < 0) return -1;
  if (target.length === 0) return -1;
  if (buffer.length === 0) return -1;

  // Path A — exact substring match.
  const startIdx = buffer.indexOf(target);
  if (startIdx >= 0) {
    const translated = bufferCursor - startIdx;
    return clamp(translated, 0, target.length);
  }

  // Path B — proportional approximation (LLM rephrased the target).
  const ratio = target.length / buffer.length;
  return clamp(Math.round(bufferCursor * ratio), 0, target.length);
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
