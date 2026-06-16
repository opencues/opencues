/**
 * Unit tests for the rewrite-polish stage in token-integration.ts.
 *
 * Polish is the sibling of token-integration: same module, different prompt
 * shape. Where token-integration takes (buffer-with-`_`, substitute) and
 * decides REPLACE+WITH for splice, polish takes (instruction, rewrite) and
 * decides KEEP / POLISHED for whole-buffer refinement. Used by
 * TransformBlank's FUSED branch on post-processed rewrites.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  parseRewritePolishOutput,
  makeRewritePolishCacheKey,
  makeRewritePolishCache,
  RewritePolishCache,
  runRewritePolish,
  buildRewritePolishUserMessage,
  buildRewritePolishSystemPrompt,
  type TokenIntegrationDispatch,
  type RewritePolishRequest,
  __testing,
} from './token-integration';

describe('parseRewritePolishOutput', () => {
  it('parses bare KEEP', () => {
    const r = parseRewritePolishOutput('KEEP');
    assert.deepStrictEqual(r, { kept: true });
  });

  it('parses KEEP with trailing whitespace', () => {
    const r = parseRewritePolishOutput('KEEP   ');
    assert.deepStrictEqual(r, { kept: true });
  });

  it('parses KEEP case-insensitively', () => {
    const r = parseRewritePolishOutput('keep');
    assert.deepStrictEqual(r, { kept: true });
  });

  it('parses POLISHED: with inline body', () => {
    const r = parseRewritePolishOutput('POLISHED: Hi team, NVDA is at $212.45 today.');
    assert.deepStrictEqual(r, { kept: false, rewrite: 'Hi team, NVDA is at $212.45 today.' });
  });

  it('parses POLISHED: with body on next line(s)', () => {
    const r = parseRewritePolishOutput('POLISHED:\nSubject: Update\n\nHi team,\nNVDA at $212.45.');
    assert.ok(r);
    assert.strictEqual((r as { kept: false; rewrite: string }).kept, false);
    assert.match((r as { kept: false; rewrite: string }).rewrite, /^Subject: Update/);
    assert.match((r as { kept: false; rewrite: string }).rewrite, /\$212\.45\.$/);
  });

  it('returns null on garbled output', () => {
    assert.strictEqual(parseRewritePolishOutput('here is your rewrite: blah'), null);
  });

  it('returns null on empty', () => {
    assert.strictEqual(parseRewritePolishOutput(''), null);
  });

  it('returns null on POLISHED: with empty body', () => {
    assert.strictEqual(parseRewritePolishOutput('POLISHED:'), null);
    assert.strictEqual(parseRewritePolishOutput('POLISHED:\n\n  '), null);
  });
});

describe('makeRewritePolishCacheKey', () => {
  it('produces identical keys for identical inputs', () => {
    const req: RewritePolishRequest = { instruction: 'draft email', rewrite: 'Hi team, NVDA at $212.45.' };
    assert.strictEqual(makeRewritePolishCacheKey(req), makeRewritePolishCacheKey(req));
  });

  it('different instructions → different keys', () => {
    const a: RewritePolishRequest = { instruction: 'draft email', rewrite: 'X' };
    const b: RewritePolishRequest = { instruction: 'write summary', rewrite: 'X' };
    assert.notStrictEqual(makeRewritePolishCacheKey(a), makeRewritePolishCacheKey(b));
  });

  it('long rewrites slice from both ends (middle drift busts cache only when edges change)', () => {
    // Head + tail + length is the key. If only the middle changes, the
    // key stays the same when length is preserved. This is by design — a
    // cosmetic middle change usually still wants the same polish.
    const head = 'A'.repeat(__testing.REWRITE_HEAD_CHARS);
    const tail = 'B'.repeat(__testing.REWRITE_TAIL_CHARS);
    const middle1 = 'X'.repeat(50);
    const middle2 = 'Y'.repeat(50);
    const a: RewritePolishRequest = { instruction: 'i', rewrite: head + middle1 + tail };
    const b: RewritePolishRequest = { instruction: 'i', rewrite: head + middle2 + tail };
    assert.strictEqual(makeRewritePolishCacheKey(a), makeRewritePolishCacheKey(b));
  });

  it('length change → different key (even with identical head/tail)', () => {
    const head = 'A'.repeat(__testing.REWRITE_HEAD_CHARS);
    const tail = 'B'.repeat(__testing.REWRITE_TAIL_CHARS);
    const a: RewritePolishRequest = { instruction: 'i', rewrite: head + 'X' + tail };
    const b: RewritePolishRequest = { instruction: 'i', rewrite: head + 'XX' + tail };
    assert.notStrictEqual(makeRewritePolishCacheKey(a), makeRewritePolishCacheKey(b));
  });
});

describe('RewritePolishCache', () => {
  it('LRU evicts oldest entry past capacity', () => {
    const c = new RewritePolishCache(2);
    c.set('a', { kept: false, rewrite: '1' });
    c.set('b', { kept: false, rewrite: '2' });
    c.set('c', { kept: false, rewrite: '3' });
    assert.strictEqual(c.size, 2);
    assert.strictEqual(c.get('a'), undefined);
    assert.deepStrictEqual(c.get('b'), { kept: false, rewrite: '2' });
    assert.deepStrictEqual(c.get('c'), { kept: false, rewrite: '3' });
  });

  it('get() promotes the entry to MRU', () => {
    const c = new RewritePolishCache(2);
    c.set('a', { kept: false, rewrite: '1' });
    c.set('b', { kept: false, rewrite: '2' });
    c.get('a'); // promote a
    c.set('c', { kept: false, rewrite: '3' }); // should evict b, not a
    assert.deepStrictEqual(c.get('a'), { kept: false, rewrite: '1' });
    assert.strictEqual(c.get('b'), undefined);
  });

  it('clear() empties the cache', () => {
    const c = new RewritePolishCache();
    c.set('a', { kept: true, rewrite: 'x' });
    c.clear();
    assert.strictEqual(c.size, 0);
  });
});

describe('runRewritePolish — skip + cache paths', () => {
  let cache: RewritePolishCache;
  beforeEach(() => { cache = makeRewritePolishCache(); });

  it('skips when rewrite is shorter than the threshold', async () => {
    const dispatch: TokenIntegrationDispatch = async () => { throw new Error('should not dispatch'); };
    const result = await runRewritePolish(
      { instruction: 'draft', rewrite: 'too short' },
      dispatch,
      cache,
    );
    assert.strictEqual(result.reason, 'skipped-short-rewrite');
    assert.strictEqual(result.llmCalled, false);
    assert.strictEqual(result.rewrite, 'too short'); // unchanged
  });

  it('cache hit short-circuits dispatch', async () => {
    let calls = 0;
    const dispatch: TokenIntegrationDispatch = async () => {
      calls++;
      return 'POLISHED: refined version landed here.';
    };
    const req: RewritePolishRequest = {
      instruction: 'draft email',
      rewrite: 'Hi team, NVDA is trading. The price is $212.45 currently. Best.',
    };
    const r1 = await runRewritePolish(req, dispatch, cache);
    assert.strictEqual(r1.reason, 'polished');
    assert.strictEqual(calls, 1);

    const r2 = await runRewritePolish(req, dispatch, cache);
    assert.strictEqual(r2.reason, 'cache-hit');
    assert.strictEqual(calls, 1); // still 1 — cache served the second call
    assert.strictEqual(r2.rewrite, r1.rewrite);
  });

  it('cache hit serves KEEP without dispatch', async () => {
    let calls = 0;
    const dispatch: TokenIntegrationDispatch = async () => {
      calls++;
      return 'KEEP';
    };
    const req: RewritePolishRequest = {
      instruction: 'summary',
      rewrite: 'A long enough rewrite that already feels natural and integrated.',
    };
    const r1 = await runRewritePolish(req, dispatch, cache);
    assert.strictEqual(r1.reason, 'unchanged');
    assert.strictEqual(r1.rewrite, req.rewrite); // KEEP → original
    const r2 = await runRewritePolish(req, dispatch, cache);
    assert.strictEqual(r2.reason, 'cache-hit');
    assert.strictEqual(calls, 1);
    assert.strictEqual(r2.rewrite, req.rewrite); // cache replays the original
  });
});

describe('runRewritePolish — dispatch + validation', () => {
  let cache: RewritePolishCache;
  const reqFor = (rewrite: string, instruction = 'draft'): RewritePolishRequest => ({ instruction, rewrite });
  beforeEach(() => { cache = makeRewritePolishCache(); });

  it('integrates a polished body', async () => {
    const dispatch: TokenIntegrationDispatch = async () => 'POLISHED:\nHi team, NVDA is at $212.45 — sharing for your awareness.';
    const result = await runRewritePolish(
      reqFor('Hi team, NVDA is trading. The price is $212.45 currently. Best.', 'draft stock update email'),
      dispatch,
      cache,
    );
    assert.strictEqual(result.reason, 'polished');
    assert.strictEqual(result.llmCalled, true);
    assert.match(result.rewrite, /\$212\.45/);
  });

  it('returns original on KEEP', async () => {
    const dispatch: TokenIntegrationDispatch = async () => 'KEEP';
    const original = 'Hi team — quick note that NVDA closed at $212.45 today.';
    const result = await runRewritePolish(reqFor(original), dispatch, cache);
    assert.strictEqual(result.reason, 'unchanged');
    assert.strictEqual(result.rewrite, original);
  });

  it('falls back to original on dispatch error', async () => {
    const dispatch: TokenIntegrationDispatch = async () => { throw new Error('network down'); };
    const original = 'Hi team, NVDA at $212.45 with some surrounding context to clear the min length threshold.';
    const result = await runRewritePolish(reqFor(original), dispatch, cache);
    assert.strictEqual(result.reason, 'fallback-dispatch-error');
    assert.strictEqual(result.rewrite, original);
    assert.strictEqual(result.llmCalled, true); // we did call dispatch — it threw
  });

  it('falls back to original on empty dispatch output', async () => {
    const dispatch: TokenIntegrationDispatch = async () => '';
    const original = 'Long enough rewrite to pass the short-circuit threshold for polish-skip logic here.';
    const result = await runRewritePolish(reqFor(original), dispatch, cache);
    assert.strictEqual(result.reason, 'fallback-empty');
    assert.strictEqual(result.rewrite, original);
  });

  it('falls back to original on malformed dispatch output', async () => {
    const dispatch: TokenIntegrationDispatch = async () => 'here is your polished rewrite without the labels';
    const original = 'Long enough rewrite to pass the short-circuit threshold for polish-skip logic here.';
    const result = await runRewritePolish(reqFor(original), dispatch, cache);
    assert.strictEqual(result.reason, 'fallback-bad-format');
    assert.strictEqual(result.rewrite, original);
  });

  it('strict cache-key shape: instruction part of key', async () => {
    let calls = 0;
    const dispatch: TokenIntegrationDispatch = async () => { calls++; return 'POLISHED: out'; };
    const rewrite = 'Long enough rewrite to pass the short-circuit threshold for polish-skip logic here.';
    await runRewritePolish({ instruction: 'A', rewrite }, dispatch, cache);
    await runRewritePolish({ instruction: 'B', rewrite }, dispatch, cache);
    assert.strictEqual(calls, 2); // different instructions → no cache hit
  });
});

describe('buildRewritePolishUserMessage', () => {
  it('emits INSTRUCTION + REWRITE labels', () => {
    const m = buildRewritePolishUserMessage({ instruction: 'draft email', rewrite: 'Hi team, x.' });
    assert.match(m, /^INSTRUCTION: draft email\n/);
    assert.match(m, /REWRITE:\nHi team, x\.$/);
  });
});

describe('buildRewritePolishSystemPrompt', () => {
  it('emits a stable prompt (cerebras prefix-cache anchor)', () => {
    const a = buildRewritePolishSystemPrompt();
    const b = buildRewritePolishSystemPrompt();
    assert.strictEqual(a, b); // determinism — no per-call salt
  });

  it('mentions KEEP and POLISHED shapes', () => {
    const p = buildRewritePolishSystemPrompt();
    assert.match(p, /KEEP/);
    assert.match(p, /POLISHED:/);
  });
});
