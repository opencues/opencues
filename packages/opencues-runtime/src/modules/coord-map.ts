// Coordinate mapping between the runtime's LOGICAL buffer (what the resolver,
// DynDefs and word logic are computed against — `adapter.getText()`) and the
// text a host actually paints (`ctx.text`). Hosts reflow for display: Claude
// Code soft-wraps by REPLACING a space with `\n` at the wrap column
// (`"Flexbox を"` → `"Flexbox\nを"`) and INSERTS a bare `\n` mid-CJK-word where
// there's no space (`"メカニズ\nム"`); it may also toggle a ZWS render-kick.
// So the painted text is the same VISIBLE characters with different whitespace
// — NOT a clean superset of the logical buffer. Any range computed in logical
// coordinates must be mapped through here or it drifts after each wrap point
// (dim/highlight stopping short, loading-spinner colour landing early).

const WS = /[\s​‌]/;
function isWs(c: string): boolean { return WS.test(c); }

export interface IndexMap {
  /** Map a range START (inclusive) in `from` coords to `to` coords — snaps
   *  forward to the next visible char. */
  start(i: number): number;
  /** Map a range END (exclusive) in `from` coords to `to` coords — snaps to
   *  just past the last visible char before `i`, so trailing whitespace
   *  between the range and the next word isn't swept in. */
  end(i: number): number;
}

/**
 * Build start/end index mappers from `from` to `to`, aligning on the
 * NON-WHITESPACE skeleton. Whitespace (space, newline, tab, ZWS) on either
 * side is soft layout that may be substituted / inserted / removed — so a
 * host's space→`\n` wrap, bare-`\n` wrap, and ZWS toggles all map correctly as
 * long as the visible characters are unchanged.
 *
 * Safety: if `from` has MORE non-whitespace chars than `to`, the painted text
 * genuinely DROPPED visible characters (a lossy transient — mid-resolve, or a
 * viewport clip) and the skeletons don't correspond; the mappers fall back to
 * identity clamped to `to`'s bounds so they never emit an out-of-range index.
 */
export function buildIndexMap(from: string, to: string): IndexMap {
  const toNonWs: number[] = []; // `to` index of each non-whitespace char
  for (let ti = 0; ti < to.length; ti++) {
    if (!isWs(to[ti])) toNonWs.push(ti);
  }
  // nonWsBefore[i] = count of non-whitespace chars in from[0..i).
  const nonWsBefore = new Array<number>(from.length + 1);
  let cnt = 0;
  for (let fi = 0; fi < from.length; fi++) {
    nonWsBefore[fi] = cnt;
    if (!isWs(from[fi])) cnt++;
  }
  nonWsBefore[from.length] = cnt;

  if (cnt > toNonWs.length) {
    const clamp = (i: number): number => Math.min(Math.max(i, 0), to.length);
    return { start: clamp, end: clamp };
  }

  return {
    start(i: number): number {
      if (i <= 0) return 0;
      if (i >= from.length) return to.length;
      const k = nonWsBefore[i];                       // next visible char at/after i
      return k < toNonWs.length ? toNonWs[k] : to.length;
    },
    end(i: number): number {
      if (i >= from.length) return to.length;
      if (i <= 0) return 0;
      const k = nonWsBefore[i];                       // visible chars before i
      return k > 0 ? toNonWs[k - 1] + 1 : 0;          // just past the last one
    },
  };
}
