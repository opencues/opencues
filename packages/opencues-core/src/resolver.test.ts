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

  // Sibling-abort: a higher-priority source emitting a whole-buffer claim
  // (spanStart=0, spanEnd>=text.length — ConfigIntent/selector-satellite/
  // TransformBlank rewrite signature) should abort strictly-lower-priority
  // in-flight siblings. Their LLM results would be wiped by the splice
  // anyway, so the round-trips are pure waste — the wait was previously
  // adding 1–3s of perceived latency to fluid-config when the blanks bucket
  // routed to a slow provider (Claude Opus).
  it('whole-buffer claim from higher-priority source aborts lower-priority sibling signals', async () => {
    let lowSignal: AbortSignal | undefined;
    let lowAborted = false;

    const high: CueSource = {
      id: 'high',
      priority: 94,
      isCycleable: false,
      supports: () => true,
      async getCues(ctx) {
        return {
          results: [{
            wordIndex: 3, word: '_', alternatives: ['HIGH'],
            source: 'high', priority: 94,
            spanStart: 0, spanEnd: ctx.text.length,
          }],
        };
      },
    };
    const low: CueSource = {
      id: 'low',
      priority: 92,
      isCycleable: false,
      supports: () => true,
      async getCues(ctx) {
        lowSignal = ctx.signal;
        // Simulate a slow LLM call. Resolve to nothing if aborted mid-flight.
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 200);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            lowAborted = true;
            resolve();
          });
        });
        return { results: [] };
      },
    };

    const resolver = new CueResolver([high, low], { parallel: true });
    await resolver.resolve(makeContext('x x x _'));

    assert.ok(lowSignal, 'low source should receive a signal in its context');
    assert.strictEqual(lowAborted, true, 'low source signal should fire when high source emits a whole-buffer claim');
  });

  it('ACTION claim (undo/redo) aborts lower-priority siblings EVEN with a non-zero span', async () => {
    // Mirrors `Paris undo _`: the ACTION span starts AFTER prior content
    // ("Paris "), so spanStart !== 0 and it can't ride the wholeBufferClaim
    // path. The undoAction marker must still abort the slow TransformBlank/
    // FluidBlank sibling — otherwise the resolve blocks ~1.5s awaiting a
    // sibling LLM call whose fill would double-apply alongside the undo.
    let lowAborted = false;

    const high: CueSource = {
      id: 'config-intent',
      priority: 94,
      isCycleable: false,
      supports: () => true,
      async getCues(ctx) {
        return {
          results: [{
            wordIndex: 3, word: '_', alternatives: ['undo'],
            source: 'config-intent', priority: 94,
            // Non-zero start — the summon phrase, not the whole buffer.
            spanStart: 6, spanEnd: ctx.text.length,
            metadata: { undoAction: { action: 'undo', count: 1 } },
          }],
        };
      },
    };
    const low: CueSource = {
      id: 'transform-blank',
      priority: 93,
      isCycleable: false,
      supports: () => true,
      async getCues(ctx) {
        // Slow LLM call — resolves to nothing if aborted mid-flight.
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 200);
          ctx.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            lowAborted = true;
            resolve();
          });
        });
        return { results: [] };
      },
    };

    const resolver = new CueResolver([high, low], { parallel: true });
    await resolver.resolve(makeContext('Paris undo _'));

    assert.strictEqual(lowAborted, true, 'lower-priority sibling should abort the moment an ACTION verdict lands, regardless of span');
  });

  it('non-whole-buffer claim does NOT abort lower-priority siblings (point-wise filter still wins)', async () => {
    let lowAborted = false;

    const high: CueSource = {
      id: 'high',
      priority: 94,
      isCycleable: false,
      supports: () => true,
      async getCues(_ctx) {
        // No spanStart/spanEnd → point-wise wordIndex claim, not whole-buffer.
        return {
          results: [{ wordIndex: 3, word: '_', alternatives: ['HIGH'], source: 'high', priority: 94 }],
        };
      },
    };
    const low: CueSource = {
      id: 'low',
      priority: 92,
      isCycleable: false,
      supports: () => true,
      async getCues(ctx) {
        ctx.signal?.addEventListener('abort', () => { lowAborted = true; });
        // Resolve quickly so the test finishes — we just need to observe
        // that no abort fires before the source returns.
        return {
          results: [{ wordIndex: 7, word: '_', alternatives: ['LOW-7'], source: 'low', priority: 92 }],
        };
      },
    };

    const resolver = new CueResolver([high, low], { parallel: true });
    await resolver.resolve(makeContext('x x x _ y y y _'));

    assert.strictEqual(lowAborted, false, 'low source should NOT be aborted — high only claimed wordIndex 3 point-wise');
  });

  it('outer context signal cascades to all sibling sources', async () => {
    const outer = new AbortController();
    let aAborted = false;
    let bAborted = false;

    const a: CueSource = {
      id: 'a',
      priority: 94,
      isCycleable: false,
      supports: () => true,
      async getCues(ctx) {
        ctx.signal?.addEventListener('abort', () => { aAborted = true; });
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 200);
          ctx.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
        });
        return { results: [] };
      },
    };
    const b: CueSource = {
      id: 'b',
      priority: 92,
      isCycleable: false,
      supports: () => true,
      async getCues(ctx) {
        ctx.signal?.addEventListener('abort', () => { bAborted = true; });
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 200);
          ctx.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
        });
        return { results: [] };
      },
    };

    const resolver = new CueResolver([a, b], { parallel: true });
    setTimeout(() => outer.abort(), 30);
    await resolver.resolve({ ...makeContext('x x x _'), signal: outer.signal });

    assert.strictEqual(aAborted, true, 'outer abort should cascade to source a');
    assert.strictEqual(bAborted, true, 'outer abort should cascade to source b');
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

describe('CueResolver: same-word sentence-cues are NOT merged (spaceless CJK)', () => {
  it('two sentence-cue results sharing a wordIndex but with distinct spans both survive', async () => {
    // Two sentences in ONE whitespace-word (no space after 。) carry the
    // SAME firstWordIndex. Keyed by word index alone they would merge into
    // one cue and the second sentence would vanish. Keyed by span, both
    // survive — the runtime then re-homes the collision to a synthetic key.
    const source = stubSource({
      id: 'sentence-cue:more-formal',
      priority: 85,
      result: {
        results: [
          { wordIndex: 0, word: 'x', alternatives: ['第一文。', '第一文(formal)。'], source: 'sentence-cue:more-formal', priority: 85, spanStart: 0, spanEnd: 4 },
          { wordIndex: 0, word: 'x', alternatives: ['第二文。', '第二文(formal)。'], source: 'sentence-cue:more-formal', priority: 85, spanStart: 4, spanEnd: 8 },
        ],
        timing: 1,
      },
    });
    const resolver = new CueResolver([source]);
    const out = await resolver.resolve(makeContext('第一文。第二文。'));
    const sentenceCues = out.results.filter(r => r.source === 'sentence-cue:more-formal');
    assert.strictEqual(sentenceCues.length, 2, 'both same-word sentences must survive the merge');
    const spans = sentenceCues.map(r => `${r.spanStart}-${r.spanEnd}`).sort();
    assert.deepStrictEqual(spans, ['0-4', '4-8']);
  });

  it('genuine word-cue duplicates at one index still merge (no behaviour change off the sentence-cue path)', async () => {
    const source = stubSource({
      id: 'config:grammar',
      priority: 50,
      result: {
        results: [
          { wordIndex: 1, word: 'a', alternatives: ['a', 'an'], source: 'config:grammar', priority: 50 },
          { wordIndex: 1, word: 'a', alternatives: ['a', 'one'], source: 'config:grammar', priority: 50 },
        ],
        timing: 1,
      },
    });
    const resolver = new CueResolver([source]);
    const out = await resolver.resolve(makeContext('x a y'));
    const atOne = out.results.filter(r => r.wordIndex === 1);
    assert.strictEqual(atOne.length, 1, 'non-sentence-cue duplicates still merge into one');
  });
});

describe('CueResolver: parallel mode — an explicit slot-claim aborts lower-priority siblings', () => {
  it('a higher-priority source returning consumedBlankSlots cancels a still-in-flight lower-priority sibling', async () => {
    // Mirrors the ConfigIntent provider-switch case: the classifier claims
    // the `_` (consumedBlankSlots) — even with NO spanned result (a refusal
    // only replaces `_`) — and a slower FluidBlank-style sibling on the same
    // slot must have its in-flight LLM call aborted, not run to completion
    // just to be filtered.
    let lowAborted = false;
    let lowRanToCompletion = false;

    const high: CueSource = {
      id: 'high', priority: 100, isCycleable: false, supports: () => true,
      // Empty-results refusal shape — no spanned result, just the claim.
      async getCues() { return { results: [], consumedBlankSlots: [3] }; },
    };
    const low: CueSource = {
      id: 'low', priority: 50, isCycleable: false, supports: () => true,
      async getCues(ctx) {
        return await new Promise<CueSourceResult>((resolve) => {
          const done = (aborted: boolean) => {
            if (aborted) lowAborted = true; else lowRanToCompletion = true;
            resolve({ results: [] });
          };
          if (ctx.signal?.aborted) { done(true); return; }
          ctx.signal?.addEventListener('abort', () => done(true));
          // Fallback so the test can't hang if the abort never fires.
          setTimeout(() => done(false), 800);
        });
      },
    };

    const resolver = new CueResolver([high, low], { parallel: true });
    await resolver.resolve(makeContext('switch to ollama _'));
    assert.strictEqual(lowAborted, true, 'lower-priority sibling should be aborted by the slot-claim');
    assert.strictEqual(lowRanToCompletion, false, 'lower-priority sibling must NOT run to completion');
  });

  it('no claim → lower-priority sibling runs to completion (abort is scoped to claims)', async () => {
    let lowRanToCompletion = false;
    const high: CueSource = {
      id: 'high', priority: 100, isCycleable: false, supports: () => true,
      async getCues() { return { results: [] }; }, // no consumedBlankSlots
    };
    const low: CueSource = {
      id: 'low', priority: 50, isCycleable: false, supports: () => true,
      async getCues(ctx) {
        return await new Promise<CueSourceResult>((resolve) => {
          if (ctx.signal?.aborted) { resolve({ results: [] }); return; }
          ctx.signal?.addEventListener('abort', () => resolve({ results: [] }));
          setTimeout(() => { lowRanToCompletion = true; resolve({ results: [] }); }, 50);
        });
      },
    };
    const resolver = new CueResolver([high, low], { parallel: true });
    await resolver.resolve(makeContext('the sky today looks _'));
    assert.strictEqual(lowRanToCompletion, true, 'without a claim, the sibling must finish normally');
  });
});
