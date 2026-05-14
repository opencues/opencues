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
