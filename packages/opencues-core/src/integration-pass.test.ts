/**
 * Unit tests for the integration-pass module. Runs under node:test
 * (matching blank-context.test.ts / identity-context.test.ts).
 *
 * Exercises:
 *   - hasFormatHint           — surrounding-prose pattern detector
 *   - extractNumericTokens    — numeric-token extraction + canonicalisation
 *   - numericTokensPreserved  — input/output number-set comparison
 *   - makeCacheKey            — stable cache-key derivation
 *   - IntegrationCache        — LRU semantics
 *   - sliceContextWindows     — buffer-slice helper
 *   - runIntegrationPass      — end-to-end with a stubbed dispatch
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  hasFormatHint,
  extractNumericTokens,
  numericTokensPreserved,
  makeCacheKey as makeIntegrationCacheKey,
  makeIntegrationCache,
  IntegrationCache,
  sliceContextWindows,
  runIntegrationPass,
  buildIntegrationUserMessage,
  type IntegrationDispatch,
} from './integration-pass';

describe('hasFormatHint', () => {
  it('fires on multi-word substitutes (label-dropping / brevity / prose-fitting is possible)', () => {
    // Multi-word raw substitutes almost always benefit from polish.
    assert.strictEqual(hasFormatHint('', '', 'France capital: Paris'), true);
    assert.strictEqual(hasFormatHint('', '', '14°C, overcast'), true);
    assert.strictEqual(hasFormatHint('', '', 'Show HN: I built a thing'), true);
  });

  it('fires on substitutes containing digits (number formatting is a polish candidate)', () => {
    assert.strictEqual(hasFormatHint('', '', '67000000'), true);     // bare large integer
    assert.strictEqual(hasFormatHint('', '', '$254.23'), true);       // currency + decimal
    assert.strictEqual(hasFormatHint('', '', '1.2k'), true);          // magnitude suffix
    assert.strictEqual(hasFormatHint('', '', '50%'), true);           // percent
  });

  it('fires on substitutes with structural punctuation (colons, parens, currency, units)', () => {
    assert.strictEqual(hasFormatHint('', '', 'NVDA:fast'), true);     // colon
    assert.strictEqual(hasFormatHint('', '', '(412'), true);          // paren
    assert.strictEqual(hasFormatHint('', '', '$abc'), true);          // currency
    assert.strictEqual(hasFormatHint('', '', '14°'), true);           // degree
  });

  it('does NOT fire on single bare-word substitutes (already in their preferred shape)', () => {
    assert.strictEqual(hasFormatHint('any prose at all', '', 'Paris'), false);
    assert.strictEqual(hasFormatHint('', 'and more prose', 'astonishment'), false);
    assert.strictEqual(hasFormatHint('lots of context', '', 'eight'), false);
  });

  it('fires on multi-word substitute regardless of surrounding prose', () => {
    // The new gate ignores prose patterns; only the substitute's shape matters.
    assert.strictEqual(hasFormatHint('', '', 'Morning run weather'), true);
    // Same prose, but the substitute carries the temperature hint.
    assert.strictEqual(
      hasFormatHint('Morning run, ', ' — perfect mileage weather', '14°C, overcast'),
      true,
    );
  });

  it('fires on labelled-value substitutes like "NVDA: $254.00"', () => {
    assert.strictEqual(
      hasFormatHint('I recommend trimming exposure to ', ' today.', 'NVDA: $254.00'),
      true,
    );
  });

  it('fires on parenthesised-metadata substitutes (HN style)', () => {
    assert.strictEqual(
      hasFormatHint('top story is "', '". Have a look.', 'Show HN: Cool thing (412 points)'),
      true,
    );
  });
});

describe('extractNumericTokens', () => {
  it('extracts currency-prefixed numbers', () => {
    assert.deepStrictEqual(extractNumericTokens('NVIDIA is at $254.00 today'), ['254']);
    assert.deepStrictEqual(extractNumericTokens('£1,234.50 and €99.99'), ['1234.5', '99.99']);
  });

  it('canonicalises trailing zeros after decimal', () => {
    assert.deepStrictEqual(extractNumericTokens('$254.00'), ['254']);
    assert.deepStrictEqual(extractNumericTokens('$254'), ['254']);
    // Both polish + original collapse to the same canonical form.
  });

  it('preserves magnitude suffixes', () => {
    assert.deepStrictEqual(extractNumericTokens('1.2k followers'), ['1.2k']);
    assert.deepStrictEqual(extractNumericTokens('$5B market cap'), ['5b']);
  });

  it('extracts percentages', () => {
    assert.deepStrictEqual(extractNumericTokens('up 5.5% on the day'), ['5.5']);
  });

  it('extracts ISO dates', () => {
    assert.deepStrictEqual(extractNumericTokens('effective 2026-06-15'), ['2026-06-15']);
  });

  it('deduplicates while preserving first-occurrence order', () => {
    assert.deepStrictEqual(extractNumericTokens('$254 then $254 then $300'), ['254', '300']);
  });

  it('handles empty + numberless strings', () => {
    assert.deepStrictEqual(extractNumericTokens(''), []);
    assert.deepStrictEqual(extractNumericTokens('all words no digits'), []);
  });
});

describe('numericTokensPreserved', () => {
  it('accepts when output is a subset of input', () => {
    assert.strictEqual(numericTokensPreserved(['254', '412'], ['254']), true);
    assert.strictEqual(numericTokensPreserved(['254', '412'], []), true);
  });

  it('accepts equality', () => {
    assert.strictEqual(numericTokensPreserved(['254'], ['254']), true);
  });

  it('rejects new numbers in output', () => {
    assert.strictEqual(numericTokensPreserved(['254'], ['254', '300']), false);
    assert.strictEqual(numericTokensPreserved(['254'], ['255']), false);
  });

  it('accepts canonically-equivalent reformatting', () => {
    // Caller passes already-canonicalised forms; both extracted as "254".
    assert.strictEqual(numericTokensPreserved(['254'], ['254']), true);
  });

  it('rejects when input is empty but output invents a number', () => {
    assert.strictEqual(numericTokensPreserved([], ['254']), false);
  });
});

describe('makeIntegrationCacheKey', () => {
  it('is sensitive to substituted + tail of contextBefore + head of contextAfter', () => {
    const k1 = makeIntegrationCacheKey({
      substituted: '$254.00',
      contextBefore: 'NVIDIA is trading at ',
      contextAfter: ' today',
    });
    const k2 = makeIntegrationCacheKey({
      substituted: '$254.00',
      contextBefore: 'NVIDIA is trading at ',
      contextAfter: ' today',
    });
    assert.strictEqual(k1, k2);

    const k3 = makeIntegrationCacheKey({
      substituted: '$255.00', // different substitute
      contextBefore: 'NVIDIA is trading at ',
      contextAfter: ' today',
    });
    assert.notStrictEqual(k1, k3);
  });

  it('uses only the tail of contextBefore so long buffers cache reliably', () => {
    // The cache key uses the last CONTEXT_KEY_TAIL_CHARS (32) chars of
    // contextBefore — so the common ending must be ≥ 32 chars for two
    // long-buffer variants to collide. The "common tail" below is 50.
    const commonTail = 'and the trading floor opened normally today: ';
    const long1 = 'a'.repeat(500) + commonTail;
    const long2 = 'b'.repeat(500) + commonTail;
    const k1 = makeIntegrationCacheKey({
      substituted: '$254.00',
      contextBefore: long1,
      contextAfter: ' today',
    });
    const k2 = makeIntegrationCacheKey({
      substituted: '$254.00',
      contextBefore: long2,
      contextAfter: ' today',
    });
    assert.strictEqual(k1, k2, 'far-prefix changes do not bust the cache');
  });

  it('includes hint in the key', () => {
    const k1 = makeIntegrationCacheKey({
      substituted: '$254.00',
      contextBefore: 'NVIDIA at ',
      contextAfter: '',
      hint: 'whole dollars',
    });
    const k2 = makeIntegrationCacheKey({
      substituted: '$254.00',
      contextBefore: 'NVIDIA at ',
      contextAfter: '',
      hint: 'cents',
    });
    assert.notStrictEqual(k1, k2);
  });
});

describe('IntegrationCache', () => {
  it('returns undefined for unknown keys', () => {
    const c = new IntegrationCache(4);
    assert.strictEqual(c.get('missing'), undefined);
  });

  it('round-trips inserted values', () => {
    const c = new IntegrationCache(4);
    c.set('a', 'A');
    assert.strictEqual(c.get('a'), 'A');
  });

  it('evicts least-recently-used when at capacity', () => {
    const c = new IntegrationCache(3);
    c.set('a', 'A');
    c.set('b', 'B');
    c.set('c', 'C');
    c.set('d', 'D'); // Evicts 'a'.
    assert.strictEqual(c.get('a'), undefined);
    assert.strictEqual(c.get('b'), 'B');
    assert.strictEqual(c.get('c'), 'C');
    assert.strictEqual(c.get('d'), 'D');
  });

  it('refreshes LRU on get — touched entries survive eviction', () => {
    const c = new IntegrationCache(3);
    c.set('a', 'A');
    c.set('b', 'B');
    c.set('c', 'C');
    // Touch 'a' so it becomes most-recent.
    assert.strictEqual(c.get('a'), 'A');
    c.set('d', 'D'); // Should evict 'b' (now oldest), not 'a'.
    assert.strictEqual(c.get('a'), 'A');
    assert.strictEqual(c.get('b'), undefined);
  });

  it('updating an existing key does not double-count for capacity', () => {
    const c = new IntegrationCache(2);
    c.set('a', 'A');
    c.set('a', 'A2'); // Same key, different value — must move-to-end, not add.
    c.set('b', 'B');
    assert.strictEqual(c.size, 2);
    assert.strictEqual(c.get('a'), 'A2');
    assert.strictEqual(c.get('b'), 'B');
  });
});

describe('sliceContextWindows', () => {
  it('caps both sides at the configured window', () => {
    const buf = 'a'.repeat(500) + 'SUB' + 'b'.repeat(500);
    const r = sliceContextWindows(buf, 500, 503);
    assert.strictEqual(r.contextBefore.length, 300);
    assert.strictEqual(r.contextAfter.length, 300);
    assert.ok(r.contextBefore.endsWith('a'));
    assert.ok(r.contextAfter.startsWith('b'));
  });

  it('handles substitute at the start of buffer', () => {
    const r = sliceContextWindows('SUB rest of text', 0, 3);
    assert.strictEqual(r.contextBefore, '');
    assert.strictEqual(r.contextAfter, ' rest of text');
  });

  it('handles substitute at the end of buffer', () => {
    const r = sliceContextWindows('opening SUB', 8, 11);
    assert.strictEqual(r.contextBefore, 'opening ');
    assert.strictEqual(r.contextAfter, '');
  });
});

describe('runIntegrationPass — gating', () => {
  it('skips short substitutes', async () => {
    const dispatch: IntegrationDispatch = async () => { throw new Error('should not call'); };
    const cache = makeIntegrationCache();
    const r = await runIntegrationPass(
      // 'sh' is 2 chars — below SUBSTITUTE_MIN_CHARS=4.
      { substituted: 'sh', contextBefore: 'NVIDIA at $100', contextAfter: '' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'skipped-short');
    assert.strictEqual(r.llmCalled, false);
    assert.strictEqual(r.polished, 'sh');
  });

  it('skips when no format hint in surrounding prose', async () => {
    const dispatch: IntegrationDispatch = async () => { throw new Error('should not call'); };
    const cache = makeIntegrationCache();
    const r = await runIntegrationPass(
      {
        // Plain prose substitute, no colon-labels, no numbers, no
        // currency, no parens-with-numbers — none of the format-hint
        // detectors fire, so polish skips before any LLM call.
        substituted: 'astonishment',
        contextBefore: 'the latest top story is',
        contextAfter: 'and it is interesting',
      },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'skipped-no-format-hint');
    assert.strictEqual(r.llmCalled, false);
  });
});

describe('runIntegrationPass — dispatch + validation', () => {
  let dispatchCalls: Array<{ system: string; user: string }>;
  let dispatchReturns: string;
  let dispatch: IntegrationDispatch;
  let cache: IntegrationCache;

  beforeEach(() => {
    dispatchCalls = [];
    dispatchReturns = '';
    dispatch = async (system, user) => {
      dispatchCalls.push({ system, user });
      return dispatchReturns;
    };
    cache = makeIntegrationCache();
  });

  it('polishes a substitute when the LLM returns a tighter form', async () => {
    dispatchReturns = '$254';
    const r = await runIntegrationPass(
      {
        substituted: '$254.00',
        // "$" in contextBefore is the format hint.
        contextBefore: 'AAPL closed at $200, NVIDIA opened at ',
        contextAfter: ' today',
      },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'polished');
    assert.strictEqual(r.polished, '$254');
    assert.strictEqual(r.llmCalled, true);
    assert.strictEqual(r.accepted, true);
    assert.strictEqual(dispatchCalls.length, 1);
  });

  it('returns verbatim when the LLM returns the input unchanged', async () => {
    dispatchReturns = '$254.00';
    const r = await runIntegrationPass(
      {
        substituted: '$254.00',
        contextBefore: 'spreadsheet row: NVIDIA $254.00, ',
        contextAfter: ' next',
      },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'verbatim-from-llm');
    assert.strictEqual(r.polished, '$254.00');
  });

  it('rejects when the LLM hallucinates a different number', async () => {
    dispatchReturns = '$300'; // Wrong! Input was $254.00.
    const r = await runIntegrationPass(
      {
        substituted: '$254.00',
        contextBefore: 'AAPL $200, NVIDIA at ',
        contextAfter: ' today',
      },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'rejected-numeric-drift');
    assert.strictEqual(r.polished, '$254.00');
    assert.strictEqual(r.accepted, false);
  });

  it('rejects on empty LLM output', async () => {
    dispatchReturns = '   '; // Whitespace only — empty after trim.
    const r = await runIntegrationPass(
      {
        substituted: '$254.00',
        contextBefore: 'AAPL $200, NVIDIA at ',
        contextAfter: '',
      },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'rejected-empty');
    assert.strictEqual(r.polished, '$254.00');
  });

  it('rejects on dispatch error (returns raw substitute)', async () => {
    dispatch = async () => { throw new Error('network down'); };
    const r = await runIntegrationPass(
      {
        substituted: '$254.00',
        contextBefore: 'AAPL $200, NVIDIA at ',
        contextAfter: '',
      },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'rejected-dispatch-error');
    assert.strictEqual(r.polished, '$254.00');
    assert.strictEqual(r.llmCalled, true);
  });

  it('accepts drop-of-numbers as a valid polish', async () => {
    // Polish drops "(412 points)" — output is a subset of input numbers, OK.
    dispatchReturns = 'Show HN: I built a thing in Rust';
    const r = await runIntegrationPass(
      {
        substituted: 'Show HN: I built a thing in Rust (412 points)',
        contextBefore: 'today HN says: $100',
        contextAfter: ', interesting',
      },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'polished');
    assert.strictEqual(r.polished, 'Show HN: I built a thing in Rust');
  });

  it('caches accepted polishes — second identical call skips dispatch', async () => {
    dispatchReturns = '$254';
    const req = {
      substituted: '$254.00',
      contextBefore: 'AAPL $200, NVIDIA is at ',
      contextAfter: ' today',
    };
    const r1 = await runIntegrationPass(req, dispatch, cache);
    assert.strictEqual(r1.reason, 'polished');
    const r2 = await runIntegrationPass(req, dispatch, cache);
    assert.strictEqual(r2.reason, 'cache-hit');
    assert.strictEqual(r2.polished, '$254');
    assert.strictEqual(r2.llmCalled, false);
    assert.strictEqual(dispatchCalls.length, 1, 'dispatch called exactly once across two identical requests');
  });

  it('passes the hint through into the user message', async () => {
    dispatchReturns = '$254';
    await runIntegrationPass(
      {
        substituted: '$254.00',
        contextBefore: 'AAPL $200, NVIDIA at ',
        contextAfter: ' today',
        hint: 'whole dollars only',
      },
      dispatch,
      cache,
    );
    assert.match(dispatchCalls[0].user, /BLANK_HINT: whole dollars only/);
  });

  it('handles empty hint in user message (renders as "(empty)")', async () => {
    dispatchReturns = '$254';
    await runIntegrationPass(
      {
        substituted: '$254.00',
        contextBefore: 'AAPL $200, NVIDIA at ',
        contextAfter: ' today',
      },
      dispatch,
      cache,
    );
    assert.match(dispatchCalls[0].user, /BLANK_HINT: \(empty\)/);
  });
});

describe('buildIntegrationUserMessage', () => {
  it('labels all four fields and falls back to (empty)', () => {
    const u = buildIntegrationUserMessage({
      substituted: 'X',
      contextBefore: 'A',
      contextAfter: 'B',
      hint: 'H',
    });
    assert.match(u, /CONTEXT_BEFORE: A/);
    assert.match(u, /SUBSTITUTED: X/);
    assert.match(u, /CONTEXT_AFTER: B/);
    assert.match(u, /BLANK_HINT: H/);
  });

  it('renders empty fields as (empty)', () => {
    const u = buildIntegrationUserMessage({
      substituted: 'X',
      contextBefore: '',
      contextAfter: '',
    });
    assert.match(u, /CONTEXT_BEFORE: \(empty\)/);
    assert.match(u, /CONTEXT_AFTER: \(empty\)/);
    assert.match(u, /BLANK_HINT: \(empty\)/);
  });
});
