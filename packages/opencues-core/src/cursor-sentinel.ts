// Cursor sentinel — single source of truth for the marker injected into
// LLM prompts to tell the model where the user's caret is.
//
// Used by:
//   - @opencues/core's TransformBlankSource (APPLY pass) — anchors
//     positional instructions like "insert X here _", "add a comma here _",
//     "split this paragraph here _".
//   - @opencues/runtime's AgentRewrite (every round) — identifies the
//     IN-FLIGHT SENTENCE so the rewrite doesn't auto-terminate something
//     the user is still typing.
//
// The literal is `[CURSOR]` (square-bracketed ASCII). Three reasons:
//   - Tokenises to one chunk in every major BPE tokeniser → no
//     mid-token-split surprises that would leak partial sentinels.
//   - Trivially regex-strippable on the output side (case-insensitive)
//     so a model that lowercases it or sandwiches it in markdown still
//     gets cleaned up.
//   - Used by `agent-rewrite.ts` since the May 2026 rewrite-system-prompt
//     redesign; tests + benchmarks already pin the convention.
//
// If we ever switch markers, change this string in ONE place and every
// consumer follows. Don't redefine the literal locally in any source.

/** The marker injected into LLM prompts at the user's cursor position. */
export const CURSOR_SENTINEL = '[CURSOR]';

/**
 * Strip every occurrence of the cursor sentinel from a string, in both
 * upper-case (`[CURSOR]`) and lower-case (`[cursor]`) forms. Models
 * occasionally case-mangle the marker; the lower-case strip catches that
 * before the rewrite reaches the buffer.
 */
export function stripCursorSentinel(s: string): string {
  return s.replace(/\[CURSOR\]/g, '').replace(/\[cursor\]/g, '');
}

/**
 * Insert the cursor sentinel into `text` at the given byte offset.
 * Out-of-range offsets are clamped: negative → 0, past-end → end.
 * Pass `null` or a negative offset to skip insertion entirely (the
 * caller wants a cursor-blind prompt — useful when the host doesn't
 * know where the cursor is).
 */
export function injectCursorSentinel(text: string, offset: number | null | undefined): string {
  if (offset === null || offset === undefined || offset < 0) return text;
  const clamped = Math.min(Math.max(0, offset), text.length);
  return text.slice(0, clamped) + CURSOR_SENTINEL + text.slice(clamped);
}
