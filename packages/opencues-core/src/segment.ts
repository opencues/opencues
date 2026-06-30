// segment.ts — the SINGLE source of truth for "where does the command segment
// containing this `_` begin?", shared by the two routers that need it:
//
//   - blank-shapes.ts  (lineWithBlank)      — shaped-blank routing
//   - config-intent-source.ts (summonPhraseStart) — fluid-config settings routing
//
// Why centralised: before this, the two disagreed. Shaped blanks anchored on
// the PHYSICAL LINE (newline only), so `let me check the audio. volume _` did
// NOT fire volume — "volume" wasn't at the line start. But fluid-config already
// anchored on the SENTENCE (last `.`/`!`/`?` or newline), so the same buffer
// shape routed for settings but not for blanks. Users reasonably read "line" as
// "sentence". Routing both through this one predicate makes a command claim its
// `_` whenever it leads a SENTENCE, not just a physical line — and the two
// routers can never drift on what counts as a boundary.
//
// A boundary is: an ASCII terminator (`.`/`!`/`?`) FOLLOWED by whitespace (the
// `(?=\s)` lookahead is what stops `gpt-5.4` / `3.5` decimals from splitting),
// a CJK/fullwidth terminator (`。`/`！`/`？`/`．` — those scripts put no space
// after the stop), or a newline. The strict anchored shape still has to match
// the post-boundary segment, so a wrong split is always a clean cede, never
// garbage.

/** Boundary between command segments: sentence terminator (+ space for ASCII)
 *  or newline. Kept as a literal so both call sites share the exact grammar. */
const SEGMENT_BOUNDARY = /[.!?](?=\s)|[。！？．]|\n/g;

/**
 * Index in `text` where the command segment containing position `pos` begins —
 * i.e. just past the last sentence terminator or newline before `pos`, with any
 * leading whitespace skipped. Returns 0 when there is no boundary before `pos`.
 *
 * `pos` defaults to `text.length` (scan the whole buffer), which reproduces the
 * original `summonPhraseStart` contract exactly. Callers routing a `_` pass the
 * `_`'s index so boundaries after the `_` are ignored.
 */
export function segmentStart(text: string, pos: number = text.length): number {
  const upto = pos >= text.length ? text : text.slice(0, pos);
  const re = new RegExp(SEGMENT_BOUNDARY.source, 'g');
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(upto)) !== null) start = m.index + m[0].length;
  while (start < text.length && /\s/.test(text.charAt(start))) start += 1;
  return start;
}
