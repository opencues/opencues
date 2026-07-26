/**
 * Tests for the answerReplacesQuery → WIPE-span plumbing.
 *
 * When a host declares that the destination field IS the question box
 * (`CueContext.answerReplacesQuery` — the mac host sets it while
 * Spotlight is focused: ~37 visible chars can't hold the question AND
 * its answer), FluidBlankSource emits a whole-buffer spanStart/spanEnd
 * so the resolver's existing WIPE splice replaces the typed query with
 * the answer. Four structural contracts pinned here:
 *
 *   1. Absent by default — no flag, no span. Every other host keeps the
 *      non-destructive FILL behaviour byte-for-byte (which is also what
 *      keeps the fluid-blank bench evidence valid without re-runs).
 *   2. The span is DETERMINISTIC (whole buffer), never derived from the
 *      model's SPAN line — a slot-splice source must not trust
 *      LLM-claimed bounds (docs/architecture/blank-sources.md).
 *   3. Shape guards: multi-line buffers and a non-trailing `_` refuse
 *      the wipe. A no-cycling host has no Ctrl+Alt+Down, so anything
 *      wiped is unrecoverable — the guards are the safety net.
 *   4. The variant-cache path wipes identically to a fresh answer (the
 *      buffer shape that produced the cache key is the same one).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { FluidBlankSource, replaceQuerySpan } from './fluid-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter } from '../types';

function makeAdapter(responses: readonly string[]): HttpAdapter {
  let i = 0;
  return {
    post: async () => JSON.stringify({
      choices: [{ message: { content: responses[i++ % responses.length] } }],
    }),
  };
}

const baseConfig = {
  provider: getProvider('groq')!,
  endpoint: 'https://example.test/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
};

function ctx(text: string, answerReplacesQuery?: boolean) {
  return {
    text,
    words: text.split(/\s+/).filter(Boolean),
    ...(answerReplacesQuery === undefined ? {} : { answerReplacesQuery }),
  };
}

describe('replaceQuerySpan', () => {
  it('covers the whole one-line buffer when `_` trails it', () => {
    assert.deepStrictEqual(replaceQuerySpan('capital of france _'), [0, 19]);
    assert.deepStrictEqual(replaceQuerySpan('_'), [0, 1]);
    // Trailing spaces/tabs belong to the query, not to content after it.
    assert.deepStrictEqual(replaceQuerySpan('capital of france _  '), [0, 21]);
  });

  it('refuses a multi-line buffer (the user\'s own content, not a query)', () => {
    assert.strictEqual(replaceQuerySpan('a note\ncapital of france _'), null);
    assert.strictEqual(replaceQuerySpan('capital of france _\n'), null);
  });

  it('refuses a non-trailing `_` (FILL is the only correct splice there)', () => {
    assert.strictEqual(replaceQuerySpan('water boils at _ degrees'), null);
    assert.strictEqual(replaceQuerySpan('_ is the capital of france'), null);
  });

  it('refuses a `_` that is part of a word', () => {
    assert.strictEqual(replaceQuerySpan('rename foo_bar_'), null);
  });
});

describe('FluidBlankSource — WIPE span (answerReplacesQuery)', () => {
  it('emits the whole-buffer span when the host asks for it', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeAdapter(['SPAN: capital of france _\nANSWER: Paris\nMODE: WIPE']),
    });
    const out = await src.getCues(ctx('capital of france _', true));
    const r = out.results[0]!;
    assert.strictEqual(r.spanStart, 0);
    assert.strictEqual(r.spanEnd, 'capital of france _'.length);
    assert.deepStrictEqual(r.alternatives, ['_', 'Paris']);
    assert.strictEqual((r.metadata as { fluidBlankMode?: string }).fluidBlankMode, 'WIPE');
  });

  it('emits NO span without the flag — plain FILL, unchanged shape', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeAdapter(['SPAN: capital of spain _\nANSWER: Madrid\nMODE: WIPE']),
    });
    const out = await src.getCues(ctx('capital of spain _'));
    const r = out.results[0]!;
    assert.strictEqual(r.spanStart, undefined, 'no span → resolver fills only the `_`');
    assert.strictEqual(r.spanEnd, undefined);
    assert.strictEqual((r.metadata as { fluidBlankMode?: string }).fluidBlankMode, 'FILL');
  });

  it('ignores the model\'s MODE vote — the span is the host\'s call', async () => {
    // MODE: FILL from the model, flag on → still a wipe. The vote has
    // been advisory-only since the WIPE heuristic was retired.
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeAdapter(['SPAN: capital of italy _\nANSWER: Rome\nMODE: FILL']),
    });
    const out = await src.getCues(ctx('capital of italy _', true));
    assert.strictEqual(out.results[0]!.spanStart, 0);
    assert.strictEqual(out.results[0]!.spanEnd, 'capital of italy _'.length);
  });

  it('span is the buffer, not the model\'s claimed SPAN substring', async () => {
    // The model claims a span that is BOTH shorter than the buffer and
    // not verbatim in it. Neither may influence the splice bounds.
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeAdapter(['SPAN: totally different text\nANSWER: Lisbon\nMODE: WIPE']),
    });
    const text = 'ok so capital of portugal _';
    const out = await src.getCues(ctx(text, true));
    assert.strictEqual(out.results[0]!.spanStart, 0);
    assert.strictEqual(out.results[0]!.spanEnd, text.length);
  });

  it('flag on + guard-refused buffer shape → FILL, no span', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeAdapter(['SPAN: water boils at _ degrees\nANSWER: water boils at 100 degrees\nMODE: FILL']),
    });
    const out = await src.getCues(ctx('water boils at _ degrees', true));
    assert.strictEqual(out.results[0]!.spanStart, undefined);
    assert.strictEqual((out.results[0]!.metadata as { fluidBlankMode?: string }).fluidBlankMode, 'FILL');
  });

  it('variant-cache hit wipes the same span as the fresh answer', async () => {
    const src = new FluidBlankSource({
      ...baseConfig,
      httpAdapter: makeAdapter([
        'SPAN: capital of japan _\nANSWER: Tokyo\nMODE: WIPE',
        'SPAN: capital of japan _\nANSWER: Tokyo, Japan\nMODE: WIPE',
        'SPAN: capital of japan _\nANSWER: Tōkyō\nMODE: WIPE',
      ]),
    });
    const text = 'capital of japan _';
    // Fill the variant pool (3 fresh dispatches on an identical buffer),
    // then the next identical trigger is served from the pool.
    for (let i = 0; i < 3; i++) {
      const fresh = await src.getCues(ctx(text, true));
      assert.strictEqual((fresh.results[0]!.metadata as { variantCacheHit?: boolean }).variantCacheHit, false);
    }
    const cached = await src.getCues(ctx(text, true));
    const r = cached.results[0]!;
    assert.strictEqual((r.metadata as { variantCacheHit?: boolean }).variantCacheHit, true);
    assert.strictEqual(r.spanStart, 0);
    assert.strictEqual(r.spanEnd, text.length);
    assert.strictEqual((r.metadata as { fluidBlankMode?: string }).fluidBlankMode, 'WIPE');
  });
});
