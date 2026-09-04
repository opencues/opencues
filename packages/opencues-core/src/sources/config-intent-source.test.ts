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
  resolveSummonStart,
  parseSummonOutput,
  hasLikelyIntent,
  matchDeterministicAction,
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

  it('host-scope guard: a chrome-only setting is rejected on a non-chrome host', () => {
    // statusbar-position is scoped to chrome. On a CLI host (or no host)
    // it must be refused even though it's a valid FEATURE, so a
    // hallucinated cross-host emit can never write it.
    const onCC = validateAgainstRegistry({ kind: 'setting', setting: 'statusbar-position', value: 'top', confidence: 0.9 }, 'claude-code');
    assert.strictEqual(onCC.ok, false);
    assert.match(onCC.reason ?? '', /scoped to/);
    const noHost = validateAgainstRegistry({ kind: 'setting', setting: 'statusbar-position', value: 'top', confidence: 0.9 });
    assert.strictEqual(noHost.ok, false);
    // ...but accepted on chrome.
    const onChrome = validateAgainstRegistry({ kind: 'setting', setting: 'statusbar-position', value: 'top', confidence: 0.9 }, 'chrome');
    assert.strictEqual(onChrome.ok, true);
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

  it('supports() cedes when a keyword-bound blank is on the same line as _', () => {
    const blanks = {
      volume: { name: 'volume', blankKeywords: ['volume'] },
    };
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([]),
      applyScalar: noopApply().fn,
      blanks,
    });
    // Keyword on the same line → BlankSource will claim, ConfigIntent cedes.
    assert.strictEqual(src.supports(ctxFromText('change volume _')), false);
    // Line-scoped: keyword anywhere on the `_`'s line still cedes.
    assert.strictEqual(src.supports(ctxFromText('change volume because we hate quiet music _')), false);
    // Keyword on a PREVIOUS line → ConfigIntent stays in.
    assert.strictEqual(src.supports(ctxFromText('change volume settings\nturn it down _')), true);
  });

  it('a trailing bare undo/redo preempts a blank claim (ACTION wins over the shape)', () => {
    const blanks = {
      volume: { name: 'volume', blankKeywords: ['volume'] },
    };
    // undo-mode ON — the trailing command must reach the ACTION gate even
    // though the `volume` keyword would otherwise claim the `_`.
    const on = new ConfigIntentSource({
      ...baseConfig, httpAdapter: makeMockAdapter([]), applyScalar: noopApply().fn,
      blanks, allowActionVerdicts: true,
    });
    assert.strictEqual(on.supports(ctxFromText('volume undo _')), true);
    assert.strictEqual(on.supports(ctxFromText('volume redo _')), true);
    // A plain blank query still cedes (no trailing action).
    assert.strictEqual(on.supports(ctxFromText('volume _')), false);
    // undo-mode OFF — no preempt; the blank claim stands.
    const off = new ConfigIntentSource({
      ...baseConfig, httpAdapter: makeMockAdapter([]), applyScalar: noopApply().fn, blanks,
    });
    assert.strictEqual(off.supports(ctxFromText('volume undo _')), false);
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

  it('getCues hit: regex-confident short-circuit resolves the span WITHOUT a summon call (punctuated prior content)', async () => {
    const apply = noopApply();
    // "morning notes. " ends in `.` + space → the regex finds the boundary
    // confidently, so NO summon call fires (only the classifier). 1 POST.
    const input = 'morning notes. voice mode off _';
    let posts = 0;
    const adapter: HttpAdapter = {
      post: async () => { posts++; return JSON.stringify({ choices: [{ message: { content: 'INTENT: SETTING\nSETTING: voice-mode\nVALUE: inactive\nCONFIDENCE: 0.95' } }] }); },
    };
    const src = new ConfigIntentSource({ ...baseConfig, httpAdapter: adapter, applyScalar: apply.fn });
    const r = (await src.getCues(ctxFromText(input))).results[0]!;
    assert.deepStrictEqual(apply.calls, [['voice-mode', 'inactive']]);
    assert.strictEqual(posts, 1, 'no summon call — regex found the boundary');
    assert.strictEqual(r.spanStart, input.indexOf('voice mode off _'));
    assert.strictEqual(input.slice(0, r.spanStart), 'morning notes. ');
  });

  // Content-aware two-call adapter. With the parallelised span resolution
  // the SUMMON call can fire BEFORE the classifier, so order-based mocks are
  // unreliable — route by which system prompt the request carried.
  function ciTwoCall(classify: string, summon: string): { adapter: HttpAdapter; count: () => number } {
    let n = 0;
    const adapter: HttpAdapter = {
      post: async (_url: string, body: string) => {
        n++;
        const isSummon = body.includes('COMMAND SPAN'); // unique to SUMMON_PROMPT
        return JSON.stringify({ choices: [{ message: { content: isSummon ? summon : classify } }] });
      },
    };
    return { adapter, count: () => n };
  }

  it('getCues hit: SUMMON call drives the span when the regex cannot segment the prior content (Thai, no punctuation)', async () => {
    const apply = noopApply();
    // Thai prior content with no sentence punctuation → regex returns 0, so
    // the concurrent summon call is what preserves the prior note.
    const input = 'ฉันเขียนโน้ต turn on tips _';
    assert.strictEqual(summonPhraseStart(input), 0, 'regex cannot segment Thai — summon needed');
    const { adapter, count } = ciTwoCall(
      'INTENT: SETTING\nSETTING: tips-mode\nVALUE: on\nCONFIDENCE: 0.95',
      'SUMMON: turn on tips _',
    );
    const src = new ConfigIntentSource({ ...baseConfig, httpAdapter: adapter, applyScalar: apply.fn });
    const r = (await src.getCues(ctxFromText(input))).results[0]!;
    assert.deepStrictEqual(apply.calls, [['tips-mode', 'on']]);
    assert.strictEqual(count(), 2, 'classifier + concurrent summon both fired');
    assert.strictEqual(r.spanStart, input.indexOf('turn on tips _'));
    assert.strictEqual(input.slice(0, r.spanStart), 'ฉันเขียนโน้ต ');
  });

  it('getCues hit: summon returning a non-suffix falls back to the regex floor (command still applies)', async () => {
    const apply = noopApply();
    // No-punctuation prior → regex 0 → summon fires but returns a non-suffix
    // (paraphrase) → resolveSummonStart ignores it → regex floor (0). The
    // command still applies; worst case the whole buffer is the wipe span.
    const input = 'メモ tips off _';
    const { adapter } = ciTwoCall(
      'INTENT: SETTING\nSETTING: tips-mode\nVALUE: off\nCONFIDENCE: 0.95',
      'SUMMON: disable the tips _', // not a verbatim suffix → ignored
    );
    const src = new ConfigIntentSource({ ...baseConfig, httpAdapter: adapter, applyScalar: apply.fn });
    const r = (await src.getCues(ctxFromText(input))).results[0]!;
    assert.deepStrictEqual(apply.calls, [['tips-mode', 'off']]);
    assert.strictEqual(r.spanStart, 0); // regex floor (no boundary found)
    assert.strictEqual(r.spanEnd, input.length);
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
      // Gate fired (dispatch proceeded). The count is 1 when the regex
      // resolves the wipe span confidently, or 2 when the span resolution
      // also makes its concurrent SUMMON call (bare command — regexStart 0).
      // This test pins the GATE decision, not the call count.
      assert.ok(result.calls >= 1, 'LLM dispatched (gate fired)');
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

  it('trailing newlines AFTER the _ do not push the start past the command', () => {
    // Live-reported on chrome: a contenteditable keeps trailing newlines
    // after the `_` (`statusbar bottom _\n\n\n\n`). Those must NOT count as
    // boundaries — scanning past the `_` put the start at the buffer end
    // (empty wipe → raw query left in the field). Scan only up to the `_`.
    assert.strictEqual(summonPhraseStart('statusbar bottom _\n\n\n\n'), 0);
    assert.strictEqual(summonPhraseStart('statusbar top _\n'), 0);
    // Prior content is still preserved with trailing newlines present.
    const t = 'hii world. voice mode off _\n\n';
    assert.strictEqual(summonPhraseStart(t), 'hii world. '.length);
  });

  it('model-version dots are NOT sentence boundaries (lookahead needs whitespace)', () => {
    // "gpt-5.4" must not split — the dot is followed by a digit, not ws.
    assert.strictEqual(summonPhraseStart('use gpt-5.4 for cues _'), 0);
  });

  it('? and ! also delimit', () => {
    assert.strictEqual(summonPhraseStart('really? voice mode off _'), 'really? '.length);
    assert.strictEqual(summonPhraseStart('wow! tips off _'), 'wow! '.length);
  });

  it('CJK / fullwidth sentence terminators delimit too (language-invariant data-loss fix)', () => {
    // The settings command is English (the classifier is English-only) but
    // the prior content can be any language. CJK scripts use 。！？ with no
    // trailing space, so the old ASCII-only `(?=\s)` regex found no boundary
    // and nuked the user's whole sentence. These must now be preserved.
    const ja = 'こんにちは世界。voice mode off _';
    assert.strictEqual(ja.slice(0, summonPhraseStart(ja)), 'こんにちは世界。');
    const ko = '안녕하세요。tips off _';
    assert.strictEqual(ko.slice(0, summonPhraseStart(ko)), '안녕하세요。');
    const fw = 'メモ！voice mode off _'; // fullwidth ！
    assert.strictEqual(fw.slice(0, summonPhraseStart(fw)), 'メモ！');
    const fwq = '質問？tips on _'; // fullwidth ？
    assert.strictEqual(fwq.slice(0, summonPhraseStart(fwq)), '質問？');
  });
});

describe('parseSummonOutput', () => {
  it('extracts the SUMMON line verbatim', () => {
    assert.strictEqual(parseSummonOutput('SUMMON: voice mode off _'), 'voice mode off _');
    assert.strictEqual(parseSummonOutput('foo\nSUMMON: tips off _\nbar'), 'tips off _');
  });
  it('returns null when absent or empty', () => {
    assert.strictEqual(parseSummonOutput('INTENT: SETTING'), null);
    assert.strictEqual(parseSummonOutput('SUMMON:'), null);
    assert.strictEqual(parseSummonOutput('SUMMON:   '), null);
  });
});

describe('resolveSummonStart — model span with regex floor + data-loss guard', () => {
  it('trusts the model summon when it is a verbatim suffix (language-invariant)', () => {
    // Thai prior content — NO sentence punctuation/space, so the regex floor
    // alone returns 0 (would nuke). The model summon rescues it.
    const t = 'ฉันกำลังเขียนบันทึก voice mode off _';
    assert.strictEqual(summonPhraseStart(t), 0); // regex can't segment Thai
    assert.strictEqual(resolveSummonStart(t, 'voice mode off _'), t.indexOf('voice'));
  });

  it('falls back to the regex floor when summon is null', () => {
    const t = 'hii world. voice mode off _';
    assert.strictEqual(resolveSummonStart(t, null), t.indexOf('voice'));
  });

  it('falls back to the regex floor when summon is not a verbatim suffix', () => {
    // Model paraphrased / hallucinated — not a suffix → don't trust it.
    const t = 'hii world. voice mode off _';
    assert.strictEqual(resolveSummonStart(t, 'turn voice off _'), t.indexOf('voice'));
  });

  it('data-loss guard: ignores a whole-buffer summon when the regex found a real boundary', () => {
    // Model over-included the prior sentence (summon === whole buffer →
    // modelStart 0). The regex found a boundary, so trust the boundary —
    // never nuke "hii world.".
    const t = 'hii world. voice mode off _';
    assert.strictEqual(resolveSummonStart(t, t), t.indexOf('voice'));
  });

  it('whole-buffer summon is fine when there is genuinely no prior content', () => {
    const t = 'voice mode off _';
    assert.strictEqual(resolveSummonStart(t, t), 0);
    assert.strictEqual(resolveSummonStart(t, null), 0);
  });
});

// ============================================================================
// hasLikelyIntent — the cheap pre-filter gate. `gemma` was added as a curated
// model alias so it trips the gate on bare-name phrasings, at parity with
// `haiku` (both models sit in their provider's knownModels; the classifier
// resolves gemma → cerebras/gemma-4-31b, haiku → anthropic/claude-haiku).
// ============================================================================

describe('hasLikelyIntent — model-alias parity (gemma ↔ haiku)', () => {
  it('trips on bucket-scoped model phrasings', () => {
    assert.strictEqual(hasLikelyIntent('use gemma for blanks _'), true);
    assert.strictEqual(hasLikelyIntent('use gemma for cues _'), true);
    assert.strictEqual(hasLikelyIntent('use haiku for blanks _'), true);
    assert.strictEqual(hasLikelyIntent('use qwen for blanks _'), true);
  });

  it('trips on BARE model-name phrasings (no bucket word) — gemma at parity with haiku', () => {
    // These have no bucket/provider word — only the curated model alias trips
    // the gate. Before `gemma` was added, "use gemma _" was silently skipped
    // while "use haiku _" fired. This pins the parity.
    assert.strictEqual(hasLikelyIntent('use gemma _'), true);
    assert.strictEqual(hasLikelyIntent('use haiku _'), true);
    assert.strictEqual(hasLikelyIntent('switch to gemma _'), true);
    assert.strictEqual(hasLikelyIntent('use qwen _'), true);
    assert.strictEqual(hasLikelyIntent('switch to qwen _'), true);
  });

  it('does NOT trip on ordinary lookup/transform buffers with no model/setting token', () => {
    // The gate is intentionally loose (a false-positive only costs a NONE
    // classification downstream), so these are picked to contain zero
    // provider/model/bucket/setting tokens.
    assert.strictEqual(hasLikelyIntent('the capital of france _'), false);
    assert.strictEqual(hasLikelyIntent('translate to spanish _ hola'), false);
    assert.strictEqual(hasLikelyIntent('fix typos _ teh cat'), false);
  });
});

// ============================================================================
// ACTION verdict (undo/redo) — the fourth intent kind. The source only
// CLASSIFIES actions; the apply lives runtime-side (undo journal), so
// every test here pins "no side effect at emit time" alongside the shape.
// ============================================================================

describe('parseConfigIntentOutput — ACTION verdicts', () => {
  it('parses a clean undo with count', () => {
    const v = parseConfigIntentOutput(
      'INTENT: ACTION\nACTION: undo\nCOUNT: 3\nSETTING:\nVALUE:\nSCOPE:\nPROVIDER:\nMODEL:\nCONFIDENCE: 0.96',
    );
    assert.strictEqual(v.kind, 'action');
    if (v.kind === 'action') {
      assert.strictEqual(v.action, 'undo');
      assert.strictEqual(v.count, 3);
      assert.strictEqual(v.confidence, 0.96);
    }
  });

  it('parses redo; missing COUNT defaults to 1', () => {
    const v = parseConfigIntentOutput('INTENT: ACTION\nACTION: redo\nCONFIDENCE: 0.9');
    assert.strictEqual(v.kind, 'action');
    if (v.kind === 'action') {
      assert.strictEqual(v.action, 'redo');
      assert.strictEqual(v.count, 1);
    }
  });

  it('garbage COUNT floors to 1 (regex only matches digits; "COUNT: some" is a miss)', () => {
    const v = parseConfigIntentOutput('INTENT: ACTION\nACTION: undo\nCOUNT: some\nCONFIDENCE: 0.9');
    assert.strictEqual(v.kind, 'action');
    if (v.kind === 'action') assert.strictEqual(v.count, 1);
  });

  it('COUNT: 0 floors to 1', () => {
    const v = parseConfigIntentOutput('INTENT: ACTION\nACTION: undo\nCOUNT: 0\nCONFIDENCE: 0.9');
    assert.strictEqual(v.kind, 'action');
    if (v.kind === 'action') assert.strictEqual(v.count, 1);
  });

  it('unknown ACTION value collapses to NONE', () => {
    const v = parseConfigIntentOutput('INTENT: ACTION\nACTION: rollback\nCOUNT: 1\nCONFIDENCE: 0.9');
    assert.strictEqual(v.kind, 'none');
  });

  it('infers action kind from a populated ACTION line when INTENT is missing', () => {
    const v = parseConfigIntentOutput('ACTION: undo\nCOUNT: 2\nCONFIDENCE: 0.9');
    assert.strictEqual(v.kind, 'action');
    if (v.kind === 'action') assert.strictEqual(v.count, 2);
  });

  it('empty ACTION line does not hijack a setting verdict', () => {
    const v = parseConfigIntentOutput(
      'INTENT: SETTING\nSETTING: debug-mode\nVALUE: on\nACTION:\nCOUNT:\nCONFIDENCE: 0.95',
    );
    assert.strictEqual(v.kind, 'setting');
  });
});

describe('validateAgainstRegistry — ACTION verdicts', () => {
  it('accepts undo and redo with positive integer counts', () => {
    assert.strictEqual(validateAgainstRegistry({ kind: 'action', action: 'undo', count: 1, confidence: 0.9 }).ok, true);
    assert.strictEqual(validateAgainstRegistry({ kind: 'action', action: 'redo', count: 5, confidence: 0.9 }).ok, true);
  });

  it('rejects a non-integer or sub-1 count (defence in depth — parse already floors)', () => {
    assert.strictEqual(validateAgainstRegistry({ kind: 'action', action: 'undo', count: 1.5, confidence: null }).ok, false);
    assert.strictEqual(validateAgainstRegistry({ kind: 'action', action: 'undo', count: 0, confidence: null }).ok, false);
  });

  it('rejects an unknown action verb (type-confused input)', () => {
    const v = { kind: 'action', action: 'rollback', count: 1, confidence: null } as unknown as Parameters<typeof validateAgainstRegistry>[0];
    assert.strictEqual(validateAgainstRegistry(v).ok, false);
  });
});

describe('ConfigIntentSource — ACTION verdict gating + emission', () => {
  const baseConfig = {
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  };
  const ACTION_RESPONSE = 'INTENT: ACTION\nACTION: undo\nCOUNT: 2\nSETTING:\nVALUE:\nSCOPE:\nPROVIDER:\nMODEL:\nCONFIDENCE: 0.95';

  it('action verdict cedes by default (allowActionVerdicts unset) with no side effect', async () => {
    const calls: Array<[string, string]> = [];
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([ACTION_RESPONSE]),
      applyScalar: (s, v) => { calls.push([s, v]); },
    });
    // Unique input — the variant pool is module-static, keyed by text.
    const result = await src.getCues(ctxFromText('undo that gated default _'));
    assert.strictEqual(result.results.length, 0, 'expected cede when action verdicts are disabled');
    assert.deepStrictEqual(calls, [], 'no applyScalar side effect for a gated action verdict');
  });

  it('action verdict emits metadata.undoAction when allowed — and NEVER calls applyScalar', async () => {
    const calls: Array<[string, string]> = [];
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([ACTION_RESPONSE]),
      applyScalar: (s, v) => { calls.push([s, v]); },
      allowActionVerdicts: true,
    });
    const input = 'undo the last two allowed _';
    const result = await src.getCues(ctxFromText(input));
    assert.strictEqual(result.results.length, 1, 'expected one CueResult');
    assert.deepStrictEqual(calls, [], 'action verdicts must carry no emit-time side effect');
    const r = result.results[0]!;
    assert.strictEqual(r.source, 'config-intent');
    assert.deepStrictEqual(r.alternatives, ['undo']);
    // Wipe span covers the whole summon phrase (bare command → 0..len).
    assert.strictEqual(r.spanStart, 0);
    assert.strictEqual(r.spanEnd, input.length);
    assert.strictEqual(r.cueTip, 'undo ×2');
    assert.deepStrictEqual(r.metadata?.undoAction, { action: 'undo', count: 2, confidence: 0.95 });
    // No selector-satellite fields — the resolver must not route this
    // through the settings splice path.
    assert.strictEqual(r.metadata?.selectorBlank, undefined);
    assert.strictEqual(r.metadata?.satelliteValue, undefined);
  });

  it('setting verdict cedes when allowConfigVerdicts=false (undo-only construction)', async () => {
    const calls: Array<[string, string]> = [];
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(['SETTING: debug-mode\nVALUE: on\nCONFIDENCE: 0.97']),
      applyScalar: (s, v) => { calls.push([s, v]); },
      allowConfigVerdicts: false,
      allowActionVerdicts: true,
    });
    const result = await src.getCues(ctxFromText('enable debug logging config-gated _'));
    assert.strictEqual(result.results.length, 0, 'setting verdict must cede when config verdicts are disabled');
    assert.deepStrictEqual(calls, [], 'no applyScalar when config verdicts are disabled');
  });

  it('action verdict preserves prior content: spanStart lands after the sentence boundary', async () => {
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([ACTION_RESPONSE]),
      applyScalar: () => {},
      allowActionVerdicts: true,
    });
    const input = 'hii world. undo that boundary case _';
    const result = await src.getCues(ctxFromText(input));
    assert.strictEqual(result.results.length, 1);
    const r = result.results[0]!;
    assert.strictEqual(r.spanStart, 'hii world.'.length + 1, 'wipe must start after the sentence boundary, preserving prior prose');
  });
});

describe('matchDeterministicAction — the Ctrl+Z string path', () => {
  it('matches a bare undo/redo at the start (commandStart 0, count 1)', () => {
    assert.deepStrictEqual(matchDeterministicAction('undo'), { action: 'undo', count: 1, commandStart: 0 });
    assert.deepStrictEqual(matchDeterministicAction('redo'), { action: 'redo', count: 1, commandStart: 0 });
    assert.deepStrictEqual(matchDeterministicAction('revert'), { action: 'undo', count: 1, commandStart: 0 });
  });

  it('is case-insensitive', () => {
    assert.strictEqual(matchDeterministicAction('REDO')?.action, 'redo');
    assert.strictEqual(matchDeterministicAction('Undo')?.action, 'undo');
  });

  it('parses an integer count after the alias', () => {
    assert.deepStrictEqual(matchDeterministicAction('undo 3'), { action: 'undo', count: 3, commandStart: 0 });
    assert.deepStrictEqual(matchDeterministicAction('redo 12'), { action: 'redo', count: 12, commandStart: 0 });
  });

  it('locates the command AFTER a leading `_` query — the logged bug', () => {
    // `capital of france _ redo` → wipe span begins at "redo" (offset 20),
    // so the prior `capital of france _` query survives the wipe.
    assert.deepStrictEqual(
      matchDeterministicAction('capital of france _ redo'),
      { action: 'redo', count: 1, commandStart: 20 },
    );
  });

  it('locates the command after a confirmation word (`Paris undo`)', () => {
    assert.deepStrictEqual(matchDeterministicAction('Paris undo'), { action: 'undo', count: 1, commandStart: 6 });
  });

  it('does NOT match `redo <object>` — the alias is not the trailing token', () => {
    assert.strictEqual(matchDeterministicAction('redo the report'), null);
    assert.strictEqual(matchDeterministicAction('undo my last commit'), null);
    assert.strictEqual(matchDeterministicAction('revert the deploy'), null);
  });

  it('does NOT match prose without an alias, or a non-positive count', () => {
    assert.strictEqual(matchDeterministicAction('capital of france'), null);
    assert.strictEqual(matchDeterministicAction('hello world'), null);
    assert.strictEqual(matchDeterministicAction(''), null);
    assert.strictEqual(matchDeterministicAction('undo 0'), null);
  });

  it('matches common Latin-script aliases', () => {
    assert.strictEqual(matchDeterministicAction('deshacer')?.action, 'undo');
    assert.strictEqual(matchDeterministicAction('rehacer')?.action, 'redo');
    assert.strictEqual(matchDeterministicAction('annuler')?.action, 'undo');
    assert.strictEqual(matchDeterministicAction('rückgängig')?.action, 'undo');
  });
});

describe('ConfigIntentSource — deterministic ACTION gate (no LLM)', () => {
  const baseConfig = {
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  };
  // A mock adapter that FAILS the test if the LLM is ever dispatched.
  const throwingAdapter: HttpAdapter = {
    post: async () => { throw new Error('LLM must not be called on the deterministic ACTION path'); },
  };

  it('emits ACTION redo for `capital of france _ redo _` with NO LLM call, wiping only `redo _`', async () => {
    const input = 'capital of france _ redo _';
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: throwingAdapter,
      applyScalar: () => {},
      allowActionVerdicts: true,
    });
    const result = await src.getCues(ctxFromText(input));
    assert.strictEqual(result.results.length, 1, 'expected one deterministic ACTION result');
    const r = result.results[0]!;
    assert.deepStrictEqual(r.metadata?.undoAction, { action: 'redo', count: 1, confidence: 1 });
    assert.strictEqual(r.spanStart, 20, 'wipe starts at "redo", preserving the leading `capital of france _`');
    assert.strictEqual(r.spanEnd, input.length);
  });

  it('emits ACTION undo with a count for `undo 3 _` — no LLM call', async () => {
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: throwingAdapter,
      applyScalar: () => {},
      allowActionVerdicts: true,
    });
    const result = await src.getCues(ctxFromText('undo 3 _'));
    assert.strictEqual(result.results.length, 1);
    assert.deepStrictEqual(result.results[0]!.metadata?.undoAction, { action: 'undo', count: 3, confidence: 1 });
    assert.strictEqual(result.results[0]!.cueTip, 'undo ×3');
  });

  it('does NOT fire the deterministic gate when undo-mode is off', async () => {
    // allowActionVerdicts unset → the gate is skipped; `redo _` then flows
    // to the LLM path, which here returns NONE and cedes.
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(['INTENT: NONE\nCONFIDENCE: 0.9']),
      applyScalar: () => {},
    });
    const result = await src.getCues(ctxFromText('redo _'));
    assert.strictEqual(result.results.length, 0, 'no ACTION result when undo-mode is off');
  });
});

describe('ConfigIntentSource — pre-switch provider liveness gate', () => {
  const baseConfig = {
    provider: getProvider('groq')!,
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  };
  function applyRec(): { calls: Array<[string, string]>; fn: (s: string, v: string) => void } {
    const calls: Array<[string, string]> = [];
    return { calls, fn: (s, v) => { calls.push([s, v]); } };
  }
  const PROVIDER_VERDICT = 'INTENT: PROVIDER\nSCOPE: blanks\nPROVIDER: ollama\nMODEL:\nCONFIDENCE: 0.9';

  it('provider switch REFUSED when the target is unreachable — no apply, inline error', async () => {
    const apply = applyRec();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([PROVIDER_VERDICT]),
      applyScalar: apply.fn,
      formatErrorAsSubstitute: (reason, err) => `[err] ${reason}: ${err?.message ?? ''}`,
      probeProvider: async () => ({ ok: false, reason: 'network' as const, err: new Error('fetch failed 127.0.0.1:11434') }),
    });
    const result = await src.getCues(ctxFromText('switch to ollama _'));
    assert.strictEqual(apply.calls.length, 0, 'must NOT write any provider/model scalar when unreachable — stays on current');
    assert.strictEqual(result.results.length, 1, 'emits the inline error result');
    const r = result.results[0]!;
    assert.strictEqual(r.alternatives[0], '_', 'cycling back dismisses the message');
    assert.match(String(r.alternatives[1]), /network/, 'inline text carries the reason');
    assert.match(String(r.alternatives[1]), /11434/, 'inline text names the concrete cause');
    assert.strictEqual(r.metadata?.fluidBlankErrorReason, 'network');
    // Claims the `_` slot so the resolver filters FluidBlank's competing
    // (generic) answer on the same word — the user sees ONLY this tailored
    // "kept current provider" message, not a stray fluid-blank fill.
    assert.deepStrictEqual(result.consumedBlankSlots, [3], 'refusal must claim the `_` slot (index 3 of "switch to ollama _")');
  });

  it('provider switch APPLIES when the target is reachable', async () => {
    const apply = applyRec();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([PROVIDER_VERDICT]),
      applyScalar: apply.fn,
      probeProvider: async () => ({ ok: true }),
    });
    const result = await src.getCues(ctxFromText('switch to ollama _'));
    assert.ok(
      apply.calls.some(([k, v]: [string, string]) => k === 'blanks-llm-provider' && v === 'ollama'),
      'wrote the provider scalar after a passing probe',
    );
    assert.strictEqual(result.results.length, 1, 'emits the selector-satellite switch result');
    assert.deepStrictEqual(result.consumedBlankSlots, [3], 'a successful switch also claims the slot (no stray fluid-blank race)');
  });

  it('no probeProvider callback → provider switch applies unconditionally (back-compat)', async () => {
    const apply = applyRec();
    const src = new ConfigIntentSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter([PROVIDER_VERDICT]),
      applyScalar: apply.fn,
      // no probeProvider wired
    });
    await src.getCues(ctxFromText('switch to ollama _'));
    assert.ok(apply.calls.some(([k]: [string, string]) => k === 'blanks-llm-provider'), 'applies with no gate wired');
  });
});

describe('hasLikelyIntent — multilingual undo/redo aliases', () => {
  it('trips on English undo/redo forms', () => {
    assert.strictEqual(hasLikelyIntent('undo _'), true);
    assert.strictEqual(hasLikelyIntent('undo 3 _'), true);
    assert.strictEqual(hasLikelyIntent('redo _'), true);
    assert.strictEqual(hasLikelyIntent('revert that _'), true);
  });

  it('trips on CJK aliases via substring matching (\\b never matches CJK)', () => {
    assert.strictEqual(hasLikelyIntent('元に戻して _'), true);
    assert.strictEqual(hasLikelyIntent('さっきのを取り消してください _'), true);
    assert.strictEqual(hasLikelyIntent('撤销 _'), true);
    assert.strictEqual(hasLikelyIntent('되돌리기 _'), true);
  });

  it('trips on Cyrillic / Thai / Arabic aliases (also non-\\w scripts)', () => {
    assert.strictEqual(hasLikelyIntent('отменить _'), true);
    assert.strictEqual(hasLikelyIntent('เลิกทำ _'), true);
    assert.strictEqual(hasLikelyIntent('تراجع _'), true);
  });

  it('trips on Latin-script aliases with word boundaries', () => {
    assert.strictEqual(hasLikelyIntent('deshacer _'), true);
    assert.strictEqual(hasLikelyIntent('rückgängig machen _'), true);
    assert.strictEqual(hasLikelyIntent('cofnij _'), true);
  });

  it('still rejects plain prose with no alias', () => {
    assert.strictEqual(hasLikelyIntent('the quick brown fox _'), false);
  });
});
