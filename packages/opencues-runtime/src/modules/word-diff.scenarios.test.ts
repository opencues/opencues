/**
 * Live-typing integration scenarios for the three-way merge.
 *
 * The bar: user typing during the LLM call must NEVER be clobbered.
 * The merge should land LLM edits where they're safe and silently
 * skip them where the user has been working.
 *
 * Each scenario simulates a realistic episode:
 *   - LLM sees A (snapshot), proposes B (rewrite).
 *   - User types during the call → live buffer becomes C.
 *   - We merge → newText. Assert what survives.
 */
import { describe, expect, it } from 'vitest';
import { threeWayMerge } from './word-diff';

describe('three-way merge — live typing scenarios', () => {
  it('user appended a sentence during the LLM call: LLM\'s typo fix lands, user\'s sentence preserved', () => {
    const A = 'I rite stuff. Now I am writing.';
    const B = 'I write stuff. Now I am writing.';                       // LLM fixed rite
    const C = 'I rite stuff. Now I am writing. And more here.';         // user added "And more here."
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('I write stuff. Now I am writing. And more here.');
  });

  it('user fixed the same typo themselves before LLM responded: LLM dropped, user\'s correction kept', () => {
    const A = 'I rite stuff';
    const B = 'I write stuff';                                          // LLM fix
    const C = 'I writed stuff';                                         // user typed something different
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('I writed stuff');                           // user wins
    expect(m.droppedLlmHunks.length).toBe(1);
  });

  it('user appended at end of paragraph during LLM call: word-level LLM fixes upstream still land', () => {
    // LLM rewrote both paragraphs. User added "Adding more here." at
    // the end of para 1. The user's insertion (point hunk at "typoo.")
    // doesn't overlap any LLM hunk's char range — every LLM word-fix
    // applies cleanly, AND the user's appended text survives intact.
    const A = 'first para has typoo.\n\nsecond para is here.';
    const B = 'first paragraph has typo.\n\nsecond paragraph is here.';
    const C = 'first para has typoo. Adding more here.\n\nsecond para is here.';
    const m = threeWayMerge(A, B, C);
    // Both LLM edits land + user content survives:
    expect(m.newText).toBe('first paragraph has typo. Adding more here.\n\nsecond paragraph is here.');
  });

  it('user typed INSIDE the same word LLM is fixing: LLM dropped on that word, others land', () => {
    // LLM fixes both "para → paragraph" instances. User started typing
    // INSIDE para 1's first "para" (e.g. backspaced and retyped),
    // producing a user hunk that overlaps the same word. Para 2's LLM
    // edit still applies.
    const A = 'first para has typoo.\n\nsecond para is here.';
    const B = 'first paragraph has typo.\n\nsecond paragraph is here.';
    const C = 'first parar has typoo.\n\nsecond para is here.';        // user mangled "para" in p1
    const m = threeWayMerge(A, B, C);
    // Para 2 fix lands.
    expect(m.newText).toContain('second paragraph is here.');
    // Para 1's mangled "parar" survives (user wins on that word).
    expect(m.newText).toContain('first parar');
  });

  it('LLM rewrote everything; user typed at the very end: most LLM edits land, user\'s tail survives', () => {
    const A = 'hii my namee is wilfred';
    const B = 'Hi, my name is Wilfred.';
    const C = 'hii my namee is wilfred and';                            // user typing past end
    const m = threeWayMerge(A, B, C);
    // User's "and" survives no matter what LLM did.
    expect(m.newText).toContain('and');
    // At least the typo at "namee" or "hii" or "wilfred" should fix —
    // user only touched the END.
    expect(m.appliedLlmHunks.length).toBeGreaterThan(0);
  });

  it('user erased text during LLM call: LLM\'s edits to the erased region dropped', () => {
    const A = 'first sentence here. second sentence too.';
    const B = 'first sentence here! Second sentence, too.';
    const C = 'first sentence here.';                                    // user deleted second sentence
    const m = threeWayMerge(A, B, C);
    // Whatever survives, we must NOT resurrect the deleted second sentence.
    expect(m.newText).not.toContain('Second sentence');
    expect(m.newText).not.toContain('second sentence');
  });

  it('user typed identical content to what LLM proposed: idempotent merge', () => {
    // LLM proposed "I write stuff", user also fixed it to "I write stuff" themselves.
    // The merge: snapshot=A, B=C in this region — no conflict, no-op survives.
    const A = 'I rite stuff';
    const B = 'I write stuff';
    const C = 'I write stuff';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('I write stuff');
  });

  it('LLM fix at start, user typing at end: both land', () => {
    const A = 'rite this please';
    const B = 'write this please';
    const C = 'rite this please now';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('write this please now');
  });

  it('LLM fix at end, user typing at start: both land', () => {
    const A = 'please rite';
    const B = 'please write';
    const C = 'now please rite';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('now please write');
  });

  it('LLM emits NO changes (clean doc), user typed during call: live preserved', () => {
    const A = 'this is fine';
    const B = 'this is fine';
    const C = 'this is fine and';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('this is fine and');
    expect(m.appliedLlmHunks.length).toBe(0);
  });

  it('user typed nothing during call (clean apply): full LLM rewrite lands', () => {
    const A = 'hii myy namee';
    const B = 'Hi, my name';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('Hi, my name');
  });

  it('user typed within an already-pending word: LLM dropped, user wins', () => {
    // A had "intresting", LLM wanted "interesting", user typed "intristing"
    // (further deviation). User's intristing wins, LLM dropped.
    const A = 'Very intresting';
    const B = 'Very interesting';
    const C = 'Very intristing';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('Very intristing');
  });

  it('paragraph break boundary respected — LLM edits in para A apply even when user is in para B', () => {
    const A = 'I rite this.\n\nNow am writing';
    const B = 'I write this.\n\nNow I am writing';                        // two LLM edits
    const C = 'I rite this.\n\nNow am writing more here';                 // user typed in para B
    const m = threeWayMerge(A, B, C);
    // LLM's para A fix lands; user's para B continuation preserved.
    expect(m.newText).toContain('I write this.');
    expect(m.newText).toContain('more here');
  });
});

describe('three-way merge — whitespace-structural cases', () => {
  it('user added a paragraph break only: structure preserved + LLM word edits land', () => {
    const A = 'first sentence. second sentence.';
    const B = 'First sentence. Second sentence.';
    const C = 'first sentence.\n\nsecond sentence.';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toContain('\n\n');
    expect(m.newText).toContain('First sentence.');
    expect(m.newText).toContain('Second sentence.');
  });

  it('user joined two paragraphs (removed \\n\\n): join preserved', () => {
    const A = 'first.\n\nsecond.';
    const B = 'First.\n\nSecond.';                                       // LLM only capitalised
    const C = 'first. second.';                                          // user joined
    const m = threeWayMerge(A, B, C);
    expect(m.newText).not.toContain('\n\n');
    expect(m.newText).toContain('First.');
    expect(m.newText).toContain('Second.');
  });

  it('user added a single newline mid-buffer', () => {
    const A = 'line one line two';
    const B = 'Line One Line Two';
    const C = 'line one\nline two';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toContain('\n');
    expect(m.newText).toContain('Line One');
    expect(m.newText).toContain('Line Two');
  });

  it('user added indentation: indentation preserved', () => {
    const A = 'rite stuff';
    const B = 'write stuff';
    const C = '  rite stuff';
    const m = threeWayMerge(A, B, C);
    expect(m.newText.startsWith('  ')).toBe(true);
    expect(m.newText).toContain('write');
  });

  it('whitespace-only conflict: user vs LLM both changed the same gap', () => {
    // Both user and LLM changed " " to something different. User wins.
    const A = 'a b';
    const B = 'a\tb';            // LLM wants tab
    const C = 'a\nb';            // user typed newline
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('a\nb');                                       // user wins
  });

  it('user added trailing whitespace: preserved', () => {
    const A = 'hello';
    const B = 'Hello';
    const C = 'hello   ';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('Hello   ');
  });
});

describe('three-way merge — multi-region scenarios', () => {
  it('LLM has edits in regions 1 + 3, user typed in region 2: regions 1+3 land, region 2 preserved', () => {
    const A = 'rite stuff. and witth typos. and morre errors.';
    const B = 'write stuff. and with typos. and more errors.';
    const C = 'rite stuff. and witth typos AND USER TEXT. and morre errors.';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toContain('USER TEXT');
    expect(m.newText).toContain('write stuff');                           // region 1 fix lands
    expect(m.newText).toContain('more errors');                           // region 3 fix lands
  });

  it('LLM rewrites entire doc, user adds tail only: tail preserved + most LLM lands', () => {
    const A = 'one two three four five';
    const B = 'ONE TWO THREE FOUR FIVE';
    const C = 'one two three four five and SIX';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toContain('and SIX');
    expect(m.appliedLlmHunks.length).toBeGreaterThan(0);
  });

  it('LLM rewrite + user multi-edit at different positions: both survive', () => {
    const A = 'aa bb cc';
    const B = 'AA BB CC';
    const C = 'AA bb cc!';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toContain('AA');
    expect(m.newText).toContain('!');
  });
});

describe('three-way merge — trailing-whitespace preservation', () => {
  // Production bug: LLM rewrote "food? " → "food?" (trimmed trailing
  // space). User had to keep retyping the space. Fix: when a hunk
  // reaches end-of-snapshot and would shorten trailing whitespace,
  // append the missing whitespace back onto the replacement.

  it('preserves a trailing space the LLM trimmed', () => {
    const A = 'food? ';
    const B = 'food?';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('food? ');
  });

  it('preserves a trailing newline the LLM trimmed', () => {
    const A = 'food?\n';
    const B = 'food?';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('food?\n');
  });

  it('preserves trailing whitespace WHILE applying a word edit at end-of-buffer', () => {
    // LLM: "food? " → "Food?" (capitalisation + trim space).
    // We restore the trimmed trailing space onto the replacement.
    const A = 'food? ';
    const B = 'Food?';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('Food? ');                                     // capitalised AND space preserved
  });

  it('preserves multi-char trailing whitespace ("? \\n " → trailing chars kept)', () => {
    const A = 'food? \n ';
    const B = 'food?';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('food? \n ');
  });

  it('does NOT add whitespace where there was none', () => {
    const A = 'food?';
    const B = 'food?';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('food?');                                      // no spurious space
  });

  it('LLM grew trailing whitespace: that lands (no restore needed)', () => {
    const A = 'food?';
    const B = 'food? ';                                                   // LLM added space
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('food? ');
  });

  it('non-trailing edit unaffected by the restore logic', () => {
    const A = 'I rite stuff. ';
    const B = 'I write stuff. ';                                          // non-trailing edit; trailing preserved either way
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('I write stuff. ');
  });

  it('user has typed trailing whitespace AND content past it: restore doesn\'t double-add', () => {
    // Snapshot has "food? " (trailing space). User typed " more" past
    // it → live "food?  more". The restore logic could over-eagerly add
    // back the trimmed space, double-spacing. Verify it doesn't.
    const A = 'food? ';
    const B = 'food?';
    const C = 'food?  more';                                              // user typed " more"
    const m = threeWayMerge(A, B, C);
    // The boundary-deletion-vs-insertion guard (added earlier) should
    // already drop the trim hunk because the user has content past it.
    // So no restore needed — trim simply doesn't apply. Buffer = live.
    expect(m.newText).toBe('food?  more');
  });
});

describe('three-way merge — paragraph-break preservation guard', () => {
  // The LLM sometimes collapses paragraph breaks (\n\n) into single
  // newlines or removes them entirely as a "canonicalisation". This
  // gates against that: any LLM hunk whose original text contains a
  // \n\n that the replacement doesn't preserve gets dropped.

  it('drops an LLM hunk that would collapse \\n\\n into \\n', () => {
    const A = 'first.\n\nsecond.';
    const B = 'first.\nsecond.';                                          // LLM collapsed \n\n to \n
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe(A);                                            // user's structure preserved
    expect(m.droppedLlmHunks.length).toBeGreaterThan(0);
  });

  it('drops an LLM hunk that would remove \\n\\n entirely', () => {
    const A = 'first.\n\nsecond.';
    const B = 'first. second.';                                           // LLM joined paragraphs
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe(A);
  });

  it('allows LLM hunk that GROWS newlines (single \\n → \\n\\n)', () => {
    const A = 'first.\nsecond.';
    const B = 'first.\n\nsecond.';                                        // LLM made paragraph break
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('first.\n\nsecond.');
  });

  it('allows LLM hunk that preserves \\n\\n while changing words', () => {
    const A = 'first.\n\nsecond.';
    const B = 'First.\n\nSecond.';                                        // capitalisation only, \n\n preserved
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('First.\n\nSecond.');
  });

  it('triple-newline + user typing: structure preserved if LLM hunk does not collapse', () => {
    const A = 'first.\n\n\nsecond.';                                      // three newlines
    const B = 'First.\n\n\nSecond.';                                      // preserved
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('First.\n\n\nSecond.');
  });

  it('drops LLM hunk that would reduce \\n\\n\\n to \\n', () => {
    const A = 'first.\n\n\nsecond.';
    const B = 'first.\nsecond.';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe(A);
  });
});

describe('three-way merge — boundary deletion + user insertion (whitespace separator class)', () => {
  // Production bug (May 2026): snapshot was "Hi my name. " (trailing
  // space). LLM rewrote to "Hi my name." (deleted the trailing space).
  // User had typed " is wilfred" appending. Merge applied both,
  // concatenating: "Hi my name.is wilfred" — missing separator.
  // Fix: treat deletion-touching-insertion at boundary as overlap.

  it('LLM deleted trailing whitespace + user appended: deletion dropped, separator preserved', () => {
    const A = 'Hi my name. ';
    const B = 'Hi my name.';
    const C = 'Hi my name. is wilfred';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('Hi my name. is wilfred');
  });

  it('LLM deleted leading whitespace + user prepended: deletion dropped', () => {
    const A = '  greeting';
    const B = 'greeting';
    const C = 'Hello,   greeting';                                       // user prepended at start
    const m = threeWayMerge(A, B, C);
    // The deletion-vs-insertion-boundary check drops the LLM deletion.
    expect(m.newText).toContain('Hello,');
    // Whitespace separator survives somewhere between "Hello," and "greeting".
    expect(m.newText).toMatch(/Hello,.*greeting/);
  });

  it('LLM deleted internal whitespace + user typed at boundary: deletion dropped', () => {
    const A = 'a b';
    const B = 'ab';                                                      // LLM joined
    const C = 'a USER b';                                                // user inserted "USER"
    const m = threeWayMerge(A, B, C);
    // User content survives; LLM's join would have removed user's separator.
    expect(m.newText).toContain('USER');
    expect(m.newText).toMatch(/a.+b/);
  });

  it('LLM substitution touching insertion boundary: substitution lands (not a deletion)', () => {
    // Substitutions at the boundary are still safe — the replacement
    // text serves as content + separator. Only DELETIONS conflict.
    const A = 'rite';
    const B = 'write';                                                   // substitution, not delete
    const C = 'rite stuff';                                              // user appended
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('write stuff');
  });
});

describe('three-way merge — adversarial / edge cases', () => {
  it('A and B are identical, C diverged: live preserved as-is', () => {
    const A = 'unchanged text';
    const B = A;
    const C = 'unchanged text plus addition';
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('unchanged text plus addition');
    expect(m.appliedLlmHunks.length).toBe(0);
  });

  it('A and C are identical, B diverged: full LLM rewrite lands', () => {
    const A = 'rite stuff';
    const B = 'write stuff';
    const C = A;
    const m = threeWayMerge(A, B, C);
    expect(m.newText).toBe('write stuff');
  });

  it('all three (A, B, C) are identical: no-op', () => {
    const A = 'clean';
    const m = threeWayMerge(A, A, A);
    expect(m.newText).toBe('clean');
    expect(m.appliedLlmHunks.length).toBe(0);
  });

  it('empty everything: stays empty', () => {
    const m = threeWayMerge('', '', '');
    expect(m.newText).toBe('');
  });

  it('user wiped buffer: LLM\'s rewrite of the original text doesn\'t resurrect it', () => {
    const A = 'lots of content here';
    const B = 'Lots of content here.';
    const C = '';
    const m = threeWayMerge(A, B, C);
    // LLM hunks all overlap user's deletion-of-everything → all dropped.
    expect(m.newText).toBe('');
  });

  it('user duplicated their own buffer (paste): partial LLM edits may land safely', () => {
    const A = 'hello';
    const B = 'Hello';
    const C = 'hello hello';                                              // user duplicated
    const m = threeWayMerge(A, B, C);
    // The user's append is a hunk; LLM hunk in region [0,5) of A.
    // Whether LLM lands depends on overlap; what we MUST guarantee is
    // user's "hello hello" structure isn't corrupted.
    expect(m.newText).toMatch(/hello/i);
    expect(m.newText.length).toBeGreaterThanOrEqual(10);                 // user's two-word version preserved
  });

  it('round-trip: a→b applied then merged back doesn\'t reintroduce changes', () => {
    const A = 'rite stuff';
    const B = 'write stuff';
    // Round 1: apply A→B
    const round1 = threeWayMerge(A, B, A).newText;
    expect(round1).toBe('write stuff');
    // Round 2: snapshot is now B-equivalent, LLM might rewrite again,
    // but if no new task there are no edits → merge no-op.
    const round2 = threeWayMerge(round1, round1, round1).newText;
    expect(round2).toBe('write stuff');
  });

  it('long text with single-word edit: only that hunk emitted', () => {
    const longA = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const longB = longA.replace('word50', 'WORD50');
    const m = threeWayMerge(longA, longB, longA);
    expect(m.newText).toContain('WORD50');
    expect(m.appliedLlmHunks.length).toBe(1);
  });
});
