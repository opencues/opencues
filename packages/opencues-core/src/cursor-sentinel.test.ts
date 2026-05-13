/**
 * Tests for cursor-sentinel.ts
 *
 * Run with: node --test dist/cursor-sentinel.test.js
 *
 * Pins the shared cursor-sentinel API. Both @opencues/core's
 * TransformBlankSource and @opencues/runtime's AgentRewrite consume
 * these — if anything here breaks, both pipelines lose their cursor
 * grounding.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  CURSOR_SENTINEL,
  stripCursorSentinel,
  injectCursorSentinel,
} from './cursor-sentinel';

describe('CURSOR_SENTINEL constant', () => {
  it('is the literal "[CURSOR]"', () => {
    assert.strictEqual(CURSOR_SENTINEL, '[CURSOR]');
  });

  it('is a string (frozen by const at the type level; runtime check)', () => {
    assert.strictEqual(typeof CURSOR_SENTINEL, 'string');
  });
});

describe('stripCursorSentinel', () => {
  it('removes a single [CURSOR] occurrence', () => {
    assert.strictEqual(stripCursorSentinel('hello [CURSOR] world'), 'hello  world');
  });

  it('removes multiple occurrences in one pass', () => {
    assert.strictEqual(
      stripCursorSentinel('[CURSOR]hi[CURSOR]there[CURSOR]'),
      'hithere',
    );
  });

  it('also strips lower-case [cursor] (model mangled the case)', () => {
    assert.strictEqual(stripCursorSentinel('hi [cursor] there'), 'hi  there');
  });

  it('strips MIXED case occurrences in the same string', () => {
    assert.strictEqual(
      stripCursorSentinel('a [CURSOR] b [cursor] c'),
      'a  b  c',
    );
  });

  it('no-op when sentinel absent', () => {
    assert.strictEqual(stripCursorSentinel('hello world'), 'hello world');
  });

  it('no-op on empty string', () => {
    assert.strictEqual(stripCursorSentinel(''), '');
  });

  it('does NOT strip partial matches (`[CURSO]`, `[CURSORX]`, `CURSOR`)', () => {
    assert.strictEqual(stripCursorSentinel('[CURSO] [CURSORX] CURSOR'),
      '[CURSO] [CURSORX] CURSOR');
  });

  it('strips sentinel even when nested inside markdown / code fences', () => {
    // Models occasionally wrap output in code fences. The strip must
    // still find the sentinel.
    assert.strictEqual(
      stripCursorSentinel('```\nhello [CURSOR] world\n```'),
      '```\nhello  world\n```',
    );
  });

  it('preserves surrounding whitespace exactly (no trimming)', () => {
    assert.strictEqual(stripCursorSentinel('  [CURSOR]  '), '    ');
  });
});

describe('injectCursorSentinel', () => {
  it('inserts at offset 0 (start of string)', () => {
    assert.strictEqual(injectCursorSentinel('hello', 0), '[CURSOR]hello');
  });

  it('inserts at the END of the string', () => {
    assert.strictEqual(injectCursorSentinel('hello', 5), 'hello[CURSOR]');
  });

  it('inserts mid-string', () => {
    assert.strictEqual(injectCursorSentinel('hello world', 6), 'hello [CURSOR]world');
  });

  it('inserts at offset === length (between last char and EOL)', () => {
    assert.strictEqual(injectCursorSentinel('abc', 3), 'abc[CURSOR]');
  });

  it('clamps an offset past the end to the end', () => {
    assert.strictEqual(injectCursorSentinel('hi', 999), 'hi[CURSOR]');
  });

  it('returns input unchanged when offset is null', () => {
    assert.strictEqual(injectCursorSentinel('hello', null), 'hello');
  });

  it('returns input unchanged when offset is undefined', () => {
    assert.strictEqual(injectCursorSentinel('hello', undefined), 'hello');
  });

  it('returns input unchanged when offset is negative (cursor-blind)', () => {
    assert.strictEqual(injectCursorSentinel('hello', -1), 'hello');
    assert.strictEqual(injectCursorSentinel('hello', -100), 'hello');
  });

  it('works on the empty string', () => {
    assert.strictEqual(injectCursorSentinel('', 0), '[CURSOR]');
  });

  it('survives a round-trip — inject then strip yields the original', () => {
    const cases = [
      ['', 0],
      ['hello', 0],
      ['hello', 2],
      ['hello', 5],
      ['multi-line\ntext', 7],
    ] as const;
    for (const [text, off] of cases) {
      const injected = injectCursorSentinel(text, off);
      assert.strictEqual(stripCursorSentinel(injected), text, `roundtrip ${JSON.stringify(text)}@${off}`);
    }
  });
});
