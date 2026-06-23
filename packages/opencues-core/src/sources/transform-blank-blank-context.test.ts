/**
 * Tests for TransformBlankSource — blank-as-context wiring.
 *
 * Mirrors `transform-blank-sentinels.test.ts` but for the ambient
 * blank-context catalog ([WEATHER LONDON], [CRYPTO BTC], [STOCKS NVDA], …).
 * Pins three integration points:
 *
 *   1. CATALOG INJECTION — when `CueContext.blankContext` is populated,
 *      the transform-flavoured BLANK CONTEXT block is appended to the
 *      single fused call's SYSTEM message. Off mode = no block reaches
 *      the LLM (structural no-op).
 *
 *   2. TOKEN RESOLUTION — when the LLM emits a token from the catalog
 *      (`[WEATHER LONDON]`), the post-processor substitutes the live
 *      value into the rewrite before it lands in the runtime buffer.
 *
 *   3. preserveUnknown — TransformBlank passes preserveUnknown:true so
 *      LLM-emitted placeholders for non-catalog entities (`[Recipient]`,
 *      `[Date]`) survive untouched. The fluid-blank renderer keeps the
 *      default strip behaviour; the transform variant explicitly does NOT.
 *
 * No live LLM — HttpAdapter is mocked. Recorded calls inspect the prompt
 * body shape; the source's parsed output asserts substitution + bracket
 * survival.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import type { HttpAdapter, CueContext } from '../types';

interface RecordedCall {
  body: string;
  userMessage: string;
  systemMessage: string;
}

function makeRecordingAdapter(
  responses: readonly string[],
  recorded: RecordedCall[],
): HttpAdapter {
  let i = 0;
  return {
    post: async (_url, body) => {
      let userMessage = '';
      let systemMessage = '';
      try {
        const parsed = JSON.parse(body);
        const msgs = parsed.messages as Array<{ role: string; content: string }>;
        userMessage = msgs.find(m => m.role === 'user')?.content ?? '';
        systemMessage = msgs.find(m => m.role === 'system')?.content ?? '';
      } catch { /* unparseable */ }
      recorded.push({ body, userMessage, systemMessage });
      const next = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: next } }] });
    },
  };
}

function makeFusedSource(httpAdapter: HttpAdapter): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  });
}

const BLANK_FIELDS = [
  { token: '[WEATHER LONDON]', description: 'current weather in London', value: 'London: 18°C Overcast' },
  { token: '[CRYPTO BTC]',     description: 'current USD price of BTC',  value: 'BITCOIN: $63,568.00' },
  { token: '[STOCKS NVDA]',    description: 'current share price of NVDA', value: 'NVDA: $220.86' },
];
const BLANK_CATALOG = new Map(BLANK_FIELDS.map(f => [f.token, f.value]));

function ctxWithBlank(text: string, mode: 'safe' | 'raw' = 'safe'): CueContext {
  return {
    text,
    words: text.split(/\s+/).filter(Boolean),
    blankIndices: text.split(/\s+/).filter(Boolean)
      .map((w, i) => (w === '_' ? i : -1))
      .filter(i => i >= 0),
    blankContext: { fields: BLANK_FIELDS, catalog: BLANK_CATALOG, mode },
  };
}

function ctxNoBlank(text: string): CueContext {
  return {
    text,
    words: text.split(/\s+/).filter(Boolean),
    blankIndices: text.split(/\s+/).filter(Boolean)
      .map((w, i) => (w === '_' ? i : -1))
      .filter(i => i >= 0),
  };
}

const fused = (instruction: string, target: string, rewrite: string, verdict = 'TRANSFORM') =>
  `VERDICT: ${verdict}\nINSTRUCTION: ${instruction}\nTARGET: ${target}\nFULL_REWRITE: ${rewrite}`;

// ───────────────────────────────────────────────────────────────────────
// 1. CATALOG INJECTION
// ───────────────────────────────────────────────────────────────────────

describe('TransformBlankSource — BLANK CONTEXT catalog injection (FUSED)', () => {
  it('appends BLANK CONTEXT block to the fused SYSTEM message when blankContext is present', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [fused('uppercase', 'hello', 'HELLO')];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithBlank('uppercase _ hello'));
    assert.strictEqual(recorded.length, 1, 'exactly one fused call');
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('BLANK CONTEXT'),
      `fused SYSTEM message should carry the BLANK CONTEXT block. Got: ${sys.slice(0, 400)}`);
    assert.ok(sys.includes('[WEATHER LONDON]'), 'catalog should list [WEATHER LONDON]');
    assert.ok(sys.includes('[CRYPTO BTC]'), 'catalog should list [CRYPTO BTC]');
    assert.ok(sys.includes('[STOCKS NVDA]'), 'catalog should list [STOCKS NVDA]');
  });

  it('safe mode: catalog lists tokens + descriptions but NOT live values', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hi', 'HI')], recorded));
    await src.getCues(ctxWithBlank('uppercase _ hi', 'safe'));
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('BLANK CONTEXT'), 'expected a fused call carrying the BLANK CONTEXT block');
    assert.ok(!sys.includes('18°C'),
      `safe mode must NOT leak live values to LLM. Got: ${sys.slice(0, 400)}`);
    assert.ok(!sys.includes('$63,568'),
      'safe mode must NOT leak BTC price to LLM');
  });

  it('raw mode: catalog inlines current values', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hi', 'HI')], recorded));
    await src.getCues(ctxWithBlank('uppercase _ hi', 'raw'));
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('current value: London: 18°C Overcast'),
      `raw mode should inline values. Got snippet: ${sys.slice(0, 400)}`);
  });

  it('omits BLANK CONTEXT entirely when blankContext is undefined', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hi', 'HI')], recorded));
    await src.getCues(ctxNoBlank('uppercase _ hi'));
    for (const c of recorded) {
      assert.ok(!c.userMessage.includes('BLANK CONTEXT') && !c.systemMessage.includes('BLANK CONTEXT'),
        `off mode must produce NO BLANK CONTEXT block. Got system: ${c.systemMessage.slice(0, 200)}`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// 2. TOKEN RESOLUTION (post-processor substitutes live values)
// ───────────────────────────────────────────────────────────────────────

describe('TransformBlankSource — BLANK CONTEXT post-processor substitution (FUSED)', () => {
  it('substitutes [WEATHER LONDON] with the live value in FUSED rewrite', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      fused(
        'compose email about today\'s weather',
        '',
        'Hi there,\n\nJust a quick note about today: [WEATHER LONDON].\n\nBest,\n[Recipient Name]',
      ),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
    const result = await src.getCues(ctxWithBlank('compose email about today\'s weather _'));
    const rewrite = result.results[0]?.alternatives?.[1] ?? '';
    assert.ok(rewrite.includes('London: 18°C Overcast'),
      `expected substituted live value. Got: ${rewrite.slice(0, 400)}`);
    assert.ok(!rewrite.includes('[WEATHER LONDON]'),
      `token must be resolved, not left in body. Got: ${rewrite.slice(0, 400)}`);
  });

  it('preserves unknown brackets (preserveUnknown:true) — [Recipient Name] survives', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      fused(
        'compose email about btc',
        '',
        'Hi [Recipient Name],\n\nQuick update — [CRYPTO BTC].\n\nThanks,\n[Sender]',
      ),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
    const result = await src.getCues(ctxWithBlank('compose email about btc _'));
    const rewrite = result.results[0]?.alternatives?.[1] ?? '';
    assert.ok(rewrite.includes('BITCOIN: $63,568.00'),
      `expected substituted BTC value. Got: ${rewrite.slice(0, 400)}`);
    assert.ok(rewrite.includes('[Recipient Name]'),
      `unknown bracket must survive (preserveUnknown:true). Got: ${rewrite.slice(0, 400)}`);
    assert.ok(rewrite.includes('[Sender]'),
      `unknown bracket must survive. Got: ${rewrite.slice(0, 400)}`);
  });
});
