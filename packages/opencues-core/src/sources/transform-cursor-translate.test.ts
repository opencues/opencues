/**
 * Tests for transform-cursor-translate.ts
 *
 * Run with: node --test dist/sources/transform-cursor-translate.test.js
 *
 * The buffer-cursor → target-cursor translation is what makes positional
 * instructions ("insert X here _") line up correctly inside the APPLY
 * prompt. EXTRACT strips the trigger phrase from the buffer, so the
 * target is shorter than the buffer; we need to figure out where in
 * the target the user's caret would have been.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { translateBufferCursorToTargetCursor } from './transform-cursor-translate';

describe('translateBufferCursorToTargetCursor — guard rails', () => {
  it('returns -1 when bufferCursor is negative (no cursor info)', () => {
    assert.strictEqual(
      translateBufferCursorToTargetCursor('hello world', -1, 'hello'),
      -1,
    );
  });

  it('returns -1 when target is empty', () => {
    assert.strictEqual(
      translateBufferCursorToTargetCursor('hello', 3, ''),
      -1,
    );
  });

  it('returns -1 when buffer is empty (nothing to translate from)', () => {
    assert.strictEqual(
      translateBufferCursorToTargetCursor('', 0, 'hi'),
      -1,
    );
  });
});

describe('translateBufferCursorToTargetCursor — exact substring match (Path A)', () => {
  it('cursor inside the target region: subtracts the target-start offset', () => {
    // Buffer: "add a comma here _ hello world"
    //         |             ^---^  cursor at 6 (right before "comma")
    // Target (after EXTRACT strips trigger): "hello world"
    // Target found at buffer offset 19 → translated = 6 - 19 = clamp(-13, 0, 11) = 0.
    const buffer = 'add a comma here _ hello world';
    const target = 'hello world';
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 6, target),
      0,  // cursor was BEFORE target → clamp to 0
    );
  });

  it('cursor exactly at target-start: returns 0', () => {
    const buffer = 'add _ hello world';   // target = "hello world" at offset 6
    const target = 'hello world';
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 6, target),
      0,
    );
  });

  it('cursor mid-target: returns the target-relative offset', () => {
    const buffer = 'add _ hello world';   // target at offset 6, length 11
    const target = 'hello world';
    // Cursor at buffer-offset 12 = 6 + 6 = mid-target (between "hello " and "world")
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 12, target),
      6,
    );
  });

  it('cursor at the very end of target: returns target.length', () => {
    const buffer = 'add _ hello world';
    const target = 'hello world';
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 17, target),
      11,  // end of "hello world"
    );
  });

  it('cursor past the end of target: clamps to target.length', () => {
    const buffer = 'add _ hello world EXTRA';   // target at offset 6, but cursor at 23
    const target = 'hello world';
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 23, target),
      11,  // clamped to target length
    );
  });

  it('multi-line buffer: substring-match handles newlines', () => {
    const buffer = 'instr _\nline two\nline three';
    const target = 'line two\nline three';
    // Target starts at offset 8 (after "instr _\n")
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 12, target),
      4,  // 12 - 8 = 4 (mid "line")
    );
  });
});

describe('translateBufferCursorToTargetCursor — proportional fallback (Path B)', () => {
  // When the LLM rephrased the target so it's no longer a substring,
  // fall back to a proportional approximation. Lossy but usable.

  it('reshapes-target case: proportional cursor placement', () => {
    const buffer = 'rephrase this _ the original text here';   // 38 chars
    const target = 'completely different rewritten text';      // 35 chars
    // Cursor at buffer offset 19 (middle-ish):
    // ratio = 35/38 ≈ 0.921 → 19 * 0.921 ≈ 17.5 → round to 18.
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 19, target),
      18,
    );
  });

  it('cursor at start: stays at 0 in the proportional fallback', () => {
    const buffer = 'rephrase _ original';
    const target = 'reshaped';
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 0, target),
      0,
    );
  });

  it('cursor at end: clamps to target.length', () => {
    const buffer = 'rephrase _ original';   // 19 chars
    const target = 'reshaped';              // 8 chars
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 19, target),
      8,
    );
  });
});

describe('translateBufferCursorToTargetCursor — boundary cases', () => {
  it('target === buffer: cursor passes through unchanged', () => {
    const text = 'identical text';
    assert.strictEqual(
      translateBufferCursorToTargetCursor(text, 7, text),
      7,
    );
  });

  it('target appears multiple times in buffer: takes the FIRST occurrence', () => {
    // indexOf returns the first match. The translation is anchored to it.
    const buffer = 'abc abc abc _';
    const target = 'abc';
    // First "abc" at offset 0. Cursor at offset 5 → 5 - 0 = 5 → clamp(5, 0, 3) = 3.
    assert.strictEqual(
      translateBufferCursorToTargetCursor(buffer, 5, target),
      3,
    );
  });

  it('cursor at offset 0, target starts at offset 0: returns 0', () => {
    assert.strictEqual(
      translateBufferCursorToTargetCursor('hello', 0, 'hello'),
      0,
    );
  });
});
