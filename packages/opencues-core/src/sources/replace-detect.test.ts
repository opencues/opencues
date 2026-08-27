/**
 * Unit tests for the replace-parse detector's deterministic halves —
 * parseReplaceDetect (four-line output parser) and verifyReplaceDetect
 * (the runtime acceptance gate that decides whether an LLM detection
 * is allowed to drive a bounded splice).
 *
 * Fixtures are deliberately synthetic (zephyr / ALT-ONE style) per the
 * repo rule — these tests pin SHAPES (which gate fired, what got
 * rejected), not believable content.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseReplaceDetect, verifyReplaceDetect } from './replace-detect';

describe('parseReplaceDetect', () => {
  it('parses the four-line shape', () => {
    const det = parseReplaceDetect('CLASS: REPLACE\nCOMMAND: zap it _\nTARGET: zephyr\nVALUE: ALT-ONE');
    assert.deepStrictEqual(det, { cls: 'replace', command: 'zap it _', target: 'zephyr', value: 'ALT-ONE' });
  });

  it('is case-tolerant on labels and class', () => {
    const det = parseReplaceDetect('class: Fill\ncommand: NONE\ntarget: NONE\nvalue:');
    assert.strictEqual(det.cls, 'fill');
  });

  it('unknown class parses as empty string', () => {
    const det = parseReplaceDetect('CLASS: MAYBE\nCOMMAND: NONE\nTARGET: NONE\nVALUE:');
    assert.strictEqual(det.cls, '');
  });

  it('missing lines parse as empty fields, not throws', () => {
    const det = parseReplaceDetect('gibberish with no labels at all');
    assert.deepStrictEqual(det, { cls: '', command: '', target: '', value: '' });
  });
});

describe('verifyReplaceDetect — acceptance gate', () => {
  const TEXT = 'alpha zephyr beta, zap it _';
  const DET = { cls: 'replace' as const, command: 'zap it _', target: 'zephyr', value: 'ALT-ONE' };

  it('accepts a clean detection and strips the _ from the instruction', () => {
    const v = verifyReplaceDetect(TEXT, DET);
    assert.deepStrictEqual(v, { target: 'zephyr', instruction: 'zap it', value: 'ALT-ONE' });
  });

  it('rejects non-replace class', () => {
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, cls: 'fill' as any }), null);
  });

  it('rejects when TARGET is not a verbatim substring', () => {
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, target: 'zephyrus' }), null);
  });

  it('rejects when COMMAND is not a verbatim substring', () => {
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, command: 'zap that _' }), null);
  });

  it('rejects when COMMAND lacks the underscore', () => {
    assert.strictEqual(verifyReplaceDetect('alpha zephyr beta, zap it _', { ...DET, command: 'zap it' }), null);
  });

  it('rejects an ambiguous target (two occurrences outside the command)', () => {
    assert.strictEqual(
      verifyReplaceDetect('zephyr alpha zephyr, zap it _', DET),
      null,
    );
  });

  it('accepts a target ALSO named inside the command (swap phrasing)', () => {
    // "swap zephyr for something better _" — the command names the
    // target; the copy inside the command must not count as ambiguity.
    const text = 'alpha zephyr beta, swap zephyr for something better _';
    const v = verifyReplaceDetect(text, {
      cls: 'replace', command: 'swap zephyr for something better _', target: 'zephyr', value: 'ALT-ONE',
    });
    assert.deepStrictEqual(v, { target: 'zephyr', instruction: 'swap zephyr for something better', value: 'ALT-ONE' });
  });

  it('rejects when the only occurrence is INSIDE the command (mistaken operand)', () => {
    const text = 'alpha beta, fix the zephyr _';
    assert.strictEqual(
      verifyReplaceDetect(text, { cls: 'replace', command: 'fix the zephyr _', target: 'zephyr', value: 'ALT-ONE' }),
      null,
    );
  });

  it('rejects when a command-internal copy PRECEDES the real target (splice would hit the wrong copy)', () => {
    const text = 'swap zephyr for something better _ alpha zephyr beta';
    assert.strictEqual(
      verifyReplaceDetect(text, { cls: 'replace', command: 'swap zephyr for something better _', target: 'zephyr', value: 'ALT-ONE' }),
      null,
    );
  });

  it('rejects a no-op (VALUE equals TARGET)', () => {
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, value: 'zephyr' }), null);
  });

  it('rejects empty/NONE fields', () => {
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, target: 'NONE' }), null);
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, value: '' }), null);
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, command: '' }), null);
  });

  it('hydrates catalog tokens before verifying (dehydrated outbound text)', () => {
    // The LLM saw dehydrated text and echoed a [TOKEN] as the target;
    // verification must run in value space against the real buffer.
    const catalog = new Map([['[NICKNAME]', 'zephyr']]);
    const v = verifyReplaceDetect(TEXT, { ...DET, target: '[NICKNAME]' }, { catalog });
    assert.deepStrictEqual(v, { target: 'zephyr', instruction: 'zap it', value: 'ALT-ONE' });
  });

  it('unknown tokens fail the substring check (safe fallback), not throw', () => {
    const catalog = new Map([['[NICKNAME]', 'zephyr']]);
    assert.strictEqual(verifyReplaceDetect(TEXT, { ...DET, target: '[UNKNOWN THING]' }, { catalog }), null);
  });
});
