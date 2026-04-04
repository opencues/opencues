/**
 * Tests for parsers.ts
 *
 * Run with: node --test dist/sources/parsers.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseMath, parseCompute, parseAnswer, parseAlternatives, parseRaw } from './parsers';

// ---------------------------------------------------------------------------
// parseCompute
// ---------------------------------------------------------------------------

describe('parseMath (safe — no code execution)', () => {
  it('should evaluate basic arithmetic', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=4*12'), ['48']);
  });

  it('should evaluate addition', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=50+30'), ['80']);
  });

  it('should evaluate subtraction', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=100-37'), ['63']);
  });

  it('should evaluate division', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=100/4'), ['25']);
  });

  it('should evaluate parenthesized expressions', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=(80+90+100)/3'), ['90']);
  });

  it('should handle decimal results', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=10/3'), ['3.3333']);
  });

  it('should handle modulo', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=17%5'), ['2']);
  });

  it('should be case-insensitive', () => {
    assert.deepStrictEqual(parseMath('compute = 2+3'), ['5']);
  });

  it('should handle whitespace around equals', () => {
    assert.deepStrictEqual(parseMath('COMPUTE = 7 * 8'), ['56']);
  });

  it('should return empty for non-COMPUTE response', () => {
    assert.deepStrictEqual(parseMath('The answer is 42'), []);
  });

  it('should return empty for empty string', () => {
    assert.deepStrictEqual(parseMath(''), []);
  });

  it('should strip non-numeric characters — no code execution possible', () => {
    // Letters stripped: "alert(1)" → "(1)" → evaluates to 1 (harmless number)
    assert.deepStrictEqual(parseMath('COMPUTE=alert(1)'), ['1']);
    // No digits → empty after strip
    assert.deepStrictEqual(parseMath('COMPUTE=process.exit()'), []);
    // These are harmless — recursive-descent evaluator, not Function():
    assert.deepStrictEqual(parseMath('COMPUTE=require("fs")'), []);
    assert.deepStrictEqual(parseMath('COMPUTE=global.constructor'), []);
    assert.deepStrictEqual(parseMath('COMPUTE=this.__proto__'), []);
  });

  it('should return empty for Infinity', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=1/0'), []);
  });

  it('should handle negative numbers', () => {
    assert.deepStrictEqual(parseMath('COMPUTE=-5*-3'), ['15']);
  });
});

describe('parseCompute (⚠️ unsafe — uses Function())', () => {
  it('should evaluate basic arithmetic', () => {
    assert.deepStrictEqual(parseCompute('COMPUTE=4*12'), ['48']);
  });

  it('should evaluate Math.pow', () => {
    assert.deepStrictEqual(parseCompute('COMPUTE=Math.pow(2,8)'), ['256']);
  });

  it('should evaluate Math.sqrt', () => {
    assert.deepStrictEqual(parseCompute('COMPUTE=Math.sqrt(144)'), ['12']);
  });

  it('should evaluate ternary operator', () => {
    assert.deepStrictEqual(parseCompute('COMPUTE=10>5?10:5'), ['10']);
  });

  it('should return empty for non-numeric result', () => {
    assert.deepStrictEqual(parseCompute('COMPUTE="hello"'), []);
  });

  it('should return empty on error', () => {
    assert.deepStrictEqual(parseCompute('COMPUTE=invalidSyntax((('), []);
  });
});

// ---------------------------------------------------------------------------
// parseAnswer
// ---------------------------------------------------------------------------

describe('parseAnswer', () => {
  it('should extract simple answer', () => {
    assert.deepStrictEqual(parseAnswer('ANSWER=Paris'), ['Paris']);
  });

  it('should extract multi-word answer', () => {
    assert.deepStrictEqual(parseAnswer('ANSWER=Tim Cook'), ['Tim Cook']);
  });

  it('should extract numeric answer', () => {
    assert.deepStrictEqual(parseAnswer('ANSWER=1945'), ['1945']);
  });

  it('should be case-insensitive', () => {
    assert.deepStrictEqual(parseAnswer('answer = Au'), ['Au']);
  });

  it('should handle whitespace around equals', () => {
    assert.deepStrictEqual(parseAnswer('ANSWER =  Mount Everest'), ['Mount Everest']);
  });

  it('should return empty for non-ANSWER response', () => {
    assert.deepStrictEqual(parseAnswer('The answer is Paris'), []);
  });

  it('should return empty for empty string', () => {
    assert.deepStrictEqual(parseAnswer(''), []);
  });

  it('should return empty for overly long answers (>100 chars)', () => {
    assert.deepStrictEqual(parseAnswer('ANSWER=' + 'x'.repeat(101)), []);
  });

  it('should return empty for empty answer value', () => {
    assert.deepStrictEqual(parseAnswer('ANSWER='), []);
  });

  it('should handle answer with special characters', () => {
    assert.deepStrictEqual(parseAnswer('ANSWER=J.K. Rowling'), ['J.K. Rowling']);
  });
});

// ---------------------------------------------------------------------------
// parseAlternatives
// ---------------------------------------------------------------------------

describe('parseAlternatives', () => {
  it('should parse single index with colon separator', () => {
    const results = parseAlternatives('2:big,small,brown', ['The', 'old', 'dog']);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].wordIndex, 2);
    assert.strictEqual(results[0].word, 'dog');
    assert.deepStrictEqual(results[0].alternatives, ['dog', 'big', 'small', 'brown']);
  });

  it('should parse single index with equals separator', () => {
    const results = parseAlternatives('1=walked,ran,sprinted', ['She', 'walked', 'home']);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].wordIndex, 1);
    assert.deepStrictEqual(results[0].alternatives, ['walked', 'walked', 'ran', 'sprinted']);
  });

  it('should parse multiple indices', () => {
    const results = parseAlternatives(
      '0:A,The,My\n2:ran,walked,sprinted',
      ['The', 'dog', 'ran']
    );
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].wordIndex, 0);
    assert.strictEqual(results[1].wordIndex, 2);
  });

  it('should not prepend original for blank positions', () => {
    const results = parseAlternatives('2:fence,wall,hedge', ['The', 'boy', '_']);
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].alternatives, ['fence', 'wall', 'hedge']);
  });

  it('should prepend original for regular word positions', () => {
    const results = parseAlternatives('1:cat,puppy', ['The', 'dog', 'ran']);
    assert.strictEqual(results[0].alternatives[0], 'dog');
    assert.ok(results[0].alternatives.includes('cat'));
  });

  it('should skip number positions', () => {
    const results = parseAlternatives('0:five,many\n1:dogs,cats', ['5', 'dogs']);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].wordIndex, 1);
  });

  it('should skip negative number positions', () => {
    const results = parseAlternatives('0:positive,big', ['-3', 'items']);
    assert.strictEqual(results.length, 0);
  });

  it('should skip decimal number positions', () => {
    const results = parseAlternatives('0:four,five', ['3.5', 'hours']);
    assert.strictEqual(results.length, 0);
  });

  it('should skip out-of-bounds indices', () => {
    const results = parseAlternatives('5:big,small', ['The', 'dog']);
    assert.strictEqual(results.length, 0);
  });

  it('should skip entries with empty alternatives', () => {
    const results = parseAlternatives('0:', ['The', 'dog']);
    assert.strictEqual(results.length, 0);
  });

  it('should handle empty response', () => {
    const results = parseAlternatives('', ['hello', 'world']);
    assert.strictEqual(results.length, 0);
  });

  it('should handle whitespace in alternatives', () => {
    const results = parseAlternatives('0: big , small , brown ', ['The']);
    assert.ok(results[0].alternatives.includes('big'));
    assert.ok(results[0].alternatives.includes('small'));
    assert.ok(results[0].alternatives.includes('brown'));
  });

  it('should handle multi-word alternatives for blanks', () => {
    const results = parseAlternatives('1:Jeff Bezos,Elon Musk', ['The', '_', 'founded']);
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].alternatives.includes('Jeff Bezos'));
    assert.ok(results[0].alternatives.includes('Elon Musk'));
  });

  it('should handle LLM preamble before the actual results', () => {
    const response = 'Here are the alternatives:\n0:big,small\n1:ran,walked';
    const results = parseAlternatives(response, ['The', 'dog']);
    assert.strictEqual(results.length, 2);
  });
});

// ---------------------------------------------------------------------------
// parseRaw
// ---------------------------------------------------------------------------

describe('parseRaw', () => {
  it('should return trimmed response as single-element array', () => {
    assert.deepStrictEqual(parseRaw('Hello World'), ['Hello World']);
  });

  it('should trim whitespace', () => {
    assert.deepStrictEqual(parseRaw('  spaced  '), ['spaced']);
  });

  it('should return empty array for empty response', () => {
    assert.deepStrictEqual(parseRaw(''), []);
  });

  it('should return empty array for whitespace-only response', () => {
    assert.deepStrictEqual(parseRaw('   \n  '), []);
  });

  it('should preserve multiline content', () => {
    const result = parseRaw('line 1\nline 2');
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].includes('line 1'));
    assert.ok(result[0].includes('line 2'));
  });
});
