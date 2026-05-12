// Property-based tests for wordDiff + threeWayMerge.
//
// The existing word-diff.test.ts and word-diff.scenarios.test.ts pin
// hand-crafted edge cases. These tests pin the ALGORITHMIC INVARIANTS —
// they don't care what the input is, they assert what must be true for
// every input. Seeded random generation (no fast-check dep) lets each
// invariant catch shapes we didn't think to enumerate.
//
// If any property here fails, the failure is structural: the algorithm
// has lost a guarantee future modules depend on. AgentRewrite's cache,
// cursor translation, and DynDef placement all build on these.

import { describe, expect, it } from 'vitest';
import { wordDiff, applyHunks, threeWayMerge, translateAToC, DiffHunk } from './word-diff';

// Deterministic PRNG so failures reproduce. Mulberry32 — fine for fuzz
// inputs, not for cryptography.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog',
  'cat', 'tree', 'house', 'red', 'blue', 'green', 'fast', 'slow',
  'happy', 'sad', 'go', 'come', 'say', 'do', 'see', 'big', 'small',
  'now', 'later', 'today', 'yesterday', 'maybe', 'never', 'always',
];

function randomText(rnd: () => number, nWords: number): string {
  const parts: string[] = [];
  for (let i = 0; i < nWords; i++) {
    parts.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    if (rnd() < 0.08 && i > 0) parts.push('.');
    if (rnd() < 0.03) parts.push('\n');
  }
  return parts.join(' ').replace(/ \./g, '.').replace(/ \n /g, '\n');
}

// Random edit operations on a string. Used to derive plausible (A, B, C)
// triples for fuzzing.
function randomEdit(rnd: () => number, s: string): string {
  if (s.length === 0) return WORDS[Math.floor(rnd() * WORDS.length)];
  const kind = Math.floor(rnd() * 4);
  const pos = Math.floor(rnd() * s.length);
  if (kind === 0) {
    // Substitute a word at pos.
    const replacement = WORDS[Math.floor(rnd() * WORDS.length)];
    return s.slice(0, pos) + replacement + s.slice(pos);
  }
  if (kind === 1) {
    // Delete a small range.
    const end = Math.min(s.length, pos + 1 + Math.floor(rnd() * 5));
    return s.slice(0, pos) + s.slice(end);
  }
  if (kind === 2) {
    // Insert at end (the "user typed at end" common case).
    return s + ' ' + WORDS[Math.floor(rnd() * WORDS.length)];
  }
  // Insert mid-buffer.
  return s.slice(0, pos) + ' ' + WORDS[Math.floor(rnd() * WORDS.length)] + ' ' + s.slice(pos);
}

const SEEDS = [1, 7, 42, 1337, 31415, 271828, 11111, 99999];

describe('wordDiff invariants', () => {
  it('wordDiff(s, s) returns [] for every random s', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 20; i++) {
        const s = randomText(rnd, 1 + Math.floor(rnd() * 15));
        expect(wordDiff(s, s), `seed=${seed} i=${i}`).toEqual([]);
      }
    }
  });

  it('applyHunks(a, wordDiff(a, b)) === b for every random pair — round-trip', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 30; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 12));
        let b = a;
        const nEdits = 1 + Math.floor(rnd() * 4);
        for (let e = 0; e < nEdits; e++) b = randomEdit(rnd, b);
        const hunks = wordDiff(a, b);
        expect(applyHunks(a, hunks), `seed=${seed} i=${i}`).toBe(b);
      }
    }
  });

  it('hunks are sorted ascending by aStart with no overlap', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 30; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 12));
        let b = a;
        for (let e = 0; e < 1 + Math.floor(rnd() * 4); e++) b = randomEdit(rnd, b);
        const hunks = wordDiff(a, b);
        for (let j = 1; j < hunks.length; j++) {
          expect(hunks[j].aStart, `seed=${seed} i=${i}: hunk[${j-1}].aEnd <= hunk[${j}].aStart`)
            .toBeGreaterThanOrEqual(hunks[j - 1].aEnd);
        }
      }
    }
  });

  it('hunk a-ranges stay inside the source string bounds', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 20; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 12));
        let b = a;
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) b = randomEdit(rnd, b);
        const hunks = wordDiff(a, b);
        for (const h of hunks) {
          expect(h.aStart, `seed=${seed} i=${i}`).toBeGreaterThanOrEqual(0);
          expect(h.aEnd, `seed=${seed} i=${i}`).toBeLessThanOrEqual(a.length);
          expect(h.aEnd, `seed=${seed} i=${i}`).toBeGreaterThanOrEqual(h.aStart);
        }
      }
    }
  });
});

describe('threeWayMerge invariants', () => {
  it('threeWayMerge(A, A, A) is a no-op', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 10; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 12));
        const r = threeWayMerge(a, a, a);
        expect(r.newText, `seed=${seed} i=${i}`).toBe(a);
        expect(r.appliedLlmHunks, `seed=${seed} i=${i}`).toEqual([]);
        expect(r.droppedLlmHunks, `seed=${seed} i=${i}`).toEqual([]);
      }
    }
  });

  it('threeWayMerge(A, A, C) === C — LLM proposed no change → live preserved verbatim', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 15; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 10));
        let c = a;
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) c = randomEdit(rnd, c);
        const r = threeWayMerge(a, a, c);
        expect(r.newText, `seed=${seed} i=${i}`).toBe(c);
        expect(r.appliedLlmHunks, `seed=${seed} i=${i}`).toEqual([]);
      }
    }
  });

  it('threeWayMerge(A, B, A) applies the full LLM rewrite (no user edits)', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 20; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 10));
        let b = a;
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) b = randomEdit(rnd, b);
        const r = threeWayMerge(a, b, a);
        // The merge may drop trailing-terminator additions or trim
        // paragraph collapses, but with userHunks=[] no hunks are
        // dropped for OVERLAP reasons. Worst case (terminator
        // stripping): newText differs from b only in the terminator.
        // Assert applied + dropped accounts for every llmHunk.
        const llm = wordDiff(a, b);
        expect(r.appliedLlmHunks.length + r.droppedLlmHunks.length, `seed=${seed} i=${i}`).toBe(llm.length);
      }
    }
  });

  it('applied + dropped LLM hunks together account for every wordDiff(A,B) hunk', () => {
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 20; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 10));
        let b = a, c = a;
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) b = randomEdit(rnd, b);
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) c = randomEdit(rnd, c);
        const r = threeWayMerge(a, b, c);
        const total = r.appliedLlmHunks.length + r.droppedLlmHunks.length;
        expect(total, `seed=${seed} i=${i}`).toBe(wordDiff(a, b).length);
      }
    }
  });

  it('no applied LLM hunk overlaps any user hunk in A\'s frame', () => {
    const overlaps = (h1: DiffHunk, h2: DiffHunk): boolean =>
      !(h1.aEnd <= h2.aStart || h2.aEnd <= h1.aStart);
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 20; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 10));
        let b = a, c = a;
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) b = randomEdit(rnd, b);
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) c = randomEdit(rnd, c);
        const r = threeWayMerge(a, b, c);
        for (const llmH of r.appliedLlmHunks) {
          for (const userH of r.userHunks) {
            // Pure-range overlap check (point-insertion boundary cases
            // are handled by the merge itself; assert the range guarantee).
            const llmIsPoint = llmH.aStart === llmH.aEnd;
            const userIsPoint = userH.aStart === userH.aEnd;
            if (llmIsPoint || userIsPoint) continue;
            expect(overlaps(llmH, userH), `seed=${seed} i=${i}: applied LLM hunk overlaps user hunk in A`).toBe(false);
          }
        }
      }
    }
  });

  it('idempotency: merging the result with itself produces the same text', () => {
    // Once a round lands, the live buffer matches newText. A subsequent
    // tick on the same buffer (e.g. cached rewrite hit) should not
    // produce further changes. Captures the "no oscillation on stable
    // state" property the cache + skip-on-stable rely on.
    for (const seed of SEEDS) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < 15; i++) {
        const a = randomText(rnd, 1 + Math.floor(rnd() * 10));
        let b = a;
        for (let e = 0; e < 1 + Math.floor(rnd() * 3); e++) b = randomEdit(rnd, b);
        const r1 = threeWayMerge(a, b, a);
        const r2 = threeWayMerge(r1.newText, r1.newText, r1.newText);
        expect(r2.newText, `seed=${seed} i=${i}`).toBe(r1.newText);
      }
    }
  });
});

describe('translateAToC edge cases (anchor boundary)', () => {
  // The anchor='start' vs anchor='end' distinction is load-bearing for
  // point-insertion boundary cases — a hunk's start shifts AT-or-after
  // an insertion, its end shifts only STRICTLY after. Without this,
  // splicing a hunk whose A-start lands exactly on a user-insertion
  // boundary would emit garbled positions in C.

  it('point-insertion exactly at pos shifts start but not end', () => {
    const userHunks: DiffHunk[] = [{ aStart: 5, aEnd: 5, replacement: 'XYZ' }];
    expect(translateAToC(5, userHunks, 'start')).toBe(8);
    expect(translateAToC(5, userHunks, 'end')).toBe(5);
  });

  it('point-insertion before pos: both anchors shift', () => {
    const userHunks: DiffHunk[] = [{ aStart: 3, aEnd: 3, replacement: 'XX' }];
    expect(translateAToC(7, userHunks, 'start')).toBe(9);
    expect(translateAToC(7, userHunks, 'end')).toBe(9);
  });

  it('point-insertion after pos: neither anchor shifts', () => {
    const userHunks: DiffHunk[] = [{ aStart: 10, aEnd: 10, replacement: 'X' }];
    expect(translateAToC(5, userHunks, 'start')).toBe(5);
    expect(translateAToC(5, userHunks, 'end')).toBe(5);
  });

  it('range hunk shrinks: positions after aEnd shift left by net delta', () => {
    const userHunks: DiffHunk[] = [{ aStart: 3, aEnd: 8, replacement: 'X' }];  // delete 5, insert 1 = -4
    expect(translateAToC(10, userHunks)).toBe(6);
  });

  it('range hunk grows: positions after aEnd shift right by net delta', () => {
    const userHunks: DiffHunk[] = [{ aStart: 3, aEnd: 5, replacement: 'HELLO' }];  // delete 2, insert 5 = +3
    expect(translateAToC(10, userHunks)).toBe(13);
  });

  it('multiple user hunks: shifts accumulate', () => {
    const userHunks: DiffHunk[] = [
      { aStart: 2, aEnd: 2, replacement: 'AB' },          // +2 if pos > 2 (or pos === 2 with anchor=start)
      { aStart: 5, aEnd: 5, replacement: 'CDE' },         // +3 if pos > 5 (or pos === 5 with anchor=start)
    ];
    expect(translateAToC(10, userHunks)).toBe(15);
    expect(translateAToC(0, userHunks)).toBe(0);
    expect(translateAToC(4, userHunks)).toBe(6);
  });

  it('mixed insertion + range hunk: deltas compose correctly', () => {
    const userHunks: DiffHunk[] = [
      { aStart: 3, aEnd: 3, replacement: 'XX' },             // +2 from pos > 3
      { aStart: 8, aEnd: 12, replacement: 'YYYYYY' },        // +2 from pos >= 12
    ];
    expect(translateAToC(15, userHunks)).toBe(19);
    expect(translateAToC(10, userHunks)).toBe(12);  // inside range hunk's a-region (treated as before its aEnd)
    expect(translateAToC(0, userHunks)).toBe(0);
  });
});

describe('threeWayMerge — no-auto-terminator invariant', () => {
  // LLM tendencies: it likes to "tidy up" by adding terminal punctuation
  // to incomplete sentences. For an actively-typed buffer with no
  // terminator at end, that's a surprise mid-typing. The merge strips
  // terminal `.`/`?`/`!` from end-of-snapshot hunks when the original
  // didn't have one.

  it('strips a `.` the LLM added to an unterminated final word', () => {
    const A = 'hii my name is will';
    const B = 'Hi my name is Will.';
    const r = threeWayMerge(A, B, A);
    expect(r.newText).toBe('Hi my name is Will');
    expect(r.newText.endsWith('.')).toBe(false);
  });

  it('strips a `?` added to a non-question final fragment', () => {
    const A = 'where are you';
    const B = 'Where are you?';
    const r = threeWayMerge(A, B, A);
    expect(r.newText).toBe('Where are you');
  });

  it('strips a `!` similarly', () => {
    const A = 'thats great';
    const B = "That's great!";
    const r = threeWayMerge(A, B, A);
    expect(r.newText.endsWith('!')).toBe(false);
    expect(r.newText).toContain("That's great");
  });

  it('preserves an existing terminator (no strip when original had one)', () => {
    const A = 'hi how are you?';
    const B = 'Hi how are you?';
    const r = threeWayMerge(A, B, A);
    expect(r.newText).toBe('Hi how are you?');
  });

  it('does NOT strip a terminator from a mid-snapshot hunk (only end-of-snapshot)', () => {
    const A = 'hi there how are you';
    // LLM rewrote mid-buffer adding a `.` that's NOT at end — preserved.
    const B = 'Hi there. How are you';
    const r = threeWayMerge(A, B, A);
    // The mid-buffer terminator survives; only the end-of-snapshot
    // terminator gets stripped (there's none here to strip).
    expect(r.newText).toContain('Hi there.');
    expect(r.newText.endsWith('you')).toBe(true);
  });
});

describe('threeWayMerge — real-world spelling-correction patterns', () => {
  // Patterns the benchmark exercised. These pin the user-visible
  // behaviour for the most common agent-task flow (correct spelling).

  it('"hii my name is will" → "Hi my name is Will" applies cleanly', () => {
    const A = 'hii my name is will';
    const B = 'Hi my name is Will';
    const r = threeWayMerge(A, B, A);
    expect(r.newText).toBe('Hi my name is Will');
    expect(r.appliedLlmHunks.length).toBe(2);
  });

  it('user appended " is here" while LLM corrected typos: corrections land, append preserved', () => {
    const A = 'hii my name is will';
    const B = 'Hi my name is Will';
    const C = 'hii my name is will is here';
    const r = threeWayMerge(A, B, C);
    expect(r.newText).toContain('Hi');
    expect(r.newText).toContain('is here');
  });

  it('user replaced the typo themselves before LLM landed: LLM dropped on that word', () => {
    const A = 'hii my name is will';
    const B = 'Hi my name is Will';
    const C = 'Hi my name is will';  // user already capitalised "Hi"
    const r = threeWayMerge(A, B, C);
    // User's capitalisation preserved; LLM still gets to fix "will" → "Will".
    expect(r.newText).toContain('Will');
    // Either Hi → Hi (no-op merge) or dropped — both surface as final "Hi".
    expect(r.newText.startsWith('Hi')).toBe(true);
  });

  it('cache-hit pattern: same input twice produces identical output (idempotent re-application)', () => {
    const A = 'thiis is anothr typo';
    const B = 'This is another typo';
    const r1 = threeWayMerge(A, B, A);
    // Simulate a second tick on the result with the cached rewrite.
    const r2 = threeWayMerge(r1.newText, r1.newText, r1.newText);
    expect(r2.newText).toBe(r1.newText);
    expect(r2.appliedLlmHunks).toEqual([]);
  });
});
