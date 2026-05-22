/**
 * Pin the duplicated-rewrite detector (May 2026 — long-body bug class).
 *
 * Some models emit a REWRITE that contains the body verbatim twice when
 * given a long body with bracketed placeholders + an instruction-at-start
 * layout ("replace [Your Name] with Wilfred _ <300-char letter>"). The
 * runtime then replaces the whole buffer with the duplicated rewrite and
 * the user sees the body twice.
 *
 * `isLikelyDuplicatedRewrite()` catches this so the FUSED pipeline can
 * fall through to 3-pass (which has a VERIFY step that catches the same
 * class of model failures).
 *
 * Run with: node --test dist/sources/transform-blank-duplicate-rewrite.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { isLikelyDuplicatedRewrite } from './transform-blank-source';

describe('isLikelyDuplicatedRewrite — heuristic for echo-style LLM failures', () => {
  it('flags the modify-resignation-letter live repro pattern', () => {
    // The actual buffer state observed in the May 22 2026 reproduction:
    // body appears once with Wilfred substituted, then verbatim with the
    // original placeholder.
    const dup = `Dear [Manager's Name],\n\nPlease accept this letter as my resignation from my position at [Company Name], effective [Last Working Day]. I am grateful for the opportunities and experiences I have gained while working here, and I wish the team continued success.\n\nSincerely,\nWilfred\n\nPlease accept this letter as my resignation from my position at [Company Name], effective [Last Working Day]. I am grateful for the opportunities and experiences I have gained while working here, and I wish the team continued success.\n\nSincerely,\n[Your Name]`;
    assert.strictEqual(isLikelyDuplicatedRewrite(dup), true);
  });

  it('flags a generic 100-char span repeating twice', () => {
    const block = 'The quick brown fox jumps over the lazy dog and then runs away into the forest before anyone could notice. ';
    assert.strictEqual(block.length > 100, true);
    const dup = block + 'middle separator content here. ' + block;
    assert.strictEqual(isLikelyDuplicatedRewrite(dup), true);
  });

  it('does NOT flag a legitimate single-pass rewrite of the same length', () => {
    // Same letter, BUT with the substitution applied only once and no
    // duplication. Length ~280 chars — exceeds the WINDOW*2 floor but
    // has no 100-char span repeating.
    const clean = `Dear [Manager's Name],\n\nPlease accept this letter as my resignation from my position at [Company Name], effective [Last Working Day]. I am grateful for the opportunities and experiences I have gained while working here, and I wish the team continued success.\n\nSincerely,\nWilfred`;
    assert.strictEqual(isLikelyDuplicatedRewrite(clean), false);
  });

  it('does NOT flag short non-repeating rewrites', () => {
    // Typical word-cue alternatives + short fluid-blank answers MUST
    // never get falsely flagged. Natural short content with no first-
    // chunk repeat and no 100-char window repeat is fine.
    assert.strictEqual(isLikelyDuplicatedRewrite('the cat ran'), false);
    assert.strictEqual(isLikelyDuplicatedRewrite('A short factual answer about the topic at hand for this query.'), false);
    // Note: Layer 1 (first-chunk probe) WILL catch pathological inputs
    // like 'a'.repeat(199) — that's the intended behavior. Real prose
    // never repeats 30-80 char openings within its own body.
  });

  it('does NOT flag long prose with naturally repeated short phrases', () => {
    // Repeated short phrases (under the 100-char WINDOW) are common in
    // real prose — "for example", "in summary", etc. Must not trigger.
    const proseWithShortRepeats = `For example, the project was delayed last quarter. For example, we missed two deadlines. ` +
      `In summary, we need better planning. In summary, we need clearer scope. ` +
      `The team is small but motivated and ready to take on the next big challenge ahead. ` +
      `We have learned from past mistakes and improved our process significantly over time.`;
    assert.strictEqual(proseWithShortRepeats.length > 300, true);
    assert.strictEqual(isLikelyDuplicatedRewrite(proseWithShortRepeats), false);
  });

  it('flags 100+ char duplication near the start (probe-25%)', () => {
    const span = 'The same exact long sentence with at least one hundred characters that will appear twice in a row right here. ';
    const dup = span + span + 'more unique content following the duplicated section to vary the rest of the output.';
    assert.strictEqual(isLikelyDuplicatedRewrite(dup), true);
  });

  it('flags 100+ char duplication near the end (probe-75%)', () => {
    const prefix = 'Unique opening content that introduces the topic without any repetition whatsoever, padded to length. '.repeat(2);
    const span = 'Concluding paragraph with at least one hundred chars that the model accidentally output twice in succession. ';
    const dup = prefix + span + ' interlude ' + span;
    assert.strictEqual(isLikelyDuplicatedRewrite(dup), true);
  });

  // ── Layer 1: first-line / first-chunk repeat ───────────────────────
  // The 100-char sliding window missed the "model restarted the body"
  // pattern where ONLY the first ~40 chars repeat (with new content
  // following). Live repro: poem at 20:49:57 — rewrite started
  // "In whispered breaths the heart confides,\n" then later contained
  // the same 40 chars again. Layer 1 catches this with a shorter
  // first-chunk probe.

  it('flags poem repro: first-line repeats with new content after', () => {
    // Exact pattern from the May 22 2026 chrome log at 20:49:57.
    const firstLine = 'In whispered breaths the heart confides,';
    const dup = `${firstLine}\nTwo souls entwine where shadows glide, and time stands still in love's domain.\n\n${firstLine}\nA second stanza added with completely new content for the paragraph addition request.`;
    assert.strictEqual(isLikelyDuplicatedRewrite(dup), true);
  });

  it('flags shorter first-line repeat (30+ chars)', () => {
    const firstLine = 'Subject: Important meeting today';  // 32 chars
    const dup = `${firstLine}\nFirst body paragraph.\n${firstLine}\nDifferent second body.`;
    assert.strictEqual(isLikelyDuplicatedRewrite(dup), true);
  });

  it('does NOT flag a unique opening line (no first-chunk repeat)', () => {
    const text = `Dear Manager,\nThis is a normal letter body with no repetition of the opening line at all.`;
    assert.strictEqual(isLikelyDuplicatedRewrite(text), false);
  });

  it('does NOT flag when first line is too short (under 30 chars)', () => {
    // Short opening like "Hi.\n" — even if "Hi." appears 5 times in
    // a list, the floor at 30 chars prevents false positives.
    const text = `Hi.\nHi there. Hi friend. Hi everyone. Hi.`;
    assert.strictEqual(isLikelyDuplicatedRewrite(text), false);
  });

  it('does NOT flag when no newline AND text < 30 chars (no first chunk)', () => {
    assert.strictEqual(isLikelyDuplicatedRewrite('short text'), false);
  });

  it('caps first-chunk probe at 80 chars even with long first line', () => {
    // Very long first line should still be probed (using its first 80
    // chars). A 200-char first line repeated would trigger Layer 1.
    const longFirst = 'A first line so long that it exceeds eighty characters and tests the upper cap on the first-chunk probe length';
    const dup = `${longFirst} continues uniquely. ${longFirst} repeats here.`;
    assert.strictEqual(isLikelyDuplicatedRewrite(dup), true);
  });
});
