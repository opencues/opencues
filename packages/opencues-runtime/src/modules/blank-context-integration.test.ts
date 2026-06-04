/**
 * End-to-end integration test for blank-as-context.
 *
 * Pins the full flow:
 *   1. Parse a BLANK.md frontmatter that opts a blank into context.
 *   2. Read a sentinels-bound parameter list.
 *   3. Plan slots from (config × sentinels).
 *   4. Snapshot via the cache calling Blank.get(slot).
 *   5. Hand the snapshot to FluidBlank's CueContext.
 *   6. Render the catalog block into the system prompt
 *      (via renderBlankContextCatalog directly — we don't need to
 *      spin up the full LLM stack).
 *   7. Run the merged catalog through postProcessContext and
 *      verify substitution produces the live value.
 *
 * This sits one layer below a real LLM round-trip — we don't need
 * the network to verify the wiring. The bench
 * (tests/benchmarks/blank-sentinels-matrix/) is the LLM-quality gate;
 * this test is the structural-wiring gate.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSingleCueMd,
  parseIdentityMd,
  planBlankContextSlots,
  renderBlankContextCatalog,
  postProcessContext,
  mergeCatalogs,
} from '@opencues/core';
import { BlankContextCache } from './blank-context-cache';
import type { Blank } from '../blanks/types';

class StubBlank implements Blank {
  readonly readOnly = true;
  constructor(
    public readonly name: string,
    private readonly _impl: (slot: string) => Promise<string>,
  ) {}
  async get(slot?: string): Promise<string> {
    return this._impl(slot ?? '');
  }
}

describe('blank-as-context end-to-end wiring', () => {
  it('frontmatter → plan → snapshot → render → substitute', async () => {
    // 1. SENTINELS.md content. Single field: portfolio with 3 tickers.
    const sentinels = parseIdentityMd(`---
portfolio: AAPL,NVDA,GOOG
---`);
    expect(sentinels.fields.length).toBe(1);

    // 2. BLANK.md content for stocks with as-context: safe, split-bound.
    const stocksConfig = parseSingleCueMd(
      `---
type: blank
name: stocks
blankKeywords: stocks
impl: StocksBlank
as-context: safe
context-ttl: 60
context-bind: portfolio
context-bind-split: ","
split-values-in-token-names: ok
---`,
      'stocks',
      '/tmp/stocks',
    );
    expect(stocksConfig.blanks?.stocks).toBeDefined();
    const blankCfg = stocksConfig.blanks!.stocks;
    expect(blankCfg.asContext).toBe('safe');
    expect(blankCfg.contextBind).toBe('portfolio');
    expect(blankCfg.contextBindSplit).toBe(',');
    expect(blankCfg.splitValuesInTokenNamesAck).toBe(true);

    // 3. Plan slots from the (config × sentinels) tuple.
    const plan = planBlankContextSlots(blankCfg, sentinels);
    expect(plan.slots.map(s => s.token)).toEqual([
      '[STOCK AAPL]',
      '[STOCK NVDA]',
      '[STOCK GOOG]',
    ]);
    expect(plan.warnings).toEqual([]);

    // 4. Snapshot via the cache. The stub blank returns a price-shape string.
    const stocksBlank = new StubBlank('stocks', async slot => `${slot}: $${100 + slot.length}`);
    const cache = new BlankContextCache();
    const snapshot = await cache.snapshot(
      plan.slots,
      new Map<string, Blank>([['stocks', stocksBlank]]),
      new Map([['stocks', 60_000]]),
    );
    expect(snapshot.fields.length).toBe(3);
    expect(snapshot.catalog.get('[STOCK AAPL]')).toBe('AAPL: $104');
    expect(snapshot.catalog.get('[STOCK NVDA]')).toBe('NVDA: $104');

    // 5. Render the catalog block as FluidBlank would for its prompt.
    const promptBlock = renderBlankContextCatalog(snapshot, 'safe');
    expect(promptBlock).toContain('[STOCK AAPL] —');
    expect(promptBlock).toContain('[STOCK NVDA] —');
    expect(promptBlock).toContain('[STOCK GOOG] —');
    // Safe mode: values absent from the prompt text itself.
    expect(promptBlock).not.toContain('$104');

    // 6. Simulate an LLM emitting one of the listed tokens.
    const mockedLlmOutput = "AAPL is at [STOCK AAPL] today";

    // 7. Run substitution. Identity catalog is empty here — only
    // blank-context tokens flow through.
    const merged = mergeCatalogs(sentinels.catalog, snapshot.catalog);
    const post = postProcessContext(mockedLlmOutput, { catalog: merged });
    expect(post.output).toBe('AAPL is at AAPL: $104 today');
    expect(post.report.resolved).toEqual([{ token: '[STOCK AAPL]', value: 'AAPL: $104' }]);
    expect(post.report.stripped).toEqual([]);
  });

  it('hallucinated context-style tokens get stripped, listed ones substitute', async () => {
    const sentinels = parseIdentityMd(`---
portfolio: AAPL
---`);
    const stocksConfig = parseSingleCueMd(
      `---
type: blank
name: stocks
blankKeywords: stocks
as-context: safe
context-bind: portfolio
context-bind-split: ","
split-values-in-token-names: ok
---`,
      'stocks',
      '/tmp/stocks',
    );
    const blankCfg = stocksConfig.blanks!.stocks;
    const plan = planBlankContextSlots(blankCfg, sentinels);
    const stocksBlank = new StubBlank('stocks', async slot => `${slot}: $245`);
    const cache = new BlankContextCache();
    const snapshot = await cache.snapshot(
      plan.slots,
      new Map<string, Blank>([['stocks', stocksBlank]]),
      new Map([['stocks', 60_000]]),
    );

    // LLM hallucinates [STOCK TSLA] (not in catalog) alongside the listed one.
    const out = postProcessContext(
      'AAPL=[STOCK AAPL], TSLA=[STOCK TSLA]',
      { catalog: snapshot.catalog },
    );
    expect(out.output).toBe('AAPL=AAPL: $245, TSLA=');
    expect(out.report.resolved.length).toBe(1);
    expect(out.report.stripped).toEqual(['[STOCK TSLA]']);
  });

  it('sentinel catalog wins on token-name collision', async () => {
    // A user defines a sentinel `STOCK_AAPL: my-pinned-value` (silly,
    // but pins the wins-rule). The runtime-fetched blank value must
    // not override it.
    const sentinels = parseIdentityMd(`---
stockAapl: pinned-by-user
portfolio: AAPL
---`);
    const stocksConfig = parseSingleCueMd(
      `---
type: blank
name: stocks
blankKeywords: stocks
as-context: safe
context-bind: portfolio
context-bind-split: ","
split-values-in-token-names: ok
---`,
      'stocks',
      '/tmp/stocks',
    );
    const blankCfg = stocksConfig.blanks!.stocks;
    const plan = planBlankContextSlots(blankCfg, sentinels);
    const stocksBlank = new StubBlank('stocks', async slot => `${slot}: $runtime-fetched`);
    const snapshot = await new BlankContextCache().snapshot(
      plan.slots,
      new Map<string, Blank>([['stocks', stocksBlank]]),
      new Map([['stocks', 60_000]]),
    );
    const merged = mergeCatalogs(sentinels.catalog, snapshot.catalog);
    // The sentinel's derived token is [STOCK AAPL] — sentinel value wins.
    expect(merged.get('[STOCK AAPL]')).toBe('pinned-by-user');
  });

  it('mode gate composition: blank-context raw downgrades to safe when sentinels not raw', () => {
    // This rule is enforced in config-loader. The test pin lives in
    // its own config-loader test; we just verify here that the runtime
    // contract surface (the mode field on a snapshot is what FluidBlank
    // sees) is honoured downstream — when mode is 'safe' the catalog
    // block omits values; when 'raw' it inlines them.
    const snapshot = {
      fields: [{ token: '[STOCK AAPL]', description: 'AAPL price', value: '$245' }],
      catalog: new Map([['[STOCK AAPL]', '$245']]),
    };
    const safeBlock = renderBlankContextCatalog(snapshot, 'safe');
    const rawBlock = renderBlankContextCatalog(snapshot, 'raw');
    expect(safeBlock).not.toContain('$245');
    expect(rawBlock).toContain('current value: $245');
  });
});
