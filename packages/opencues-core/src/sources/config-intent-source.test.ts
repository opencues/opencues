/**
 * Tests for config-intent-source.ts
 *
 * Run with: vitest packages/opencues-core/src/sources/config-intent-source.test.ts
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  ConfigIntentSource,
  parseConfigIntentOutput,
  validateAgainstRegistry,
} from './config-intent-source';
import type { CueContext, HttpAdapter } from '../types';
import { getProvider } from '../llm-provider';

function makeMockAdapter(responses: string[]): HttpAdapter {
  let i = 0;
  return {
    post: async () => {
      const r = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: r } }] });
    },
  };
}

function makeFailingAdapter(): HttpAdapter {
  return { post: async () => { throw new Error('network down'); } };
}

function ctxFromText(text: string): CueContext {
  return { text, words: text.split(/\s+/) };
}

// ---------------------------------------------------------------------------
// parseConfigIntentOutput — must handle every shape the LLM might return
// ---------------------------------------------------------------------------

describe('parseConfigIntentOutput', () => {
  it('parses a clean hit (all three lines)', () => {
    const v = parseConfigIntentOutput(
      'SETTING: debug-mode\nVALUE: on\nCONFIDENCE: 0.97',
    );
    assert.strictEqual(v.setting, 'debug-mode');
    assert.strictEqual(v.value, 'on');
    assert.strictEqual(v.confidence, 0.97);
  });

  it('parses NONE (no value, no confidence-driven action)', () => {
    const v = parseConfigIntentOutput(
      'SETTING: NONE\nVALUE:\nCONFIDENCE: 0.99',
    );
    assert.strictEqual(v.setting, null);
    assert.strictEqual(v.value, null);
    assert.strictEqual(v.confidence, 0.99);
  });

  it('treats SETTING: none (lowercase) as NONE', () => {
    const v = parseConfigIntentOutput(
      'SETTING: none\nVALUE:\nCONFIDENCE: 0.9',
    );
    assert.strictEqual(v.setting, null);
  });

  it('treats empty SETTING as NONE', () => {
    const v = parseConfigIntentOutput('SETTING:\nVALUE:\nCONFIDENCE: 0.9');
    assert.strictEqual(v.setting, null);
    assert.strictEqual(v.value, null);
  });

  it('returns value=null when hit lacks a VALUE line', () => {
    const v = parseConfigIntentOutput('SETTING: voice-mode\nCONFIDENCE: 0.9');
    assert.strictEqual(v.setting, 'voice-mode');
    assert.strictEqual(v.value, null);
  });

  it('returns confidence=null when CONFIDENCE line missing', () => {
    const v = parseConfigIntentOutput('SETTING: debug-mode\nVALUE: on');
    assert.strictEqual(v.confidence, null);
  });

  it('tolerates trailing whitespace on each field', () => {
    const v = parseConfigIntentOutput(
      'SETTING: debug-mode  \nVALUE: on \nCONFIDENCE: 0.95',
    );
    assert.strictEqual(v.setting, 'debug-mode');
    assert.strictEqual(v.value, 'on');
  });

  it('returns null setting + null value when output is garbage', () => {
    const v = parseConfigIntentOutput('whatever the model said');
    assert.strictEqual(v.setting, null);
    assert.strictEqual(v.value, null);
  });
});

// ---------------------------------------------------------------------------
// validateAgainstRegistry — defence in depth against hallucinated outputs
// ---------------------------------------------------------------------------

describe('validateAgainstRegistry', () => {
  it('passes NONE verdict (nothing to validate)', () => {
    const r = validateAgainstRegistry({ setting: null, value: null, confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });

  it('passes a real (setting, value) pair', () => {
    const r = validateAgainstRegistry({ setting: 'debug-mode', value: 'on', confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });

  it('rejects an unknown setting (hallucinated scalar)', () => {
    const r = validateAgainstRegistry({ setting: 'definitely-not-a-thing', value: 'on', confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /unknown setting/);
  });

  it('rejects a known setting with no value', () => {
    const r = validateAgainstRegistry({ setting: 'debug-mode', value: null, confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /no value/);
  });

  it('rejects a value not listed under the setting', () => {
    const r = validateAgainstRegistry({ setting: 'debug-mode', value: 'maybe', confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /not cyclable/);
  });

  it('rejects user-context-mode=raw (exposeInMenu: false — footgun)', () => {
    // The classifier system prompt excludes hidden values, but defence
    // in depth: if a model emits it anyway, the runtime must NOT apply
    // a footgun mode on semantic-only intent.
    const r = validateAgainstRegistry({ setting: 'user-context-mode', value: 'raw', confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /not cyclable/);
  });

  it('accepts user-context-mode=safe (cyclable)', () => {
    const r = validateAgainstRegistry({ setting: 'user-context-mode', value: 'safe', confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });
});

// ---------------------------------------------------------------------------
// ConfigIntentSource — getCues / supports / cede-on-keyword
// ---------------------------------------------------------------------------

describe('ConfigIntentSource', () => {
  const baseConfig = {
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  };

  function noopApply(): { calls: Array<[string, string]>; fn: (s: string, v: string) => void } {
    const calls: Array<[string, string]> = [];
    return { calls, fn: (s, v) => { calls.push([s, v]); } };
  }

  it('supports() returns false when input has no _', () => {
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      applyScalar: noopApply().fn,
    });
    assert.strictEqual(src.supports(ctxFromText('plain text no blank')), false);
  });

  it('supports() returns true when input has _ and no keyword claims it', () => {
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      applyScalar: noopApply().fn,
    });
    assert.strictEqual(src.supports(ctxFromText('enable debug logging _')), true);
  });

  it('supports() cedes when a keyword-bound blank would claim the _', () => {
    const blanks = {
      volume: { name: 'volume', blankKeywords: ['volume'], blankProximity: 3 },
    };
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      applyScalar: noopApply().fn,
      blanks,
    });
    // Keyword in range → BlankSource will claim, ConfigIntent cedes.
    assert.strictEqual(src.supports(ctxFromText('change volume _')), false);
    // Keyword OUT of range → ConfigIntent stays in.
    assert.strictEqual(src.supports(ctxFromText('change volume because we hate quiet music _')), true);
  });

  it('priority defaults to 94 (above transform-blank 93, below BlankSource 95)', () => {
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      applyScalar: noopApply().fn,
    });
    assert.strictEqual(src.priority, 94);
  });

  it('getCues hit: calls applyScalar AND emits selector-satellite shape', async () => {
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SETTING: debug-mode\nVALUE: on\nCONFIDENCE: 0.97',
      ]),
      applyScalar: apply.fn,
    });
    const input = 'enable debug logging _';
    const result = await src.getCues(ctxFromText(input));
    assert.strictEqual(result.results.length, 1, 'expected one CueResult');
    assert.deepStrictEqual(apply.calls, [['debug-mode', 'on']], 'expected applyScalar to fire exactly once');
    const r = result.results[0]!;
    // SELECTOR-SATELLITE SHAPE — mirrors the result BlankSource emits
    // for keyword-bound `opencues settings _` so the runtime can wipe
    // the summon words and splice in "<setting><sep><value>" with
    // full satellite cycling active.
    assert.deepStrictEqual(r.alternatives, ['debug-mode']);
    assert.strictEqual(r.source, 'config-intent');
    assert.strictEqual(r.priority, 94);
    assert.strictEqual(r.word, '_');
    // Span must cover the WHOLE input — that's how the resolver wipes
    // the summon words. spanStart=0, spanEnd=input.length.
    assert.strictEqual(r.spanStart, 0);
    assert.strictEqual(r.spanEnd, input.length);
    // Metadata: blankName routes the cycling-state lookup to the
    // OpenCuesSettingsBlank; selectorBlank+satelliteValue tells the
    // resolver to splice the pair shape; configIntent carries the
    // classifier's verdict for debug/telemetry.
    assert.strictEqual(r.metadata?.blankName, 'opencues');
    assert.strictEqual(r.metadata?.selectorBlank, true);
    assert.strictEqual(r.metadata?.satelliteValue, 'on');
    assert.strictEqual(r.metadata?.displaySeparator, ' ');
    assert.deepStrictEqual(r.metadata?.configIntent, {
      setting: 'debug-mode',
      value: 'on',
      confidence: 0.97,
    });
  });

  it('getCues NONE: cedes (empty results) AND does NOT call applyScalar', async () => {
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SETTING: NONE\nVALUE:\nCONFIDENCE: 0.99',
      ]),
      applyScalar: apply.fn,
    });
    const result = await src.getCues(ctxFromText('capital of france _'));
    assert.strictEqual(result.results.length, 0, 'expected zero results so FluidBlank can take over');
    assert.deepStrictEqual(apply.calls, [], 'NONE verdict must never write a setting');
  });

  it('getCues with invalid verdict (unknown setting): cedes AND does NOT call applyScalar', async () => {
    // Defence in depth: even if the model hallucinates a setting that
    // doesn't exist in FEATURES, the runtime must reject it. Without
    // this check a future model regression could route to /dev/null.
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SETTING: definitely-not-a-real-setting\nVALUE: on\nCONFIDENCE: 0.99',
      ]),
      applyScalar: apply.fn,
    });
    const result = await src.getCues(ctxFromText('do the thing _'));
    assert.strictEqual(result.results.length, 0);
    assert.deepStrictEqual(apply.calls, []);
  });

  it('getCues with hidden-from-menu value (user-context=raw): cedes', async () => {
    // The classifier prompt excludes raw from its choice space, but if
    // a model emits it, the runtime must NOT auto-apply a footgun
    // (raw = PII reaches LLM provider's logs).
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SETTING: user-context-mode\nVALUE: raw\nCONFIDENCE: 0.99',
      ]),
      applyScalar: apply.fn,
    });
    const result = await src.getCues(ctxFromText('let it use everything about me _'));
    assert.strictEqual(result.results.length, 0);
    assert.deepStrictEqual(apply.calls, []);
  });

  it('getCues with LLM error: cedes (does not throw, does not apply)', async () => {
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeFailingAdapter(),
      applyScalar: apply.fn,
    });
    const result = await src.getCues(ctxFromText('enable debug _'));
    assert.strictEqual(result.results.length, 0);
    assert.deepStrictEqual(apply.calls, []);
  });

  it('getCues when applyScalar throws: cedes (no result, no half-applied state)', async () => {
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SETTING: debug-mode\nVALUE: on\nCONFIDENCE: 0.97',
      ]),
      applyScalar: () => { throw new Error('file locked'); },
    });
    const result = await src.getCues(ctxFromText('enable debug logging _'));
    // The write failed, so showing a confirmation marker would lie to
    // the user about state. Bail.
    assert.strictEqual(result.results.length, 0);
  });

  it('applyScalar can be async (Promise<void> contract)', async () => {
    const calls: Array<[string, string]> = [];
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SETTING: tips-mode\nVALUE: off\nCONFIDENCE: 0.95',
      ]),
      applyScalar: async (s, v) => {
        await new Promise(r => setTimeout(r, 1));
        calls.push([s, v]);
      },
    });
    const result = await src.getCues(ctxFromText('stop showing tip popups _'));
    assert.deepStrictEqual(calls, [['tips-mode', 'off']]);
    assert.strictEqual(result.results.length, 1);
  });
});
