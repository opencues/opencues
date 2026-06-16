/**
 * Unit tests for the token-integration module. Runs under node:test
 * (same pattern as integration-pass.test.ts).
 *
 * Exercises:
 *   - parseTokenIntegrationOutput — robust labelled-line parser
 *   - makeTokenCacheKey + TokenIntegrationCache — LRU semantics
 *   - runTokenIntegration — full flow with a stubbed dispatch:
 *     • short buffer / no `_` skip paths
 *     • cache hits + misses
 *     • dispatch errors fall back to default
 *     • empty / malformed LLM output falls back
 *     • REPLACE not in buffer falls back
 *     • REPLACE without `_` falls back
 *     • happy path: REPLACE = "_", WITH = polished value
 *     • happy path: REPLACE = full lookup, WITH = answer
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  parseTokenIntegrationOutput,
  makeTokenCacheKey,
  makeTokenIntegrationCache,
  TokenIntegrationCache,
  runTokenIntegration,
  buildTokenIntegrationUserMessage,
  type TokenIntegrationDispatch,
  type TokenIntegrationRequest,
} from './token-integration';

describe('parseTokenIntegrationOutput', () => {
  it('parses well-formed REPLACE + WITH', () => {
    const r = parseTokenIntegrationOutput('REPLACE: _\nWITH: $212.45');
    assert.deepStrictEqual(r, { replace: '_', with_: '$212.45' });
  });

  it('parses WITH spanning multiple lines', () => {
    const r = parseTokenIntegrationOutput('REPLACE: _\nWITH: line one\nline two\nline three');
    assert.ok(r);
    assert.strictEqual(r!.replace, '_');
    assert.match(r!.with_, /line one/);
  });

  it('strips wrapping double quotes', () => {
    const r = parseTokenIntegrationOutput('REPLACE: "_"\nWITH: "$212"');
    assert.deepStrictEqual(r, { replace: '_', with_: '$212' });
  });

  it('strips wrapping single quotes', () => {
    const r = parseTokenIntegrationOutput("REPLACE: '_'\nWITH: '$212'");
    assert.deepStrictEqual(r, { replace: '_', with_: '$212' });
  });

  it('returns null when REPLACE label missing', () => {
    assert.strictEqual(parseTokenIntegrationOutput('WITH: $212'), null);
  });

  it('returns null when WITH label missing', () => {
    assert.strictEqual(parseTokenIntegrationOutput('REPLACE: _'), null);
  });

  it('returns null when REPLACE value is empty', () => {
    assert.strictEqual(parseTokenIntegrationOutput('REPLACE: \nWITH: $212'), null);
  });

  it('returns null on entirely garbled input', () => {
    assert.strictEqual(parseTokenIntegrationOutput('this is not valid output'), null);
  });

  it('parses multi-word REPLACE (lookup-mode)', () => {
    const r = parseTokenIntegrationOutput('REPLACE: whats nvda price _\nWITH: $212.45');
    assert.deepStrictEqual(r, { replace: 'whats nvda price _', with_: '$212.45' });
  });
});

describe('makeTokenCacheKey', () => {
  it('produces stable keys for the same input', () => {
    const a = makeTokenCacheKey({ buffer: 'nvda is at _', substitute: 'NVDA: $212' });
    const b = makeTokenCacheKey({ buffer: 'nvda is at _', substitute: 'NVDA: $212' });
    assert.strictEqual(a, b);
  });

  it('differentiates by substitute', () => {
    const a = makeTokenCacheKey({ buffer: 'nvda is at _', substitute: 'NVDA: $212' });
    const b = makeTokenCacheKey({ buffer: 'nvda is at _', substitute: 'NVDA: $214' });
    assert.notStrictEqual(a, b);
  });

  it('only the tail of the buffer participates (long-buffer-stable)', () => {
    // The tail (~64 chars) of both should be identical → keys equal.
    const tail = 'NVDA is currently being analysed and the price is _';
    const a = makeTokenCacheKey({ buffer: 'a'.repeat(500) + tail, substitute: 'X' });
    const b = makeTokenCacheKey({ buffer: 'b'.repeat(500) + tail, substitute: 'X' });
    assert.strictEqual(a, b);
  });

  it('differentiates by hint', () => {
    const a = makeTokenCacheKey({ buffer: 'nvda is at _', substitute: 'X', hint: 'one' });
    const b = makeTokenCacheKey({ buffer: 'nvda is at _', substitute: 'X', hint: 'two' });
    assert.notStrictEqual(a, b);
  });
});

describe('TokenIntegrationCache', () => {
  it('returns undefined for missing keys', () => {
    const c = new TokenIntegrationCache(4);
    assert.strictEqual(c.get('absent'), undefined);
  });

  it('round-trips inserted values', () => {
    const c = new TokenIntegrationCache(4);
    c.set('a', { replace: '_', with_: 'A' });
    assert.deepStrictEqual(c.get('a'), { replace: '_', with_: 'A' });
  });

  it('evicts LRU on capacity overflow', () => {
    const c = new TokenIntegrationCache(2);
    c.set('a', { replace: '_', with_: 'A' });
    c.set('b', { replace: '_', with_: 'B' });
    c.set('c', { replace: '_', with_: 'C' });
    assert.strictEqual(c.get('a'), undefined);
    assert.ok(c.get('b'));
    assert.ok(c.get('c'));
  });

  it('refreshes LRU position on get', () => {
    const c = new TokenIntegrationCache(2);
    c.set('a', { replace: '_', with_: 'A' });
    c.set('b', { replace: '_', with_: 'B' });
    void c.get('a'); // make 'a' MRU
    c.set('c', { replace: '_', with_: 'C' });
    assert.ok(c.get('a'));
    assert.strictEqual(c.get('b'), undefined);
  });
});

describe('runTokenIntegration — skip + cache paths', () => {
  it('skips on short buffer', async () => {
    const dispatch: TokenIntegrationDispatch = async () => { throw new Error('should not be called'); };
    const cache = makeTokenIntegrationCache();
    const r = await runTokenIntegration({ buffer: '_', substitute: 'X' }, dispatch, cache);
    assert.strictEqual(r.reason, 'skipped-short-buffer');
    assert.strictEqual(r.llmCalled, false);
    assert.strictEqual(r.replace, '_');
    assert.strictEqual(r.with_, 'X');
  });

  it('skips when buffer has no underscore', async () => {
    const dispatch: TokenIntegrationDispatch = async () => { throw new Error('should not be called'); };
    const cache = makeTokenIntegrationCache();
    const r = await runTokenIntegration({ buffer: 'plain prose', substitute: 'X' }, dispatch, cache);
    assert.strictEqual(r.reason, 'skipped-no-underscore');
    assert.strictEqual(r.llmCalled, false);
  });

  it('hits cache on repeated identical request', async () => {
    let dispatchCalls = 0;
    const dispatch: TokenIntegrationDispatch = async () => {
      dispatchCalls++;
      return 'REPLACE: _\nWITH: $212';
    };
    const cache = makeTokenIntegrationCache();
    const req: TokenIntegrationRequest = { buffer: 'nvda is at _', substitute: 'NVDA: $212' };
    const r1 = await runTokenIntegration(req, dispatch, cache);
    const r2 = await runTokenIntegration(req, dispatch, cache);
    assert.strictEqual(r1.reason, 'integrated');
    assert.strictEqual(r2.reason, 'cache-hit');
    assert.strictEqual(r2.llmCalled, false);
    assert.strictEqual(dispatchCalls, 1, 'dispatch must have been called exactly once');
  });
});

describe('runTokenIntegration — dispatch + validation', () => {
  let cache: TokenIntegrationCache;
  let dispatchReturns: string;
  let dispatchCalls: Array<{ system: string; user: string }>;
  let dispatch: TokenIntegrationDispatch;
  let throwOnDispatch: boolean;

  beforeEach(() => {
    cache = makeTokenIntegrationCache();
    dispatchReturns = '';
    dispatchCalls = [];
    throwOnDispatch = false;
    dispatch = async (system, user) => {
      dispatchCalls.push({ system, user });
      if (throwOnDispatch) throw new Error('boom');
      return dispatchReturns;
    };
  });

  it('integrates happy path — REPLACE = "_", WITH = polished value', async () => {
    dispatchReturns = 'REPLACE: _\nWITH: $212';
    const r = await runTokenIntegration(
      { buffer: 'Hi team, AAPL is at $200, NVDA: _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'integrated');
    assert.strictEqual(r.replace, '_');
    assert.strictEqual(r.with_, '$212');
    assert.strictEqual(r.llmCalled, true);
  });

  it('integrates lookup mode — REPLACE = whole lookup phrase, WITH = answer', async () => {
    dispatchReturns = 'REPLACE: whats nvda stock price _\nWITH: $212.45';
    const r = await runTokenIntegration(
      { buffer: 'whats nvda stock price _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'integrated');
    assert.strictEqual(r.replace, 'whats nvda stock price _');
    assert.strictEqual(r.with_, '$212.45');
  });

  it('falls back when REPLACE is not a substring of buffer', async () => {
    dispatchReturns = 'REPLACE: not-in-buffer _\nWITH: $212';
    const r = await runTokenIntegration(
      { buffer: 'nvda is at _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'fallback-not-substring');
    assert.strictEqual(r.replace, '_');
    assert.strictEqual(r.with_, 'NVDA: $212.45'); // raw substitute lands
  });

  it('falls back when REPLACE does not contain underscore', async () => {
    dispatchReturns = 'REPLACE: nvda is\nWITH: $212';
    const r = await runTokenIntegration(
      { buffer: 'nvda is at _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'fallback-no-underscore');
    assert.strictEqual(r.replace, '_');
    assert.strictEqual(r.with_, 'NVDA: $212.45');
  });

  it('falls back on empty LLM output', async () => {
    dispatchReturns = '   ';
    const r = await runTokenIntegration(
      { buffer: 'nvda is at _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'fallback-empty');
    assert.strictEqual(r.replace, '_');
    assert.strictEqual(r.with_, 'NVDA: $212.45');
  });

  it('falls back on malformed LLM output (no REPLACE label)', async () => {
    dispatchReturns = 'WITH: $212';
    const r = await runTokenIntegration(
      { buffer: 'nvda is at _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'fallback-bad-format');
    assert.strictEqual(r.replace, '_');
    assert.strictEqual(r.with_, 'NVDA: $212.45');
  });

  it('falls back on dispatch error', async () => {
    throwOnDispatch = true;
    const r = await runTokenIntegration(
      { buffer: 'nvda is at _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.strictEqual(r.reason, 'fallback-dispatch-error');
    assert.strictEqual(r.replace, '_');
    assert.strictEqual(r.with_, 'NVDA: $212.45');
  });

  it('passes BUFFER + SUBSTITUTE + HINT into the user message', async () => {
    dispatchReturns = 'REPLACE: _\nWITH: $212';
    await runTokenIntegration(
      { buffer: 'nvda is at _', substitute: 'NVDA: $212.45', hint: 'stock price — fit prose' },
      dispatch,
      cache,
    );
    assert.match(dispatchCalls[0].user, /BUFFER: nvda is at _/);
    assert.match(dispatchCalls[0].user, /SUBSTITUTE: NVDA: \$212\.45/);
    assert.match(dispatchCalls[0].user, /HINT: stock price/);
  });

  it('omits HINT label when no hint provided', async () => {
    dispatchReturns = 'REPLACE: _\nWITH: $212';
    await runTokenIntegration(
      { buffer: 'nvda is at _', substitute: 'NVDA: $212.45' },
      dispatch,
      cache,
    );
    assert.doesNotMatch(dispatchCalls[0].user, /HINT:/);
  });
});

describe('buildTokenIntegrationUserMessage', () => {
  it('labels BUFFER + SUBSTITUTE; includes HINT when set', () => {
    const u = buildTokenIntegrationUserMessage({
      buffer: 'nvda is at _',
      substitute: 'NVDA: $212.45',
      hint: 'a hint',
    });
    assert.match(u, /^BUFFER: nvda is at _$/m);
    assert.match(u, /^SUBSTITUTE: NVDA: \$212\.45$/m);
    assert.match(u, /^HINT: a hint$/m);
  });

  it('omits HINT when not set', () => {
    const u = buildTokenIntegrationUserMessage({ buffer: 'nvda is at _', substitute: 'X' });
    assert.doesNotMatch(u, /HINT:/);
  });
});
