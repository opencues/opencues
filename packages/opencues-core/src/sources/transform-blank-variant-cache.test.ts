/**
 * Tests for the TransformBlankSource variant pool — the multi-rewrite
 * cache that lets re-triggers on the same buffer cycle through prior
 * fresh rewrites without re-dispatching.
 *
 * Pins:
 *   - First POOL_SIZE triggers are fresh (each dispatches an LLM call,
 *     accumulates in the pool).
 *   - After pool fills, subsequent triggers serve from cache (no LLM
 *     call) until the cycle exhausts.
 *   - After cycle exhausts, ONE fresh trigger refreshes the pool
 *     (FIFO-evicts oldest), then cycling resumes.
 *   - Pattern after warmup: 1 fresh + N cache + 1 fresh + N cache + …
 *     where N = POOL_SIZE.
 *   - The variant pool tracks entries on the (single) fused path —
 *     `variantPoolSize(key)` grows as fresh rewrites accumulate.
 *   - The alternatives array carries [original, served, ...others]
 *     so DynDef cycling Up-arrow walks variant history.
 *
 * Mock LLM emits the same VERDICT/REWRITE pair on every call but with
 * an incrementing counter in the rewrite, so we can distinguish
 * variant N from variant M.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';

function makeMockAdapter(rewriteSeed: string): { adapter: HttpAdapter; callCount: () => number } {
  let calls = 0;
  const adapter: HttpAdapter = {
    post: async (_url, _body) => {
      calls++;
      const response = [
        'VERDICT: TRANSFORM',
        'INSTRUCTION: make formal',
        'TARGET: the email is too casual',
        `REWRITE: ${rewriteSeed}-variant-${calls}`,
      ].join('\n');
      return JSON.stringify({ choices: [{ message: { content: response } }] });
    },
  };
  return { adapter, callCount: () => calls };
}

function mkContext(): CueContext {
  return {
    text: 'make formal _ the email is too casual',
    words: ['make', 'formal', '_', 'the', 'email', 'is', 'too', 'casual'],
  };
}

describe('TransformBlankSource variant pool — state machine', () => {
  // Module-level pool — reset between tests so order doesn't matter.
  beforeEach(() => {
    TransformBlankSource.resetVariantPoolForTest();
  });

  it('building phase: first 3 triggers all dispatch fresh, pool fills 1 → 3', async () => {
    const { adapter, callCount } = makeMockAdapter('R');
    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });
    const ctx = mkContext();

    const r1 = await source.getCues(ctx);
    assert.strictEqual(callCount(), 1, 'T1: dispatched fresh');
    assert.deepStrictEqual(r1.results[0].alternatives, [ctx.text, 'R-variant-1']);
    assert.strictEqual(r1.results[0].metadata?.variantCacheHit, false);
    assert.strictEqual(r1.results[0].metadata?.variantPoolSize, 1);

    const r2 = await source.getCues(ctx);
    assert.strictEqual(callCount(), 2, 'T2: dispatched fresh');
    assert.strictEqual(r2.results[0].alternatives[0], ctx.text);
    assert.strictEqual(r2.results[0].alternatives[1], 'R-variant-2');
    assert.deepStrictEqual(r2.results[0].alternatives.slice(2).sort(), ['R-variant-1'], 'priors at 2+');
    assert.strictEqual(r2.results[0].metadata?.variantPoolSize, 2);

    const r3 = await source.getCues(ctx);
    assert.strictEqual(callCount(), 3, 'T3: dispatched fresh');
    assert.strictEqual(r3.results[0].alternatives[1], 'R-variant-3');
    assert.deepStrictEqual(r3.results[0].alternatives.slice(2).sort(), ['R-variant-1', 'R-variant-2']);
    assert.strictEqual(r3.results[0].metadata?.variantPoolSize, 3);
  });

  it('cycling phase: triggers 4-6 serve from cache, no LLM calls', async () => {
    const { adapter, callCount } = makeMockAdapter('R');
    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });
    const ctx = mkContext();

    // Fill pool to capacity (3 fresh calls).
    await source.getCues(ctx);
    await source.getCues(ctx);
    await source.getCues(ctx);
    assert.strictEqual(callCount(), 3);

    // Triggers 4-6 should serve from cache.
    const r4 = await source.getCues(ctx);
    assert.strictEqual(callCount(), 3, 'T4: cache hit, no LLM call');
    assert.strictEqual(r4.results[0].metadata?.variantCacheHit, true);
    assert.strictEqual(r4.results[0].metadata?.pipelineMode, 'variant-cache');
    assert.strictEqual(r4.results[0].metadata?.pipelineLatencyMs, 0);

    const r5 = await source.getCues(ctx);
    assert.strictEqual(callCount(), 3, 'T5: cache hit');
    assert.strictEqual(r5.results[0].metadata?.variantCacheHit, true);

    const r6 = await source.getCues(ctx);
    assert.strictEqual(callCount(), 3, 'T6: cache hit');

    // Cached variants served are the 3 originally generated (R-variant-1..3),
    // in cycle order. Each call's alternatives[1] is a different cached
    // variant.
    const served = [r4, r5, r6].map(r => r.results[0].alternatives[1]);
    assert.deepStrictEqual(served.sort(), ['R-variant-1', 'R-variant-2', 'R-variant-3'], 'all 3 variants served exactly once during cycle');
  });

  it('refresh phase: after cycle exhausts, one fresh trigger evicts oldest', async () => {
    const { adapter, callCount } = makeMockAdapter('R');
    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });
    const ctx = mkContext();

    // 3 fresh + 3 cache = 6 triggers, callCount=3
    for (let i = 0; i < 6; i++) await source.getCues(ctx);
    assert.strictEqual(callCount(), 3);

    // T7 should be fresh, replacing R-variant-1 (oldest).
    const r7 = await source.getCues(ctx);
    assert.strictEqual(callCount(), 4, 'T7: dispatched fresh after cycle exhaust');
    assert.strictEqual(r7.results[0].metadata?.variantCacheHit, false);
    assert.strictEqual(r7.results[0].alternatives[1], 'R-variant-4');
    // Pool now has variants 2, 3, 4. Others include 2 and 3.
    const others = r7.results[0].alternatives.slice(2).sort();
    assert.deepStrictEqual(others, ['R-variant-2', 'R-variant-3'], 'oldest (R-variant-1) FIFO-evicted');
  });

  it('alternatives shape: [original, served, ...priors] — DynDef cycling sees variant history', async () => {
    const { adapter } = makeMockAdapter('R');
    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });
    const ctx = mkContext();

    await source.getCues(ctx);
    await source.getCues(ctx);
    const r = await source.getCues(ctx);

    const alts = r.results[0].alternatives;
    assert.strictEqual(alts[0], ctx.text, 'index 0 = original (Down arrow reverts)');
    assert.strictEqual(alts[1], 'R-variant-3', 'index 1 = served (current substitution)');
    // alts[2..] = prior variants (Up arrow cycles through these). After
    // 3 fresh dispatches the full pool is [R1, R2, R3]; index 1 is R3,
    // so others are R1 + R2.
    assert.strictEqual(alts.length, 4);
    assert.deepStrictEqual(alts.slice(2).sort(), ['R-variant-1', 'R-variant-2']);
  });

  it('fused path tracks pool entries — variantPoolSize grows per fresh trigger', async () => {
    // FUSED is now the only pipeline. Each fresh trigger should append
    // one entry to the keyed pool (until POOL_SIZE), so variantPoolSize
    // climbs 0 → 1 → 2 across the building phase.
    const { adapter } = makeMockAdapter('R');
    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('groq')!,
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: 'x',
      model: 'openai/gpt-oss-120b',
    });
    const ctx = mkContext();
    const key = source.cacheKeyForTest(ctx);

    // Pool should be empty before any trigger.
    assert.strictEqual(source.variantPoolSize(key), 0);

    await source.getCues(ctx);
    assert.strictEqual(source.variantPoolSize(key), 1, 'pool grew to 1 after first fresh trigger');

    await source.getCues(ctx);
    assert.strictEqual(source.variantPoolSize(key), 2, 'pool grew to 2 after second fresh trigger');
  });

  it('different cache keys: different providers do not share pool', async () => {
    const { adapter: a1 } = makeMockAdapter('CEREBRAS');
    const cerebrasSource = new TransformBlankSource({
      httpAdapter: a1,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });
    const ctx = mkContext();

    await cerebrasSource.getCues(ctx);
    const r2 = await cerebrasSource.getCues(ctx);
    assert.strictEqual(r2.results[0].alternatives[1], 'CEREBRAS-variant-2');

    const key1 = cerebrasSource.cacheKeyForTest(ctx);
    assert.match(key1, /cerebras/, 'key includes provider id');
  });

  it('pool SURVIVES source instance rebuild — second source with same config hits prior pool', async () => {
    // Simulate what happens on chrome: the resolver rebuilds frequently
    // (focus shift flips supportsCycling() → build key change → new
    // source instance). Pre-fix, each new instance had a fresh empty
    // pool and the cache never accumulated entries. Post-fix, the
    // module-level static pool persists across instances.
    const { adapter: a1, callCount: c1 } = makeMockAdapter('SHARED');
    const source1 = new TransformBlankSource({
      httpAdapter: a1,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });
    const ctx = mkContext();

    // Fill pool with source1 (3 fresh calls).
    await source1.getCues(ctx);
    await source1.getCues(ctx);
    await source1.getCues(ctx);
    assert.strictEqual(c1(), 3, 'source1 dispatched 3 fresh');

    // Simulate resolver rebuild — new source instance, SAME config.
    const { adapter: a2, callCount: c2 } = makeMockAdapter('OTHER');
    const source2 = new TransformBlankSource({
      httpAdapter: a2,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });

    // source2's FIRST trigger should hit the cache populated by source1.
    const r = await source2.getCues(ctx);
    assert.strictEqual(c2(), 0, 'source2 hit cache without dispatching');
    assert.strictEqual(r.results[0].metadata?.variantCacheHit, true);
    // Served rewrite came from source1's pool — recognisable by the
    // SHARED prefix (source2's mock would have produced OTHER).
    assert.match(r.results[0].alternatives[1] as string, /^SHARED-/, 'served from source1\'s pool');
  });

  it('different buffer text yields different cache key', async () => {
    const { adapter } = makeMockAdapter('R');
    const source = new TransformBlankSource({
      httpAdapter: adapter,
      provider: getProvider('cerebras')!,
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: 'x',
      model: 'gpt-oss-120b',
    });
    const ctxA: CueContext = {
      text: 'make formal _ email A',
      words: ['make', 'formal', '_', 'email', 'A'],
    };
    const ctxB: CueContext = {
      text: 'make formal _ email B',
      words: ['make', 'formal', '_', 'email', 'B'],
    };

    const keyA = source.cacheKeyForTest(ctxA);
    const keyB = source.cacheKeyForTest(ctxB);
    assert.notStrictEqual(keyA, keyB, 'different buffer text → different keys');
  });
});
