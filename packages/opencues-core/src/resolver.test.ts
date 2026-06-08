/**
 * Tests for CueResolver — focuses on the `consumedBlankSlots` channel
 * that lets TransformBlank claim-and-bail without FluidBlank "vandalising"
 * the slot downstream.
 *
 * Run with: node --test dist/resolver.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CueResolver } from './resolver';
import type { CueContext, CueSource, CueSourceResult } from './types';

function makeContext(text: string, overrides: Partial<CueContext> = {}): CueContext {
  return { text, words: text.split(/\s+/), ...overrides };
}

/** Stub source — captures every context it sees and returns the configured result. */
function stubSource(opts: {
  id: string;
  priority?: number;
  result: CueSourceResult;
  seenContexts?: CueContext[];
}): CueSource {
  return {
    id: opts.id,
    priority: opts.priority ?? 50,
    isCycleable: false,
    supports: () => true,
    async getCues(ctx) {
      opts.seenContexts?.push(ctx);
      return opts.result;
    },
  };
}

describe('CueResolver: consumedBlankSlots forwarding', () => {
  it('propagates consumed slots from an upstream source into the downstream context', async () => {
    const downstreamSeen: CueContext[] = [];
    const upstream = stubSource({
      id: 'upstream',
      priority: 100,
      result: { results: [], consumedBlankSlots: [3] },
    });
    const downstream = stubSource({
      id: 'downstream',
      priority: 50,
      result: { results: [] },
      seenContexts: downstreamSeen,
    });

    const resolver = new CueResolver([upstream, downstream], { parallel: false });
    await resolver.resolve(makeContext('write a poem about love _'));

    assert.strictEqual(downstreamSeen.length, 1);
    assert.deepStrictEqual(downstreamSeen[0].consumedBlankSlots, [3]);
  });

  it('does not propagate when upstream did not consume any slots', async () => {
    const downstreamSeen: CueContext[] = [];
    const upstream = stubSource({
      id: 'upstream',
      priority: 100,
      result: { results: [] }, // no consumedBlankSlots
    });
    const downstream = stubSource({
      id: 'downstream',
      priority: 50,
      result: { results: [] },
      seenContexts: downstreamSeen,
    });

    const resolver = new CueResolver([upstream, downstream], { parallel: false });
    await resolver.resolve(makeContext('atomic number of oxygen _'));

    assert.strictEqual(downstreamSeen.length, 1);
    // Either undefined or empty — both mean "no slots consumed"
    const consumed = downstreamSeen[0].consumedBlankSlots;
    assert.ok(consumed === undefined || consumed.length === 0);
  });

  it('accumulates consumed slots across multiple upstream sources', async () => {
    const finalSeen: CueContext[] = [];
    const s1 = stubSource({ id: 's1', priority: 100, result: { results: [], consumedBlankSlots: [3] } });
    const s2 = stubSource({ id: 's2', priority: 80,  result: { results: [], consumedBlankSlots: [7] } });
    const s3 = stubSource({ id: 's3', priority: 50,  result: { results: [] }, seenContexts: finalSeen });

    const resolver = new CueResolver([s1, s2, s3], { parallel: false });
    await resolver.resolve(makeContext('two slots _ here and _ also'));

    const consumed = finalSeen[0].consumedBlankSlots ?? [];
    assert.ok(consumed.includes(3), `expected slot 3 to be consumed: ${JSON.stringify(consumed)}`);
    assert.ok(consumed.includes(7), `expected slot 7 to be consumed: ${JSON.stringify(consumed)}`);
  });

  it('preserves consumedBlankSlots already on the input context', async () => {
    const seen: CueContext[] = [];
    const source = stubSource({ id: 's', priority: 50, result: { results: [] }, seenContexts: seen });

    const resolver = new CueResolver([source], { parallel: false });
    await resolver.resolve(makeContext('foo _ bar', { consumedBlankSlots: [42] }));

    assert.deepStrictEqual([...(seen[0].consumedBlankSlots ?? [])], [42]);
  });

  it('does NOT mutate the original input context', async () => {
    const upstream = stubSource({ id: 'u', priority: 100, result: { results: [], consumedBlankSlots: [3] } });
    const downstream = stubSource({ id: 'd', priority: 50, result: { results: [] } });

    const resolver = new CueResolver([upstream, downstream], { parallel: false });
    const input = makeContext('x _ y');
    await resolver.resolve(input);

    // Caller's view of the context must not have grown a new field.
    assert.strictEqual(input.consumedBlankSlots, undefined);
  });
});

describe('CueResolver: parallel mode — higher-priority claims suppress lower-priority sibling results', () => {
  // The runtime always passes `parallel: true`. Pre-fix, sources still
  // received an empty `consumedBlankSlots` (each dispatched against the
  // same starting context), but the post-dispatch processing didn't
  // enforce the claim — a lower-priority source's `wordIndex` results
  // overlapping a higher-priority source's `consumedBlankSlots` (or its
  // own filled wordIndex) would slip through, "vandalising" the
  // higher-priority intent. This block pins the post-dispatch
  // reconciliation that was added to the parallel branch.

  it('lower-priority source\'s result is dropped when the same wordIndex was claimed-but-empty by a higher-priority source', async () => {
    // TransformBlank shape: high priority, claims slot 3, emits NO
    // results (claim-and-bail).
    const transform = stubSource({
      id: 'transform-blank',
      priority: 93,
      result: { results: [], consumedBlankSlots: [3] },
    });
    // FluidBlank shape: lower priority, doesn't know about the claim
    // because both fired in parallel — emits a lookup answer for slot 3.
    const fluid = stubSource({
      id: 'fluid-blank',
      priority: 92,
      result: {
        results: [{
          wordIndex: 3, word: '_', alternatives: ['8'],
          source: 'fluid-blank', priority: 92,
        }],
      },
    });

    const resolver = new CueResolver([transform, fluid], { parallel: true });
    const out = await resolver.resolve(makeContext('atomic number of oxygen _'));

    // FluidBlank's result MUST be filtered out — TransformBlank claimed
    // slot 3 with a higher-priority bail.
    assert.strictEqual(out.results.length, 0, `expected 0 merged results, got ${out.results.length}`);
  });

  it('lower-priority source\'s result is dropped when a HIGHER-priority source produced its own content for the same wordIndex', async () => {
    // Two sources race for slot 3; higher priority wins.
    const high = stubSource({
      id: 'high',
      priority: 93,
      result: {
        results: [{ wordIndex: 3, word: '_', alternatives: ['HIGH'], source: 'high', priority: 93 }],
      },
    });
    const low = stubSource({
      id: 'low',
      priority: 92,
      result: {
        results: [{ wordIndex: 3, word: '_', alternatives: ['LOW'], source: 'low', priority: 92 }],
      },
    });

    const resolver = new CueResolver([high, low], { parallel: true });
    const out = await resolver.resolve(makeContext('x x x _'));

    assert.strictEqual(out.results.length, 1);
    assert.deepStrictEqual(out.results[0].alternatives, ['HIGH']);
  });

  it('lower-priority source results on DIFFERENT wordIndices survive — only overlapping ones are filtered', async () => {
    const high = stubSource({
      id: 'high',
      priority: 93,
      result: {
        results: [{ wordIndex: 3, word: '_', alternatives: ['HIGH'], source: 'high', priority: 93 }],
      },
    });
    const low = stubSource({
      id: 'low',
      priority: 92,
      result: {
        results: [
          { wordIndex: 3, word: '_', alternatives: ['LOW-3'], source: 'low', priority: 92 }, // dropped
          { wordIndex: 7, word: '_', alternatives: ['LOW-7'], source: 'low', priority: 92 }, // survives
        ],
      },
    });

    const resolver = new CueResolver([high, low], { parallel: true });
    const out = await resolver.resolve(makeContext('x x x _ y y y _'));

    assert.strictEqual(out.results.length, 2);
    const byIdx = new Map(out.results.map(r => [r.wordIndex, r.alternatives]));
    assert.deepStrictEqual(byIdx.get(3), ['HIGH']);
    assert.deepStrictEqual(byIdx.get(7), ['LOW-7']);
  });

  it('a source\'s own consumedBlankSlots does NOT filter its own results (a source can fill the slot it claimed)', async () => {
    const source = stubSource({
      id: 's',
      priority: 50,
      result: {
        consumedBlankSlots: [3],
        results: [
          { wordIndex: 3, word: '_', alternatives: ['I-CLAIMED-AND-FILLED'], source: 's', priority: 50 },
        ],
      },
    });

    const resolver = new CueResolver([source], { parallel: true });
    const out = await resolver.resolve(makeContext('x x x _'));

    assert.strictEqual(out.results.length, 1);
    assert.deepStrictEqual(out.results[0].alternatives, ['I-CLAIMED-AND-FILLED']);
  });
});
