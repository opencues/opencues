/**
 * Invariants the AgentRewrite pipeline must satisfy across the whole
 * lifetime of a typing scenario. The harness runs every invariant after
 * every tick; any violation surfaces as a regression with a concrete
 * repro (the `Step[]` that produced it).
 *
 * Adding a new invariant here AUTOMATICALLY surfaces it on every existing
 * scenario — that's the leverage. When you spot a class of bugs, encode
 * the invariant once and the whole corpus self-checks against it.
 */
import type { Invariant } from './types';

const INVARIANTS: Invariant[] = [
  {
    name: 'user-content-survives',
    check: ({ userTypedSoFar, bufferNow }) => {
      // Heuristic: most non-whitespace chars the user typed should
      // appear in the buffer. Tolerates spelling fixes (which slightly
      // reduce char count) and capitalisation. Fires only when the
      // user has typed enough that mass-deletion would be detectable
      // (>= 15 chars), and uses a 30% retention threshold — anything
      // below that is mass user-content loss.
      const userNoWS = userTypedSoFar.replace(/\s+/g, '');
      if (userNoWS.length < 15) return null;
      const bufNoWS = bufferNow.replace(/\s+/g, '');
      const intersect = countCommonChars(userNoWS.toLowerCase(), bufNoWS.toLowerCase());
      const ratio = intersect / userNoWS.length;
      if (ratio < 0.3) {
        return `user typed ${userNoWS.length} non-whitespace chars but buffer has ${bufNoWS.length}; ratio ${ratio.toFixed(2)} (< 0.30)`;
      }
      return null;
    },
  },
  {
    name: 'paragraph-breaks-survive',
    check: ({ userTypedSoFar, bufferNow }) => {
      // For every \n\n run the user typed, the buffer must contain at
      // least the same number of \n\n runs.
      const userBreaks = (userTypedSoFar.match(/\n{2,}/g) ?? []).length;
      const bufBreaks = (bufferNow.match(/\n{2,}/g) ?? []).length;
      if (bufBreaks < userBreaks) {
        return `user typed ${userBreaks} paragraph break(s); buffer has ${bufBreaks}`;
      }
      return null;
    },
  },
  {
    name: 'trailing-whitespace-preserved',
    check: ({ userTypedSoFar, bufferNow }) => {
      // If the user's typed text ends in whitespace, the buffer must
      // also end in at least that many trailing whitespace chars.
      const userTail = (userTypedSoFar.match(/\s*$/)?.[0] ?? '');
      const bufTail = (bufferNow.match(/\s*$/)?.[0] ?? '');
      if (userTail.length > bufTail.length) {
        return `user typed ${JSON.stringify(userTail)} trailing whitespace; buffer ends in ${JSON.stringify(bufTail)}`;
      }
      return null;
    },
  },
  {
    name: 'cursor-in-bounds',
    check: ({ bufferNow, cursorNow }) => {
      if (cursorNow < 0 || cursorNow > bufferNow.length) {
        return `cursor=${cursorNow} out of bounds for buffer length ${bufferNow.length}`;
      }
      return null;
    },
  },
  {
    name: 'no-end-marker-leak',
    check: ({ userTypedSoFar, bufferNow }) => {
      // The literal string "END" should never appear in the buffer
      // unless the user actually typed it.
      if (bufferNow.includes('END') && !userTypedSoFar.includes('END')) {
        return `buffer contains literal "END" but the user never typed it`;
      }
      return null;
    },
  },
  {
    name: 'no-cursor-sentinel-leak',
    check: ({ bufferNow }) => {
      if (bufferNow.includes('[CURSOR]')) {
        return `buffer contains the [CURSOR] input-only sentinel`;
      }
      return null;
    },
  },
  {
    name: 'no-buffer-flicker',
    check: ({ history }) => {
      // Detect "insert then delete" oscillation: a substring appears in
      // the buffer at tick N, vanishes at tick N+1, then reappears at
      // tick N+2. We approximate by checking for X→Y→X patterns at the
      // tick-by-tick granularity.
      if (history.length < 3) return null;
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      const prevPrev = history[history.length - 3];
      if (last === prevPrev && last !== prev) {
        return `buffer flicker — three-state oscillation detected (X → Y → X)`;
      }
      return null;
    },
  },
  {
    name: 'no-spurious-shrinkage',
    check: ({ userTypedSoFar, bufferNow, history }) => {
      // If the buffer suddenly drops well below the user-typed length
      // without the user shrinking it, something deleted content.
      // Threshold: > 50% size loss, AND the user has typed enough for
      // mass deletion to be noticeable (>= 20 chars).
      if (history.length < 2) return null;
      if (userTypedSoFar.length < 20) return null;
      if (bufferNow.length < userTypedSoFar.length * 0.4) {
        return `buffer length ${bufferNow.length} is < 40% of user-typed length ${userTypedSoFar.length}`;
      }
      return null;
    },
  },
];

function countCommonChars(a: string, b: string): number {
  // Count how many chars from `a` appear in `b` (multiset intersection).
  const bChars = new Map<string, number>();
  for (const ch of b) bChars.set(ch, (bChars.get(ch) ?? 0) + 1);
  let count = 0;
  for (const ch of a) {
    const remaining = bChars.get(ch) ?? 0;
    if (remaining > 0) {
      count += 1;
      bChars.set(ch, remaining - 1);
    }
  }
  return count;
}

export function getInvariants(): ReadonlyArray<Invariant> { return INVARIANTS; }

/**
 * Add an invariant at runtime. Useful for scenario-specific rules
 * (e.g. "buffer never contains the word 'foo'").
 */
export function withCustomInvariants(extras: Invariant[]): ReadonlyArray<Invariant> {
  return [...INVARIANTS, ...extras];
}
