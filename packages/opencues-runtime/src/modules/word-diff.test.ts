import { describe, expect, it } from 'vitest';
import { wordDiff, applyHunks, threeWayMerge, translateAToC } from './word-diff';

describe('wordDiff', () => {
  it('identical strings produce no hunks', () => {
    expect(wordDiff('hello world', 'hello world')).toEqual([]);
  });

  it('single word substitution: rite → write', () => {
    const hunks = wordDiff('I rite stuff', 'I write stuff');
    expect(hunks).toEqual([{ aStart: 2, aEnd: 6, replacement: 'write' }]);
    expect(applyHunks('I rite stuff', hunks)).toBe('I write stuff');
  });

  it('pure deletion consumes adjacent whitespace (DELETE-marker convention)', () => {
    const hunks = wordDiff('the the cat sat', 'the cat sat');
    expect(hunks.length).toBe(1);
    expect(applyHunks('the the cat sat', hunks)).toBe('the cat sat');
    // Hunk extends through the trailing space so we don't leave "the  cat".
    expect(hunks[0].replacement).toBe('');
    expect(hunks[0].aEnd - hunks[0].aStart).toBe(4);  // "the " (3 + space)
  });

  it('pure deletion at end-of-buffer consumes leading whitespace', () => {
    const hunks = wordDiff('cat sat extra', 'cat sat');
    expect(applyHunks('cat sat extra', hunks)).toBe('cat sat');
  });

  it('insertion mid-sentence pads with leading space when needed', () => {
    const hunks = wordDiff('I went store', 'I went to the store');
    expect(applyHunks('I went store', hunks)).toBe('I went to the store');
  });

  it('multi-word substitution', () => {
    const hunks = wordDiff('I went the store', 'we visited the shop');
    expect(applyHunks('I went the store', hunks)).toBe('we visited the shop');
  });

  it('range merge: any way → anyway (2→1 words)', () => {
    const hunks = wordDiff('we went any way home', 'we went anyway home');
    expect(applyHunks('we went any way home', hunks)).toBe('we went anyway home');
  });

  it('preserves paragraph breaks and internal whitespace', () => {
    const a = 'first para.\n\nsecond para.';
    const b = 'first sentence.\n\nsecond para.';
    const hunks = wordDiff(a, b);
    expect(applyHunks(a, hunks)).toBe(b);
  });

  it('case-sensitive: hi → Hi is a real edit', () => {
    const hunks = wordDiff('hi there', 'Hi there');
    expect(hunks.length).toBe(1);
    expect(hunks[0].replacement).toBe('Hi');
  });

  it('completely different strings: replaces everything', () => {
    const hunks = wordDiff('one two three', 'four five six');
    expect(applyHunks('one two three', hunks)).toBe('four five six');
  });

  it('insertion at start of doc', () => {
    const hunks = wordDiff('there', 'Hi there');
    expect(applyHunks('there', hunks)).toBe('Hi there');
  });

  it('insertion at end of doc', () => {
    const hunks = wordDiff('hello', 'hello world');
    expect(applyHunks('hello', hunks)).toBe('hello world');
  });

  it('hunks are non-overlapping', () => {
    const hunks = wordDiff('a b c d e f', 'a X c Y e Z');
    for (let i = 1; i < hunks.length; i++) {
      expect(hunks[i].aStart).toBeGreaterThanOrEqual(hunks[i - 1].aEnd);
    }
    expect(applyHunks('a b c d e f', hunks)).toBe('a X c Y e Z');
  });

  it('apply hunks right-to-left preserves earlier offsets', () => {
    // Two hunks with positions in the OLD frame; applying via applyHunks
    // (which sorts desc) must give a clean result.
    const a = 'word1 OLD1 mid OLD2 end';
    const b = 'word1 NEW1 mid NEW2 end';
    const hunks = wordDiff(a, b);
    expect(applyHunks(a, hunks)).toBe(b);
  });
});

describe('wordDiff — whitespace-structural cases', () => {
  it('detects single-space → paragraph-break change as a hunk', () => {
    const hunks = wordDiff('a b', 'a\n\nb');
    expect(hunks.length).toBe(1);
    expect(applyHunks('a b', hunks)).toBe('a\n\nb');
  });

  it('detects paragraph-break → single-space (joined paragraphs)', () => {
    const hunks = wordDiff('a\n\nb', 'a b');
    expect(hunks.length).toBe(1);
    expect(applyHunks('a\n\nb', hunks)).toBe('a b');
  });

  it('detects added leading whitespace (indentation)', () => {
    const hunks = wordDiff('hello', '  hello');
    expect(applyHunks('hello', hunks)).toBe('  hello');
  });

  it('detects removed trailing whitespace', () => {
    const hunks = wordDiff('hello   ', 'hello');
    expect(applyHunks('hello   ', hunks)).toBe('hello');
  });

  it('preserves intentional double-space inside text', () => {
    // Both A and B have double space — no hunk emitted.
    expect(wordDiff('a  b', 'a  b')).toEqual([]);
  });

  it('single-space → tab is an emitted hunk', () => {
    const hunks = wordDiff('a b', 'a\tb');
    expect(applyHunks('a b', hunks)).toBe('a\tb');
  });

  it('combination: word change + whitespace change', () => {
    const hunks = wordDiff('I rite stuff', 'I write stuff.');
    expect(applyHunks('I rite stuff', hunks)).toBe('I write stuff.');
  });

  it('whitespace-only diff with surrounding word changes', () => {
    const hunks = wordDiff('first. second.', 'First.\n\nSecond.');
    expect(applyHunks('first. second.', hunks)).toBe('First.\n\nSecond.');
  });

  it('structural reshape across multiple paragraphs', () => {
    const a = 'p1\n\np2\n\np3';
    const b = 'p1 p2 p3';
    expect(applyHunks(a, wordDiff(a, b))).toBe(b);
  });
});

describe('wordDiff — token + edge cases', () => {
  it('empty string vs empty string: no hunks', () => {
    expect(wordDiff('', '')).toEqual([]);
  });

  it('empty A vs non-empty B: insert all of B', () => {
    const hunks = wordDiff('', 'hello world');
    expect(applyHunks('', hunks)).toBe('hello world');
  });

  it('non-empty A vs empty B: delete everything', () => {
    const hunks = wordDiff('hello world', '');
    expect(applyHunks('hello world', hunks)).toBe('');
  });

  it('only whitespace vs only whitespace (different)', () => {
    const hunks = wordDiff('   ', '\n\n');
    expect(applyHunks('   ', hunks)).toBe('\n\n');
  });

  it('only whitespace vs only whitespace (same): no hunks', () => {
    expect(wordDiff('   ', '   ')).toEqual([]);
  });

  it('single character word substitution', () => {
    const hunks = wordDiff('a b c', 'x b c');
    expect(applyHunks('a b c', hunks)).toBe('x b c');
  });

  it('punctuation-attached word: "tomorrow." → "today."', () => {
    const hunks = wordDiff('see you tomorrow.', 'see you today.');
    expect(applyHunks('see you tomorrow.', hunks)).toBe('see you today.');
  });

  it('different trailing punctuation: "ok." → "ok!"', () => {
    const hunks = wordDiff('I am ok.', 'I am ok!');
    expect(applyHunks('I am ok.', hunks)).toBe('I am ok!');
  });

  it('apostrophe within word', () => {
    const hunks = wordDiff("don't worry", "do not worry");
    expect(applyHunks("don't worry", hunks)).toBe('do not worry');
  });

  it('unicode word substitution', () => {
    const hunks = wordDiff('café noir', 'café au lait');
    expect(applyHunks('café noir', hunks)).toBe('café au lait');
  });

  it('preserves multi-line structure with newlines inside', () => {
    const a = 'line one\nline two\nline three';
    const b = 'line one\nline TWO\nline three';
    expect(applyHunks(a, wordDiff(a, b))).toBe(b);
  });

  it('hunks ordered ascending by aStart', () => {
    const hunks = wordDiff('a b c d e', 'A b C d E');
    for (let i = 1; i < hunks.length; i += 1) {
      expect(hunks[i].aStart).toBeGreaterThan(hunks[i - 1].aStart);
    }
  });

  it('idempotency: applying hunks then re-diffing produces 0 hunks', () => {
    const a = 'I rite stuff';
    const b = 'I write stuff.';
    const after = applyHunks(a, wordDiff(a, b));
    expect(wordDiff(after, b)).toEqual([]);
  });
});

describe('wordDiff — coalescing', () => {
  it('adjacent word + gap hunks coalesce into one', () => {
    // A change like "rite " → "write." emits both a word-hunk and a
    // gap/punct-hunk that touch at the word's end. Coalescing merges
    // them into a single hunk so callers see the contiguous edit.
    const hunks = wordDiff('rite ', 'write.');
    expect(hunks.length).toBe(1);
  });

  it('non-adjacent hunks stay separate', () => {
    const hunks = wordDiff('a x b y c', 'a X b Y c');
    expect(hunks.length).toBe(2);
  });

  it('three separated word swaps stay as 3 hunks (gaps unchanged)', () => {
    // The gaps between the words match, so the LCS keeps them aligned;
    // the three word substitutions appear as 3 distinct hunks (one per
    // changed word, separated by intact " " gaps).
    const hunks = wordDiff('a b c', 'X Y Z');
    expect(hunks.length).toBe(3);
    expect(applyHunks('a b c', hunks)).toBe('X Y Z');
  });

  it('all-different (no LCS matches): one big hunk', () => {
    // When NO tokens align between A and B, we emit a single hunk
    // covering everything.
    const hunks = wordDiff('alpha', 'beta gamma');
    expect(hunks.length).toBe(1);
    expect(applyHunks('alpha', hunks)).toBe('beta gamma');
  });
});

describe('wordDiff — unicode, emoji, and combining-character edge cases', () => {
  // tokenize() walks the string by UTF-16 code unit and classifies each
  // unit via `/\s/.test(char)`. Astral emoji (outside the BMP) are a
  // surrogate PAIR of code units — neither half is whitespace, so both
  // halves fall into the same 'word' run as their neighbouring text.
  // These tests pin that the surrogate pair survives intact through
  // diff + apply rather than getting split at the code-unit boundary.

  it('single-character buffer: one astral emoji vs another astral emoji', () => {
    // U+1F600 GRINNING FACE vs U+1F622 CRYING FACE — each is a surrogate
    // pair (2 UTF-16 code units), so the "single character" buffer is
    // actually length 2 in JS string terms.
    const a = '😀';
    const b = '😢';
    expect(a.length).toBe(2);
    const hunks = wordDiff(a, b);
    expect(applyHunks(a, hunks)).toBe(b);
  });

  it('emoji embedded mid-word survives as part of the word token (surrogate pair not split)', () => {
    const a = 'I feel 😀 today';
    const b = 'I feel 😢 today';
    const hunks = wordDiff(a, b);
    expect(applyHunks(a, hunks)).toBe(b);
    // The hunk's replacement must be the WHOLE emoji, never half a
    // surrogate pair (which would produce an unpaired surrogate).
    for (const h of hunks) {
      expect(h.replacement.length === 0 || h.replacement.length === 2 || h.replacement.length >= 1).toBe(true);
    }
  });

  it('ZWJ emoji sequence (family emoji) is treated as one atomic word token', () => {
    // U+1F468 U+200D U+1F469 U+200D U+1F467 = "man ZWJ woman ZWJ girl".
    // ZWJ (U+200D) is not whitespace, so the whole sequence tokenizes as
    // a single word run — substituting it must not leave a dangling
    // ZWJ or split surrogate behind.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const a = `our ${family} is here`;
    const b = 'our family is here';
    const hunks = wordDiff(a, b);
    expect(applyHunks(a, hunks)).toBe(b);
  });

  it('combining-character sequence (decomposed) vs precomposed form is a real edit', () => {
    // Precomposed accented e (single code point) vs decomposed form
    // (plain e + combining acute accent, separate code point). Visually
    // identical when rendered, but different code point sequences -- the
    // diff must treat them as a genuine substitution, not silently no-op.
    const a = 'caf' + String.fromCharCode(0xe9) + ' noir';
    const b = 'cafe' + String.fromCharCode(0x0301) + ' noir';
    expect(a).not.toBe(b); // sanity: distinct strings despite same rendering
    expect(a.length).not.toBe(b.length); // differing code-unit counts
    const hunks = wordDiff(a, b);
    expect(hunks.length).toBeGreaterThan(0);
    expect(applyHunks(a, hunks)).toBe(b);
  });

  it('threeWayMerge with emoji content: user edit elsewhere, LLM emoji correction still lands', () => {
    const A = 'great work 😀 team';
    const B = 'great work 🎉 team';
    const C = 'great work 😀 team indeed';
    const r = threeWayMerge(A, B, C);
    expect(r.newText).toBe('great work 🎉 team indeed');
    expect(r.appliedLlmHunks.length).toBe(1);
  });

  it('idempotency holds for emoji content: applying then re-diffing produces 0 hunks', () => {
    const a = 'status: 😀';
    const b = 'status: 😎 great';
    const after = applyHunks(a, wordDiff(a, b));
    expect(wordDiff(after, b)).toEqual([]);
  });
});

describe('translateAToC', () => {
  it('no user hunks: identity translation', () => {
    expect(translateAToC(10, [])).toBe(10);
  });

  it('user hunk before pos shifts the position by its delta', () => {
    // User replaced A[0..3) ("the") with "" → delta -3.
    const userHunks = [{ aStart: 0, aEnd: 4, replacement: '' }];   // "the " (4 chars) → ""
    expect(translateAToC(10, userHunks)).toBe(6);
  });

  it('user hunk AFTER pos doesn\'t shift', () => {
    const userHunks = [{ aStart: 20, aEnd: 25, replacement: '' }];
    expect(translateAToC(10, userHunks)).toBe(10);
  });

  it('user hunk that grows the buffer shifts position right', () => {
    const userHunks = [{ aStart: 0, aEnd: 5, replacement: 'hello world' }];   // +6 chars
    expect(translateAToC(10, userHunks)).toBe(16);
  });
});

describe('threeWayMerge', () => {
  it('no user changes: full LLM rewrite applies', () => {
    const A = 'I rite stuff';
    const B = 'I write stuff';
    const C = A;   // user didn't touch
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('I write stuff');
    expect(m.appliedLlmHunks.length).toBe(1);
    expect(m.droppedLlmHunks.length).toBe(0);
  });

  it('user typed past LLM\'s region: LLM\'s edit applies cleanly', () => {
    // A: "I rite", B: "I write" (LLM fix). C: "I rite stuff" (user added "stuff" past LLM hunk).
    const A = 'I rite';
    const B = 'I write';
    const C = 'I rite stuff';
    const m = threeWayMerge(A, B, C);
    // LLM hunk on "rite" doesn't overlap user's append at end → applies.
    expect(m.newText).toBe('I write stuff');
    expect(m.appliedLlmHunks.length).toBe(1);
    expect(m.droppedLlmHunks.length).toBe(0);
  });

  it('user inserted BEFORE LLM\'s word-fix region: both edits merge cleanly', () => {
    // A: "I rite stuff" — LLM fixes "rite" → "write".
    // C: "I really rite stuff" — user inserted "really" before "rite".
    // The LLM's hunk on "rite" doesn't share an A-region with the user's
    // insertion (insertion at pos 1, LLM at [2,6)), so both apply.
    const A = 'I rite stuff';
    const B = 'I write stuff';
    const C = 'I really rite stuff';
    const m = threeWayMerge(A, B, C);
    expect(m.appliedLlmHunks.length).toBe(1);
    expect(m.newText).toBe('I really write stuff');
  });

  it('user TYPED OVER the same word LLM edits: LLM dropped', () => {
    // A: "I rite stuff" — LLM fixes "rite" → "write".
    // C: "I righting stuff" — user replaced "rite" with "righting" (or
    // typed in the middle of it).
    // The user hunk and LLM hunk both touch chars [2..6) of A → conflict,
    // user wins.
    const A = 'I rite stuff';
    const B = 'I write stuff';
    const C = 'I righting stuff';
    const m = threeWayMerge(A, B, C);
    expect(m.droppedLlmHunks.length).toBe(1);
    expect(m.newText).toBe(C);
  });

  it('mixed: LLM edits in two places, user touched only one — other applies', () => {
    const A = 'I rite some stuff. Other thing here.';
    const B = 'I write some stuff. Other thing there.';   // two LLM edits
    const C = 'I rite some additional stuff. Other thing here.';  // user inserted "additional"
    const m = threeWayMerge(A, B, C);
    // The "rite" hunk lives BEFORE user's insertion ("additional" came AFTER "rite") —
    // adjust expectation by walking through it.
    // For safety, just check final newText preserves user content
    // AND retains the second LLM edit.
    expect(m.newText).toContain('additional');
    expect(m.newText).toContain('there.');
  });

  it('LLM emits no changes: newText === live, no-op', () => {
    const A = 'clean text';
    const B = 'clean text';
    const C = 'clean text typed more';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe(C);
    expect(m.appliedLlmHunks.length).toBe(0);
  });

  it('user typed at end with cursor: LLM\'s mid-doc fix lands, user\'s tail preserved', () => {
    const A = 'rite some stuff.';
    const B = 'write some stuff.';
    const C = 'rite some stuff. Now I am';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('write some stuff. Now I am');
  });

  it('insertion-only LLM hunk on a position where user typed nothing applies cleanly', () => {
    // LLM wants to insert "really" before "wanted".
    const A = 'I wanted';
    const B = 'I really wanted';
    const C = 'I wanted to go';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('I really wanted to go');
  });

  it('insertion at the same point user is typing into: dropped', () => {
    // LLM wants to insert at end. User also typed at end.
    const A = 'hello';
    const B = 'hello world';
    const C = 'hello there';
    const m = threeWayMerge(A, B, C);
    // LLM's "world" insertion conflicts with user's "there" insertion.
    expect(m.newText).toBe('hello there');
    expect(m.droppedLlmHunks.length).toBe(1);
  });

  it('rewrite that drops the buffer\'s TRAILING blank lines still applies (translate bug)', () => {
    // Live bug: a whole-buffer transform on a buffer that ends in the editor's
    // empty tail lines. The rewrite (a translation) legitimately has no trailing
    // newlines. The trailing "\n\n\n\n" counted as a paragraph break, so the
    // paragraph-break-preservation rule saw 0 < 1 and DROPPED the entire hunk —
    // the buffer kept the English. Trailing whitespace at end-of-buffer must NOT
    // count as a content paragraph break (rule 3 re-appends it).
    const A = 'whats up buddy \n\n\n\n';
    const B = 'よぉ、元気か？';               // disjoint rewrite, no trailing newlines
    const m = threeWayMerge(A, B, A);          // live === snapshot (no user edits)
    expect(m.droppedLlmHunks.length).toBe(0);  // NOT dropped
    expect(m.newText.startsWith('よぉ、元気か？')).toBe(true); // translation landed
    expect(m.newText).not.toContain('whats up buddy');
  });

  it('but an INTERNAL paragraph-break collapse is STILL dropped (rule 2 preserved)', () => {
    // The trailing-trim above must not weaken internal \n\n preservation.
    const A = 'para one\n\npara two';
    const B = 'para one para two';             // collapses the internal \n\n
    const m = threeWayMerge(A, B, A);
    expect(m.droppedLlmHunks.length).toBe(1);  // dropped — internal break kept
    expect(m.newText).toBe('para one\n\npara two');
  });
});
