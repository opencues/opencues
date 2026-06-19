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
  summonPhraseStart,
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
  it('parses a clean setting hit (legacy 3-line shape, no INTENT)', () => {
    const v = parseConfigIntentOutput(
      'SETTING: debug-mode\nVALUE: on\nCONFIDENCE: 0.97',
    );
    assert.strictEqual(v.kind, 'setting');
    if (v.kind === 'setting') {
      assert.strictEqual(v.setting, 'debug-mode');
      assert.strictEqual(v.value, 'on');
      assert.strictEqual(v.confidence, 0.97);
    }
  });

  it('parses a clean setting hit (new INTENT-prefixed shape)', () => {
    const v = parseConfigIntentOutput(
      'INTENT: SETTING\nSETTING: debug-mode\nVALUE: on\nSCOPE:\nPROVIDER:\nMODEL:\nCONFIDENCE: 0.97',
    );
    assert.strictEqual(v.kind, 'setting');
    if (v.kind === 'setting') {
      assert.strictEqual(v.setting, 'debug-mode');
      assert.strictEqual(v.value, 'on');
    }
  });

  it('parses NONE (no value, no confidence-driven action)', () => {
    const v = parseConfigIntentOutput(
      'SETTING: NONE\nVALUE:\nCONFIDENCE: 0.99',
    );
    assert.strictEqual(v.kind, 'none');
    assert.strictEqual(v.confidence, 0.99);
  });

  it('treats SETTING: none (lowercase) as NONE', () => {
    const v = parseConfigIntentOutput(
      'SETTING: none\nVALUE:\nCONFIDENCE: 0.9',
    );
    assert.strictEqual(v.kind, 'none');
  });

  it('treats empty SETTING as NONE', () => {
    const v = parseConfigIntentOutput('SETTING:\nVALUE:\nCONFIDENCE: 0.9');
    assert.strictEqual(v.kind, 'none');
  });

  it('collapses to NONE when SETTING is present but VALUE is missing (no half-applied)', () => {
    // Old behavior returned setting:'voice-mode', value:null. New
    // behavior: a setting verdict without a value is unactionable, so
    // collapse to NONE — caller cedes cleanly rather than carrying a
    // half-formed verdict.
    const v = parseConfigIntentOutput('SETTING: voice-mode\nCONFIDENCE: 0.9');
    assert.strictEqual(v.kind, 'none');
  });

  it('returns confidence=null when CONFIDENCE line missing', () => {
    const v = parseConfigIntentOutput('SETTING: debug-mode\nVALUE: on');
    assert.strictEqual(v.confidence, null);
  });

  it('tolerates trailing whitespace on each field', () => {
    const v = parseConfigIntentOutput(
      'SETTING: debug-mode  \nVALUE: on \nCONFIDENCE: 0.95',
    );
    assert.strictEqual(v.kind, 'setting');
    if (v.kind === 'setting') {
      assert.strictEqual(v.setting, 'debug-mode');
      assert.strictEqual(v.value, 'on');
    }
  });

  it('returns NONE when output is garbage', () => {
    const v = parseConfigIntentOutput('whatever the model said');
    assert.strictEqual(v.kind, 'none');
  });

  // ── Provider verdict parsing ──────────────────────────────────────

  it('parses a provider verdict with explicit INTENT', () => {
    const v = parseConfigIntentOutput(
      'INTENT: PROVIDER\nSETTING:\nVALUE:\nSCOPE: cues\nPROVIDER: anthropic\nMODEL:\nCONFIDENCE: 0.92',
    );
    assert.strictEqual(v.kind, 'provider');
    if (v.kind === 'provider') {
      assert.strictEqual(v.scope, 'cues');
      assert.strictEqual(v.provider, 'anthropic');
      assert.strictEqual(v.model, null);
      assert.strictEqual(v.confidence, 0.92);
    }
  });

  it('parses a provider verdict with model named', () => {
    const v = parseConfigIntentOutput(
      'INTENT: PROVIDER\nSCOPE: auditors\nPROVIDER: openai\nMODEL: gpt-5.4\nCONFIDENCE: 0.9',
    );
    assert.strictEqual(v.kind, 'provider');
    if (v.kind === 'provider') {
      assert.strictEqual(v.scope, 'auditors');
      assert.strictEqual(v.provider, 'openai');
      assert.strictEqual(v.model, 'gpt-5.4');
    }
  });

  it('infers provider kind from populated slots when INTENT line missing (back-compat)', () => {
    const v = parseConfigIntentOutput(
      'SCOPE: blanks\nPROVIDER: cerebras\nMODEL:\nCONFIDENCE: 0.85',
    );
    assert.strictEqual(v.kind, 'provider');
    if (v.kind === 'provider') {
      assert.strictEqual(v.scope, 'blanks');
      assert.strictEqual(v.provider, 'cerebras');
    }
  });

  it('defaults SCOPE to blanks when classifier omitted it but provider is present', () => {
    // Bare phrases like "switch to anthropic _" route to the blanks
    // bucket — the user-opt-in `_` surface is the most likely target
    // of a bucket-less provider switch.
    const v = parseConfigIntentOutput(
      'INTENT: PROVIDER\nSCOPE:\nPROVIDER: gemini\nMODEL:\nCONFIDENCE: 0.7',
    );
    assert.strictEqual(v.kind, 'provider');
    if (v.kind === 'provider') {
      assert.strictEqual(v.scope, 'blanks');
    }
  });

  it('collapses PROVIDER with empty provider id to NONE', () => {
    const v = parseConfigIntentOutput(
      'INTENT: PROVIDER\nSCOPE: cues\nPROVIDER:\nMODEL:\nCONFIDENCE: 0.5',
    );
    assert.strictEqual(v.kind, 'none');
  });
});

// ---------------------------------------------------------------------------
// validateAgainstRegistry — defence in depth against hallucinated outputs
// ---------------------------------------------------------------------------

describe('validateAgainstRegistry', () => {
  it('passes NONE verdict (nothing to validate)', () => {
    const r = validateAgainstRegistry({ kind: 'none', confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });

  it('passes a real setting (setting, value) pair', () => {
    const r = validateAgainstRegistry({ kind: 'setting', setting: 'debug-mode', value: 'on', confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });

  it('rejects an unknown setting (hallucinated scalar)', () => {
    const r = validateAgainstRegistry({ kind: 'setting', setting: 'definitely-not-a-thing', value: 'on', confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /unknown setting/);
  });

  it('rejects a value not listed under the setting', () => {
    const r = validateAgainstRegistry({ kind: 'setting', setting: 'debug-mode', value: 'maybe', confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /not cyclable/);
  });

  it('rejects identity-context-mode=raw (exposeInMenu: false — footgun)', () => {
    // The classifier system prompt excludes hidden values, but defence
    // in depth: if a model emits it anyway, the runtime must NOT apply
    // a footgun mode on semantic-only intent.
    // (Renamed June 2026 from sentinels-mode → identity-context-mode.)  // LEGACY-NAME-ALLOW: historical narrative
    const r = validateAgainstRegistry({ kind: 'setting', setting: 'identity-context-mode', value: 'raw', confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /not cyclable/);
  });

  it('accepts identity-context-mode=safe (cyclable)', () => {
    const r = validateAgainstRegistry({ kind: 'setting', setting: 'identity-context-mode', value: 'safe', confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });

  // ── Provider verdict validation ───────────────────────────────────

  it('accepts a provider verdict for cues bucket with no model (defaults to providers defaultModel)', () => {
    const r = validateAgainstRegistry({ kind: 'provider', scope: 'cues', provider: 'anthropic', model: null, confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });

  it('accepts a provider verdict with a knownModel', () => {
    const r = validateAgainstRegistry({ kind: 'provider', scope: 'cues', provider: 'anthropic', model: 'claude-opus-4-7', confidence: 0.9 });
    assert.strictEqual(r.ok, true);
  });

  it('rejects an unknown provider id', () => {
    const r = validateAgainstRegistry({ kind: 'provider', scope: 'cues', provider: 'totally-fake-provider', model: null, confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /unknown provider/);
  });

  it('rejects an unknown scope (not in cues/auditors/blanks)', () => {
    // Cast through unknown because the type narrows scope to BucketScope;
    // the runtime validator must still catch a string-typed scope from
    // a parsed verdict whose source we don't trust.
    const r = validateAgainstRegistry({
      kind: 'provider', scope: 'everything' as 'cues', provider: 'anthropic', model: null, confidence: 0.9,
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /unknown scope/);
  });

  it('rejects a model not in the providers knownModels', () => {
    const r = validateAgainstRegistry({ kind: 'provider', scope: 'cues', provider: 'anthropic', model: 'claude-sonnet-9-9', confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /knownModels/);
  });

  it('rejects opencode-zen on the cues bucket (trainsOnInput)', () => {
    // Trust-class guard — mirrors the resolver's build-time refusal.
    // Without it, fluid-config could route prose through a training
    // pool when the resolver would refuse the same wiring.
    const r = validateAgainstRegistry({ kind: 'provider', scope: 'cues', provider: 'opencode-zen', model: null, confidence: 0.9 });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason ?? '', /trains on input/);
  });

  it('rejects opencode-zen on the auditors bucket (trainsOnInput)', () => {
    const r = validateAgainstRegistry({ kind: 'provider', scope: 'auditors', provider: 'opencode-zen', model: null, confidence: 0.9 });
    assert.strictEqual(r.ok, false);
  });

  it('accepts opencode-zen on the blanks bucket (user opt-in surface)', () => {
    const r = validateAgainstRegistry({ kind: 'provider', scope: 'blanks', provider: 'opencode-zen', model: 'free', confidence: 0.9 });
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

  it('getCues with hidden-from-menu value (identity-context=raw): cedes', async () => {
    // The classifier prompt excludes raw from its choice space, but if
    // a model emits it, the runtime must NOT auto-apply a footgun
    // (raw = PII reaches LLM provider's logs).
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'SETTING: identity-context-mode\nVALUE: raw\nCONFIDENCE: 0.99',
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

  // ── Provider routing scenarios ────────────────────────────────────

  it('getCues provider hit (no model): writes only <scope>-llm-provider, satellite display falls back to provider defaultModel', async () => {
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'INTENT: PROVIDER\nSCOPE: cues\nPROVIDER: anthropic\nMODEL:\nCONFIDENCE: 0.92',
      ]),
      applyScalar: apply.fn,
    });
    const input = 'use anthropic for cues _';
    const result = await src.getCues(ctxFromText(input));
    assert.strictEqual(result.results.length, 1);
    // Provider scalar written + sibling model reset to the NEW provider's
    // resolved defaultModel (anthropic → claude-opus-4-7) so any
    // previously-pinned model (incompatible with the new provider) is
    // cleared. Mirrors the cycling-resets-model invariant — fluid-config
    // and cycling must produce identical OPENCUES.md state for an
    // equivalent user intent (provider switch with no model named).
    // Writing the resolved model name (not the legacy `default` sentinel)
    // makes OPENCUES.md self-explanatory and keeps doctor's "inert
    // sentinel" warning silent.
    assert.strictEqual(apply.calls.length, 2);
    assert.deepStrictEqual(apply.calls[0], ['cues-llm-provider', 'anthropic']);
    assert.strictEqual(apply.calls[1]![0], 'cues-llm-model');
    assert.match(apply.calls[1]![1]!, /^claude-/, 'model scalar must be an anthropic defaultModel, not the legacy `default` sentinel');
    const r = result.results[0]!;
    assert.deepStrictEqual(r.alternatives, ['cues-llm-provider']);
    // Display falls back to anthropic's defaultModel so the user always
    // sees the (provider, model) pair, even when they didn't name a model.
    assert.match(String(r.metadata?.satelliteValue), /^anthropic:claude-/);
    // Cycling state stores just the provider so satellite Up/Down walks
    // the provider catalogue, not the model.
    assert.strictEqual(r.metadata?.satelliteCyclingValue, 'anthropic');
    assert.strictEqual(r.metadata?.blankName, 'opencues');
    assert.strictEqual(r.metadata?.selectorBlank, true);
    assert.strictEqual(r.spanStart, 0);
    assert.strictEqual(r.spanEnd, input.length);
  });

  it('getCues provider hit WITH model: writes both <scope>-llm-provider and <scope>-llm-model', async () => {
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'INTENT: PROVIDER\nSCOPE: auditors\nPROVIDER: anthropic\nMODEL: claude-opus-4-7\nCONFIDENCE: 0.9',
      ]),
      applyScalar: apply.fn,
    });
    const result = await src.getCues(ctxFromText('use claude opus for auditors _'));
    assert.strictEqual(result.results.length, 1);
    assert.deepStrictEqual(apply.calls, [
      ['auditors-llm-provider', 'anthropic'],
      ['auditors-llm-model', 'claude-opus-4-7'],
    ]);
  });

  it('getCues provider hit with unknown model: cedes (validator rejects, no half-write)', async () => {
    // Belt-and-braces: even if the prompt instructs the LLM to stay
    // inside knownModels, a regression could leak a hallucinated model
    // id through. The validator rejects; runtime cedes; NEITHER the
    // provider nor the model scalar is written (no half-applied state).
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'INTENT: PROVIDER\nSCOPE: cues\nPROVIDER: anthropic\nMODEL: claude-sonnet-9-9\nCONFIDENCE: 0.9',
      ]),
      applyScalar: apply.fn,
    });
    const result = await src.getCues(ctxFromText('use anthropic claude sonnet 9 for cues _'));
    assert.strictEqual(result.results.length, 0);
    assert.deepStrictEqual(apply.calls, []);
  });

  it('getCues provider hit routing opencode-zen to cues: cedes (trainsOnInput guard)', async () => {
    // The classifier prompt teaches the model not to route training-
    // pool providers to prose buckets, but the validator enforces it
    // structurally. Without this guard the resolver would later refuse
    // the wiring anyway, leaving the user with a silent broken cue
    // surface.
    const apply = noopApply();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([
        'INTENT: PROVIDER\nSCOPE: cues\nPROVIDER: opencode-zen\nMODEL: free\nCONFIDENCE: 0.9',
      ]),
      applyScalar: apply.fn,
    });
    const result = await src.getCues(ctxFromText('use the free pool for cues _'));
    assert.strictEqual(result.results.length, 0);
    assert.deepStrictEqual(apply.calls, []);
  });
});

describe('ConfigIntent: likely-intent gate (pre-filter)', () => {
  // The gate is a cheap keyword check that skips the LLM dispatch
  // when the buffer has no plausible settings/provider intent. False
  // positives (firing when not needed) are absorbed by the variant
  // cache; false negatives (missing a real settings command) would
  // silently break the feature.

  function gateOnly(buffer: string): { fired: boolean; calls: number } {
    let calls = 0;
    const adapter: HttpAdapter = {
      post: async () => {
        calls++;
        return JSON.stringify({ choices: [{ message: { content: 'INTENT: NONE\nSETTING:\nVALUE:\nSCOPE:\nPROVIDER:\nMODEL:\nCONFIDENCE: 0.99' } }] });
      },
    };
    const src = new ConfigIntentSource({
      httpAdapter: adapter,
      provider: getProvider('groq')!,
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: 'x',
      model: 'openai/gpt-oss-120b',
      applyScalar: () => {},
      blanks: {},
    });
    return src.getCues(ctxFromText(buffer)).then(() => ({
      fired: calls > 0,
      calls,
    })) as unknown as { fired: boolean; calls: number };
  }

  for (const buffer of [
    'draft an email _',
    'capital of france _',
    'the cat sat on the mat _',
    'unicode for ampersand _',
    'do the thing _',
    'rewrite for clarity _',
  ]) {
    it(`gates "${buffer}" — no keyword, cedes without LLM call`, async () => {
      const result = await gateOnly(buffer);
      assert.strictEqual(result.calls, 0, 'no LLM dispatch on gate-skip');
    });
  }

  for (const buffer of [
    'enable debug _',
    'change to opus _',
    'use anthropic for cues _',
    'switch to cerebras for blanks _',
    'turn voice mode on _',
    'set tips off _',
    'stop showing tip popups _',
    'make fluid-blank off _',
  ]) {
    it(`fires "${buffer}" — keyword present, dispatch proceeds`, async () => {
      const result = await gateOnly(buffer);
      assert.strictEqual(result.calls, 1, 'LLM dispatched');
    });
  }
});

describe('summonPhraseStart — preserve prior content (no whole-buffer nuke)', () => {
  // Regression for the config-intent nuke: `hii world. voice mode off _`
  // used to wipe [0, len) and lose "hii world.". The wipe must start at
  // the trailing summon phrase, preserving prior user content.
  it('no prior content → 0 (whole buffer is the summon, unchanged behaviour)', () => {
    assert.strictEqual(summonPhraseStart('voice mode off _'), 0);
    assert.strictEqual(summonPhraseStart('switch cues to anthropic _'), 0);
  });

  it('prior sentence → start of the summon (prior content preserved)', () => {
    const t = 'hii world. voice mode off _';
    assert.strictEqual(summonPhraseStart(t), t.indexOf('voice'));
    assert.strictEqual(t.slice(0, summonPhraseStart(t)), 'hii world. ');
  });

  it('multiple prior sentences → after the LAST boundary', () => {
    const t = 'Hi there. How are you. voice mode off _';
    assert.strictEqual(summonPhraseStart(t), t.indexOf('voice'));
  });

  it('line break is a boundary too', () => {
    const t = 'some notes\nvoice mode off _';
    assert.strictEqual(summonPhraseStart(t), t.indexOf('voice'));
  });

  it('model-version dots are NOT sentence boundaries (lookahead needs whitespace)', () => {
    // "gpt-5.4" must not split — the dot is followed by a digit, not ws.
    assert.strictEqual(summonPhraseStart('use gpt-5.4 for cues _'), 0);
  });

  it('? and ! also delimit', () => {
    assert.strictEqual(summonPhraseStart('really? voice mode off _'), 'really? '.length);
    assert.strictEqual(summonPhraseStart('wow! tips off _'), 'wow! '.length);
  });
});
