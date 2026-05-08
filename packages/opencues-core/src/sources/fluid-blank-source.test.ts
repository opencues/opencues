/**
 * Tests for fluid-blank-source.ts
 *
 * Run with: node --test dist/sources/fluid-blank-source.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { FluidBlankSource, determineReplaceMode } from './fluid-blank-source';
import { HttpAdapter, CueContext } from '../types';
import { getProvider } from '../llm-provider';

function makeMockAdapter(responses: string[]): HttpAdapter {
  let i = 0;
  return {
    post: async () => {
      const r = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: r } }] });
    },
  };
}

function ctxFromText(text: string): CueContext {
  return { text, words: text.split(/\s+/) };
}

// ---------------------------------------------------------------------------
// determineReplaceMode
// ---------------------------------------------------------------------------

describe('determineReplaceMode', () => {
  it('returns FILL for inputs ending with copula + _', () => {
    assert.strictEqual(determineReplaceMode('The capital of France is _'), 'FILL');
    assert.strictEqual(determineReplaceMode('The CEO of Apple is _'), 'FILL');
    assert.strictEqual(determineReplaceMode('Numbers are _'), 'FILL');
  });

  it('returns WIPE when copula is not immediately before _', () => {
    // "by _" — preposition, not copula
    assert.strictEqual(determineReplaceMode('The Mona Lisa was painted by _'), 'WIPE');
  });

  it('returns FILL for inputs ending with = _', () => {
    assert.strictEqual(determineReplaceMode('4 * 12 = _'), 'FILL');
    assert.strictEqual(determineReplaceMode('square root of 144 = _'), 'FILL');
  });

  it('returns FILL for inputs ending with ? _', () => {
    assert.strictEqual(determineReplaceMode("what's the capital of france? _"), 'FILL');
    assert.strictEqual(determineReplaceMode('how many planets are there? _'), 'FILL');
  });

  it('returns FILL for inputs with _ mid-sentence (textbook-style)', () => {
    assert.strictEqual(determineReplaceMode('Water boils at _ degrees Celsius'), 'FILL');
    assert.strictEqual(determineReplaceMode('There are _ continents'), 'FILL');
  });

  it('returns WIPE for bare-noun-phrase + _ inputs', () => {
    assert.strictEqual(determineReplaceMode('capital of france _'), 'WIPE');
    assert.strictEqual(determineReplaceMode('unicode for em dash _'), 'WIPE');
    assert.strictEqual(determineReplaceMode('writing my paper capital of france _'), 'WIPE');
    assert.strictEqual(determineReplaceMode('founder of microsoft _'), 'WIPE');
  });
});

// ---------------------------------------------------------------------------
// FluidBlankSource
// ---------------------------------------------------------------------------

describe('FluidBlankSource', () => {
  const baseConfig = {
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  };

  it('supports() returns true when input contains _', () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
    });
    assert.strictEqual(src.supports(ctxFromText('capital of france _')), true);
    assert.strictEqual(src.supports(ctxFromText('no blank here')), false);
  });

  it('supports() cedes only when a registered blank would actually claim the slot (proximity-aware)', () => {
    // Dictionary blank with `what is` keyword + blankProximity 3.
    const blanks = {
      dictionary: { name: 'dictionary', blankKeywords: ['what is'], blankProximity: 3 },
    };
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      blanks,
    });
    // Within proximity → BlankSource will claim, fluid cedes.
    assert.strictEqual(src.supports(ctxFromText('what is git _')), false);
    assert.strictEqual(src.supports(ctxFromText('what is the answer _')), false);
    // Out of proximity → BlankSource declines, fluid handles it (was the
    // dead zone before this fix).
    assert.strictEqual(src.supports(ctxFromText('what is git as in github _')), true);
    // No keyword in input → fluid handles.
    assert.strictEqual(src.supports(ctxFromText('etymology of paradigm _')), true);
  });

  it('runs P1 + P3 and returns answer for FILL mode', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SPAN: The capital of France is _\nCONTEXT: none',
        'ANSWER: Paris',
      ]),
    });
    const result = await src.getCues(ctxFromText('The capital of France is _'));
    assert.strictEqual(result.results.length, 1);
    const r = result.results[0]!;
    assert.deepStrictEqual(r.alternatives, ['_', 'Paris']);
    assert.strictEqual(r.metadata?.fluidBlankMode, 'FILL');
    assert.strictEqual(r.spanStart, undefined);
    assert.strictEqual(r.spanEnd, undefined);
  });

  it('returns multi-word span for WIPE mode', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SPAN: capital of france _\nCONTEXT: trivia tonight',
        'ANSWER: Paris',
      ]),
    });
    const result = await src.getCues(ctxFromText('trivia tonight capital of france _'));
    assert.strictEqual(result.results.length, 1);
    const r = result.results[0]!;
    assert.strictEqual(r.metadata?.fluidBlankMode, 'WIPE');
    // Character offsets: "trivia tonight " is 15 chars, then "capital of france _" is 19 chars
    assert.strictEqual(r.spanStart, 15);
    assert.strictEqual(r.spanEnd, 34);
    // Alternatives stay ['_', answer] — the lookup phrase is consumed by
    // substitution; cycling back goes to bare `_` rather than restoring it.
    assert.deepStrictEqual(r.alternatives, ['_', 'Paris']);
  });

  it('returns no results when P1 bails (SPAN: NONE)', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SPAN: NONE\nCONTEXT: click _ to continue',
      ]),
    });
    const result = await src.getCues(ctxFromText('click _ to continue'));
    assert.deepStrictEqual(result.results, []);
  });

  it('returns no results when P3 fails to produce an answer', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SPAN: capital of france _\nCONTEXT: none',
        'no answer here',
      ]),
    });
    const result = await src.getCues(ctxFromText('capital of france _'));
    assert.deepStrictEqual(result.results, []);
  });

  it('handles HTTP error gracefully', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: { post: async () => { throw new Error('network down'); } },
    });
    const result = await src.getCues(ctxFromText('capital of france _'));
    assert.deepStrictEqual(result.results, []);
    assert.match(result.error ?? '', /network down/);
  });
});
