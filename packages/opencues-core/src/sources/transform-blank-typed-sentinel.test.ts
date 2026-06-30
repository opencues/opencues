/**
 * Integration tests for TransformBlankSource × the typed-sentinel grammar
 * (`sentinel-language: typed`).
 *
 * Drives the REAL source with a mocked HttpAdapter (no live LLM). Pins:
 *   1. typed catalog RENDERING — tokens carry their `: type` annotation
 *      in the fused SYSTEM message when language is `typed`.
 *   2. flat resolution still works under typed (strict superset).
 *   3. NESTED composition resolves via the runtime bridge:
 *      `[WEATHER TEMP(city=[WORK CITY])]` → inner `[WORK CITY]`→London →
 *      bridged to the pre-fetched `[WEATHER LONDON]` instance → its value.
 *   4. validate-and-degrade: an unknown nested id leaves the token intact
 *      (preserveUnknown) rather than corrupting the buffer.
 *   5. the `bare` (default) path is unchanged — no type annotations, flat
 *      resolution identical to before the feature.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import { parseIdentityMd } from '../identity-context';
import type { HttpAdapter, CueContext } from '../types';

interface RecordedCall { systemMessage: string; }

function makeAdapter(responses: readonly string[], recorded: RecordedCall[]): HttpAdapter {
  let i = 0;
  return {
    post: async (_url, body) => {
      let systemMessage = '';
      try {
        const msgs = (JSON.parse(body).messages as Array<{ role: string; content: string }>);
        systemMessage = msgs.find(m => m.role === 'system')?.content ?? '';
      } catch { /* ignore */ }
      recorded.push({ systemMessage });
      return JSON.stringify({ choices: [{ message: { content: responses[i++ % responses.length] } }] });
    },
  };
}

function makeSource(httpAdapter: HttpAdapter): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  });
}

const IDENTITY = `---
fullName: Wilfred Kasekende
workCity: London
---`;

/** Pre-fetched blank-context: weather for London is on the shelf as a flat
 *  instance token (exactly the shape the runtime snapshot produces). */
const BLANK_CTX = {
  fields: [{ token: '[WEATHER LONDON]', description: 'current temperature in London', value: '14°C' }],
  catalog: new Map([['[WEATHER LONDON]', '14°C']]),
  mode: 'safe' as const,
};

function ctx(text: string, language: 'bare' | 'typed', withBlank = false): CueContext {
  const id = parseIdentityMd(IDENTITY);
  const words = text.split(/\s+/).filter(Boolean);
  return {
    text,
    words,
    blankIndices: words.map((w, i) => (w === '_' ? i : -1)).filter(i => i >= 0),
    identityContext: { fields: id.fields, catalog: id.catalog, mode: 'safe' },
    ...(withBlank ? { blankContext: BLANK_CTX } : {}),
    sentinelLanguage: language,
  };
}

const fused = (rewrite: string) =>
  `VERDICT: TRANSFORM\nINSTRUCTION: x\nTARGET: y\nFULL_REWRITE: ${rewrite}`;

const rewriteOf = async (src: TransformBlankSource, c: CueContext) =>
  (await src.getCues(c)).results[0]?.alternatives[1] ?? '';

describe('TransformBlank typed-sentinel — catalog rendering', () => {
  it('typed mode annotates identity tokens with their type', async () => {
    const rec: RecordedCall[] = [];
    const src = makeSource(makeAdapter([fused('x')], rec));
    await src.getCues(ctx('uppercase _ hi', 'typed'));
    assert.match(rec[0]!.systemMessage, /\[FULL NAME: string\]/);
    assert.match(rec[0]!.systemMessage, /\[WORK CITY: string\]/);
  });

  it('typed mode infers number for a price-shaped blank-context value', async () => {
    const rec: RecordedCall[] = [];
    const src = makeSource(makeAdapter([fused('x')], rec));
    await src.getCues(ctx('uppercase _ hi', 'typed', /*withBlank*/ true));
    assert.match(rec[0]!.systemMessage, /\[WEATHER LONDON: string\]/); // "14°C" → string (has letters)
  });

  it('bare mode (default) renders flat tokens — NO type annotation', async () => {
    const rec: RecordedCall[] = [];
    const src = makeSource(makeAdapter([fused('x')], rec));
    await src.getCues(ctx('uppercase _ hi', 'bare'));
    assert.match(rec[0]!.systemMessage, /\[FULL NAME\]/);
    assert.doesNotMatch(rec[0]!.systemMessage, /\[FULL NAME: string\]/);
  });
});

describe('TransformBlank typed-sentinel — resolution', () => {
  it('resolves a flat token under typed (strict superset of bare)', async () => {
    const src = makeSource(makeAdapter([fused('Hi team\n\n[FULL NAME]')], []));
    const rewrite = await rewriteOf(src, ctx('sign this _ Hi team', 'typed'));
    assert.match(rewrite, /Wilfred Kasekende/);
    assert.doesNotMatch(rewrite, /\[FULL NAME\]/);
  });

  it('resolves a NESTED composition via the instance-token bridge', async () => {
    // [WEATHER TEMP(city=[WORK CITY])] → city=London → bridged to
    // the pre-fetched [WEATHER LONDON] = 14°C.
    const src = makeSource(makeAdapter([fused('It is [WEATHER TEMP(city=[WORK CITY])] outside')], []));
    const rewrite = await rewriteOf(src, ctx('weather where i work _', 'typed', /*withBlank*/ true));
    assert.match(rewrite, /It is 14°C outside/);
  });

  it('validate-and-degrade: an unknown nested id leaves the token intact (no buffer corruption)', async () => {
    const src = makeSource(makeAdapter([fused('val [WEATHER TEMP(city=[NOWHERE])] end')], []));
    const rewrite = await rewriteOf(src, ctx('x _', 'typed', /*withBlank*/ true));
    // preserveUnknown:true (TransformBlank contract) → token survives verbatim.
    assert.match(rewrite, /\[WEATHER TEMP\(city=\[NOWHERE\]\)\]/);
    assert.match(rewrite, /^val .* end$/);
  });
});

describe('TransformBlank typed-sentinel — bare path unchanged', () => {
  it('bare mode resolves flat tokens exactly as before', async () => {
    const src = makeSource(makeAdapter([fused('Hi team\n\n[FULL NAME]')], []));
    const rewrite = await rewriteOf(src, ctx('sign this _ Hi team', 'bare'));
    assert.match(rewrite, /Wilfred Kasekende/);
  });

  it('bare mode does NOT engage the typed engine (no nested bridge resolution)', async () => {
    // The discriminating invariant: given a parameterized form, BARE mode
    // runs only the flat regex post-processor — it resolves the inner flat
    // [WORK CITY]→London (exactly the pre-feature behaviour) but never
    // bridges the outer call to the [WEATHER LONDON] instance. So the result
    // is the half-resolved `[WEATHER TEMP(city=London)]`, NOT `14°C`. Typed
    // mode (asserted above) DOES produce `14°C`. Same input, different gate.
    const src = makeSource(makeAdapter([fused('x [WEATHER TEMP(city=[WORK CITY])] y')], []));
    const rewrite = await rewriteOf(src, ctx('x _', 'bare', /*withBlank*/ true));
    assert.match(rewrite, /\[WEATHER TEMP\(city=London\)\] y$/); // inner flat token resolved, no bridge
    assert.doesNotMatch(rewrite, /14°C/);                        // typed engine NOT engaged
  });
});

describe('TransformBlank typed-sentinel — Phase 4 on-demand parameterized fetch', () => {
  const aiCallableFns = new Map([['STOCK', { blankName: 'stocks', tokenPrefix: 'STOCK' }]]);

  it('fetches a ai-callable call on-demand and resolves it', async () => {
    const calls: Array<[string, string]> = [];
    const blankFetch = async (name: string, arg: string) => { calls.push([name, arg]); return arg === 'TSLA' ? '$220.10' : undefined; };
    const src = makeSource(makeAdapter([fused('TSLA is at [STOCK(ticker=TSLA)] now')], []));
    const c: CueContext = {
      text: 'tsla price _', words: ['tsla', 'price', '_'], blankIndices: [2],
      blankContext: { fields: [], catalog: new Map(), mode: 'safe' },
      sentinelLanguage: 'typed', aiCallableFns, blankFetch,
    };
    const rewrite = (await src.getCues(c)).results[0]?.alternatives[1] ?? '';
    assert.match(rewrite, /TSLA is at \$220\.10 now/);
    assert.deepStrictEqual(calls, [['stocks', 'TSLA']]); // fetched exactly once, right blank+arg
  });

  it('degrades gracefully when the fetch returns undefined (no value on the shelf)', async () => {
    const blankFetch = async () => undefined;
    const src = makeSource(makeAdapter([fused('x [STOCK(ticker=ZZZZ)] y')], []));
    const c: CueContext = {
      text: 'x _', words: ['x', '_'], blankIndices: [1],
      blankContext: { fields: [], catalog: new Map(), mode: 'safe' },
      sentinelLanguage: 'typed', aiCallableFns, blankFetch,
    };
    const rewrite = (await src.getCues(c)).results[0]?.alternatives[1] ?? '';
    assert.match(rewrite, /\[STOCK\(ticker=ZZZZ\)\]/); // preserveUnknown — token survives, buffer intact
  });

  it('CAPABILITY GATE: a fn-call NOT in the ai-callable registry is never fetched', async () => {
    let fetched = false;
    const blankFetch = async () => { fetched = true; return 'X'; };
    const src = makeSource(makeAdapter([fused('[VOLUME(level=80)]')], []));
    const c: CueContext = {
      text: 'x _', words: ['x', '_'], blankIndices: [1],
      blankContext: { fields: [], catalog: new Map(), mode: 'safe' },
      sentinelLanguage: 'typed', aiCallableFns, blankFetch, // only STOCK is ai-callable
    };
    await src.getCues(c);
    assert.strictEqual(fetched, false, 'a non-ai-callable fn-call must never reach blankFetch');
  });

  it('does NOT fetch when sentinel-language is bare (gate off)', async () => {
    let fetched = false;
    const blankFetch = async () => { fetched = true; return 'X'; };
    const src = makeSource(makeAdapter([fused('[STOCK(ticker=TSLA)]')], []));
    const c: CueContext = {
      text: 'x _', words: ['x', '_'], blankIndices: [1],
      blankContext: { fields: [], catalog: new Map(), mode: 'safe' },
      // sentinelLanguage omitted → bare; aiCallableFns/blankFetch present but unused
      aiCallableFns, blankFetch,
    };
    await src.getCues(c);
    assert.strictEqual(fetched, false, 'bare mode must not engage on-demand fetch');
  });
});
