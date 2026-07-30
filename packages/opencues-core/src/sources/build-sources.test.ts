/**
 * Tests for build-sources.ts
 *
 * Run with: node --test dist/sources/build-sources.test.js
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { buildSourcesFromConfig, combineWordSources } from './build-sources';
import { ConfigSource } from './config-source';
import { isBlankConfigCycleable } from './blank-source';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { CuesMdConfig, SourceConfig, PromptConfig, BlankConfig } from '../cues-md';
import { HttpAdapter } from '../types';
import {
  getProvider,
  setCliAvailabilityForTests,
  resetCliAvailabilityCacheForTests,
  SUBSCRIPTION_AUTO_FALLBACK,
} from '../llm-provider';

// Stub HTTP adapter (never called in these tests)
const stubAdapter: HttpAdapter = {
  post: async () => '{}',
};

const defaultOptions = {
  httpAdapter: stubAdapter,
  apiKeys: { GROQ_API_KEY: 'test-key' },
  globalProvider: 'groq',
  globalModel: 'test-model',
  enableWordCues: true,
};

// ConfigSource direct-construction options (for the `.supports()` unit tests).
const configSourceWiring = {
  httpAdapter: stubAdapter,
  provider: getProvider('groq')!,
  endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
};

function mkConfig(promptConfig: PromptConfig): CuesMdConfig {
  return { frontmatter: {}, sections: {}, promptConfig };
}

// ---------------------------------------------------------------------------
// combineWordSources (deprecated; preserved for callers)
// ---------------------------------------------------------------------------

describe('combineWordSources (deprecated; preserved for callers)', () => {
  it('returns a SourceConfig with the canonical alternatives shape', () => {
    const out = combineWordSources([{ name: 'a', promptText: 'A.', priority: 50 }]);
    assert.strictEqual(out.name, 'grammar');
    assert.strictEqual(out.scope, 'words');
    assert.strictEqual(out.parser, 'alternatives');
    assert.strictEqual(out.priority, 50);
    assert.ok(out.promptText!.includes('A.'));
  });

  it('priority is the max of children', () => {
    const out = combineWordSources([
      { name: 'a', promptText: 'A', priority: 30 },
      { name: 'b', promptText: 'B', priority: 90 },
      { name: 'c', promptText: 'C', priority: 60 },
    ]);
    assert.strictEqual(out.priority, 90);
  });

  it('always appends index:alternatives format spec', () => {
    const grammar: SourceConfig = {
      name: 'grammar',
      promptText: 'Provide 3 alternatives per word.',
    };
    const combined = combineWordSources([grammar]);
    assert.match(combined.promptText!, /index:alternatives format/i);
  });
});

// ---------------------------------------------------------------------------
// buildSourcesFromConfig — word source routing
// ---------------------------------------------------------------------------

describe('buildSourcesFromConfig — word source routing', () => {
  it('wraps multiple alternatives sections in ONE RoutedWordSourceGroup', () => {
    const cuesConfig = mkConfig({
        sources: {
          concise: { name: 'concise', promptText: 'Legal prompt.', priority: 70, match: 'contract' },
          plain: { name: 'plain', promptText: 'Medical prompt.', priority: 75, match: 'diagnosis' },
          tone: { name: 'tone', promptText: 'Financial prompt.', priority: 65, keywords: 'stock,bond' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);

    assert.strictEqual(sources.length, 1);
    assert.ok(sources[0] instanceof RoutedWordSourceGroup);

    const group = sources[0] as RoutedWordSourceGroup;
    assert.strictEqual(group.id, 'word-cues');
    assert.strictEqual(group.priority, 75);
    assert.deepStrictEqual(group.routingStats, { sources: 3 });
  });

  it('drops sources with neither match: nor keywords: (no catch-all defaults)', () => {
    const cuesConfig = mkConfig({
        sources: {
          catchAll: { name: 'catchAll', promptText: 'Anything.', priority: 50 },
          concise: { name: 'concise', promptText: 'Legal.', priority: 70, match: 'contract' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 1);
    const group = sources[0] as RoutedWordSourceGroup;
    assert.deepStrictEqual(group.routingStats, { sources: 1 });
  });

  it('keeps non-alternatives parser sources separate (not in the routed group)', () => {
    const cuesConfig = mkConfig({
        sources: {
          concise: { name: 'concise', promptText: 'Legal.', priority: 70, match: 'contract' },
          custom: { name: 'custom', promptText: 'Custom.', priority: 60, parser: 'raw', scope: 'words' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);

    assert.strictEqual(sources.length, 2);
    const routed = sources.find(s => s instanceof RoutedWordSourceGroup);
    const direct = sources.find(s => s instanceof ConfigSource);
    assert.ok(routed);
    assert.ok(direct);
    assert.strictEqual((direct as ConfigSource).id, 'custom');
  });

  it('keeps non-words scope sources separate', () => {
    const cuesConfig = mkConfig({
        sources: {
          concise: { name: 'concise', promptText: 'Legal.', priority: 70, match: 'contract' },
          allScope: { name: 'allScope', promptText: 'All.', priority: 60, scope: 'all' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 2);
    assert.ok(sources.some(s => s instanceof RoutedWordSourceGroup));
    assert.ok(sources.some(s => s instanceof ConfigSource && s.id === 'allScope'));
  });

  it('skips disabled sources', () => {
    const cuesConfig = mkConfig({
        sources: {
          concise: { name: 'concise', promptText: 'Legal.', priority: 70, match: 'contract' },
          disabled: { name: 'disabled', promptText: 'Disabled.', match: 'foo', enabled: false },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 1);
    const group = sources[0] as RoutedWordSourceGroup;
    assert.deepStrictEqual(group.routingStats, { sources: 1 });
  });

  it('skips sources without promptText', () => {
    const cuesConfig = mkConfig({
        sources: {
          concise: { name: 'concise', promptText: 'Legal.', match: 'contract' },
          empty: { name: 'empty', match: 'foo' },
        },
    });

    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 1);
  });

  it('handles empty cuesConfig', () => {
    const sources = buildSourcesFromConfig(undefined, undefined, defaultOptions);
    assert.strictEqual(sources.length, 0);
  });

  it('emits no RoutedWordSourceGroup when there are zero word-cue sources', () => {
    const cuesConfig = mkConfig({
        sources: {
          custom: { name: 'custom', promptText: 'Custom.', parser: 'raw', scope: 'words' },
        },
    });
    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultOptions);
    assert.strictEqual(sources.length, 1);
    assert.ok(sources[0] instanceof ConfigSource);
    assert.ok(!sources.some(s => s instanceof RoutedWordSourceGroup));
  });

  it('ignores the blanksConfig argument (legacy ClassifiedSourceGroup pipeline removed)', () => {
    const blanksConfig = mkConfig({
      sources: {
        custom: { name: 'custom', promptText: 'Custom.', parser: 'raw', priority: 90, match: '\\d+' },
      },
    });
    const sources = buildSourcesFromConfig(undefined, blanksConfig, defaultOptions);
    assert.strictEqual(sources.length, 0);
  });
});

// ---------------------------------------------------------------------------
// ConfigSource.supports() edge cases
// ---------------------------------------------------------------------------

describe('ConfigSource.supports()', () => {
  it('words scope: supports non-blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.', scope: 'words' },
      ...configSourceWiring,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), true);
  });

  it('words scope: does not support blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.', scope: 'words' },
      ...configSourceWiring,
    });
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), false);
  });

  it('blanks scope: supports blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks' },
      ...configSourceWiring,
    });
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), true);
  });

  it('blanks scope: does not support non-blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks' },
      ...configSourceWiring,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), false);
  });

  it('all scope: supports both blank and non-blank', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'generic', promptText: 'Any.', scope: 'all' },
      ...configSourceWiring,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), true);
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), true);
  });

  it('default scope is words', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.' },
      ...configSourceWiring,
    });
    assert.strictEqual(src.scope, 'words');
  });
});

// =====================================================================
// Universal-Integration cycleability inference + filter
// =====================================================================
//
// "Universal Integration" = host with no cycling surface. Today it's
// chrome's normal-`<input>` / `<textarea>` branch; the design extends
// to any future read-only / inline integration profile. The contract:
//
// - Every CueSource declares `isCycleable: boolean` (structural inference
//   from the source class + def shape, no frontmatter changes).
// - buildSourcesFromConfig accepts `supportsCycling: boolean`. When
//   false, cycleable sources / blank defs are pruned at registration.
// - Word-cues (always cycleable) are dropped entirely.
// - Selector/satellite/list/script blanks are pruned from the BlankSource
//   blanks map BEFORE construction.
// - Single-answer sources (FluidBlank, TransformBlank) survive.
// - Compute blanks (weather/stocks/answer — impl-based with no cycling
//   signals on BlankConfig) survive.

describe('isBlankConfigCycleable — structural inference', () => {
  const stub = (overrides: Partial<BlankConfig>): BlankConfig => ({
    name: 'x',
    ...overrides,
  });

  it('stepValues with >1 entry → cycleable (list blank)', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ stepValues: ['a', 'b'] })), true);
  });

  it('stepValues with 1 entry → not cycleable (degenerate, no choice)', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ stepValues: ['only'] })), false);
  });

  it('blankSatellite: true → cycleable (selector/satellite shape)', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ blankSatellite: true })), true);
  });

  it('blankStep numeric → cycleable (volume/brightness-style step)', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ blankStep: 6 })), true);
  });

  it('blankScript alone → NOT cycleable (read-only by default; cyclers self-declare)', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ blankScript: './x.sh' })), false);
  });

  it('blankScript + a cycle declaration (blankStep) → cycleable', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ blankScript: './x.sh', blankStep: 6 })), true);
  });

  it('impl-only blank (compute: weather/stocks/answer) → not cycleable', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ impl: 'WeatherBlank' })), false);
  });

  it('plain blank with just blankKeywords → not cycleable (no cycling shape)', () => {
    assert.strictEqual(isBlankConfigCycleable(stub({ blankKeywords: ['hello'] })), false);
  });
});

describe('buildSourcesFromConfig — Universal-Integration filter', () => {
  const baseBlanks: Record<string, BlankConfig> = {
    weather: { name: 'weather', blankKeywords: ['weather'], impl: 'WeatherBlank' },
    volume: { name: 'volume', blankKeywords: ['volume'], blankStep: 6, blankScript: './volume.sh' },
    affirmations: { name: 'affirmations', blankKeywords: ['affirmation'], stepValues: ['a', 'b', 'c'] },
    opencuesSettings: { name: 'opencues', blankKeywords: ['opencues settings'], blankSatellite: true },
  };

  function buildWith(supportsCycling: boolean): string[] {
    const sources = buildSourcesFromConfig(undefined, undefined, {
      httpAdapter: stubAdapter,
      apiKeys: { GROQ_API_KEY: 'x', CEREBRAS_API_KEY: 'x' },
      blanks: baseBlanks,
      readBlankState: () => null,
      enableFluidBlank: true,
      enableTransformBlank: true,
      enableWordCues: false,
      supportsCycling,
    });
    // Return source ids in the order they appear.
    return sources.map(s => s.id);
  }

  it('supportsCycling=true (default): all blanks reach BlankSource', () => {
    // BlankSource has id 'blank' regardless of how many defs it carries.
    // Test that we get one BlankSource + FluidBlankSource + TransformBlankSource.
    const ids = buildWith(true);
    assert.ok(ids.includes('blank'), 'BlankSource registered when cycling supported');
    assert.ok(ids.includes('fluid-blank'));
    assert.ok(ids.includes('transform-blank'));
  });

  it('supportsCycling=false: cycleable blanks dropped, single-answer survives', () => {
    // weather (impl, not cycleable) should reach BlankSource; volume/
    // affirmations/opencuesSettings should be pruned. BlankSource itself
    // still registers (carries weather).
    const droppedLogs: string[] = [];
    const sources = buildSourcesFromConfig(undefined, undefined, {
      httpAdapter: stubAdapter,
      apiKeys: { GROQ_API_KEY: 'x', CEREBRAS_API_KEY: 'x' },
      blanks: baseBlanks,
      readBlankState: () => null,
      enableFluidBlank: true,
      enableTransformBlank: true,
      enableWordCues: false,
      supportsCycling: false,
      log: (msg) => { if (msg.includes('skipping')) droppedLogs.push(msg); },
    });
    const ids = sources.map(s => s.id);
    // BlankSource present because weather survives.
    assert.ok(ids.includes('blank'), 'BlankSource still registered (compute survivor)');
    assert.ok(ids.includes('fluid-blank'));
    assert.ok(ids.includes('transform-blank'));
    // The three cycleable blanks should each have produced a skip log.
    assert.ok(droppedLogs.some(m => m.includes('volume')), 'volume pruned');
    assert.ok(droppedLogs.some(m => m.includes('affirmations')), 'affirmations pruned');
    assert.ok(droppedLogs.some(m => m.includes('opencues')), 'opencues settings pruned');
  });

  it('supportsCycling=false + no surviving blanks: BlankSource omitted', () => {
    const sources = buildSourcesFromConfig(undefined, undefined, {
      httpAdapter: stubAdapter,
      apiKeys: { GROQ_API_KEY: 'x', CEREBRAS_API_KEY: 'x' },
      blanks: {
        volume: baseBlanks.volume,
        affirmations: baseBlanks.affirmations,
      },
      readBlankState: () => null,
      supportsCycling: false,
    });
    const ids = sources.map(s => s.id);
    assert.ok(!ids.includes('blank'), 'BlankSource omitted when every def pruned');
  });

  it('supportsCycling=false + word-cues enabled: word-cue source dropped', () => {
    const cuesMd: CuesMdConfig = mkConfig({
      sources: {
        concise: {
          name: 'concise',
          promptText: 'Provide alts.',
          scope: 'words',
          parser: 'alternatives',
          priority: 70,
          match: 'contract|liability',
        },
      },
    } as PromptConfig);
    const droppedLogs: string[] = [];
    const sources = buildSourcesFromConfig(cuesMd, undefined, {
      httpAdapter: stubAdapter,
      apiKeys: { GROQ_API_KEY: 'x', CEREBRAS_API_KEY: 'x' },
      enableWordCues: true,
      supportsCycling: false,
      log: (msg) => { if (msg.includes('skipping')) droppedLogs.push(msg); },
    });
    const ids = sources.map(s => s.id);
    assert.ok(!ids.includes('concise'), 'word-cue source not registered');
    assert.ok(!ids.includes('word-cues'), 'RoutedWordSourceGroup not built (no sources to wrap)');
    assert.ok(droppedLogs.some(m => m.includes("concise")), 'concise word-cue logged as pruned');
  });
});

// ---------------------------------------------------------------------------
// ConfigIntentSource construction gating — fluid-config vs undo-mode flags
// ---------------------------------------------------------------------------

describe('buildSourcesFromConfig — config-intent construction gating', () => {
  const emptyConfig = mkConfig({ sources: {} });
  const hasConfigIntent = (sources: readonly unknown[]): boolean =>
    sources.some(s => (s as { id?: string }).id === 'config-intent');

  it('neither flag → no config-intent source', () => {
    const sources = buildSourcesFromConfig(emptyConfig, undefined, { ...defaultOptions });
    assert.strictEqual(hasConfigIntent(sources), false);
  });

  it('enableConfigIntent + applyOpencuesScalar → constructed', () => {
    const sources = buildSourcesFromConfig(emptyConfig, undefined, {
      ...defaultOptions,
      enableConfigIntent: true,
      applyOpencuesScalar: () => { /* noop */ },
    });
    assert.strictEqual(hasConfigIntent(sources), true);
  });

  it('enableUndoActions alone (fluid-config off) → constructed for action verdicts', () => {
    const sources = buildSourcesFromConfig(emptyConfig, undefined, {
      ...defaultOptions,
      enableUndoActions: true,
    });
    assert.strictEqual(hasConfigIntent(sources), true);
  });

  it('enableConfigIntent WITHOUT applyOpencuesScalar and no undo → skipped', () => {
    const sources = buildSourcesFromConfig(emptyConfig, undefined, {
      ...defaultOptions,
      enableConfigIntent: true,
    });
    assert.strictEqual(hasConfigIntent(sources), false);
  });

  it('enableConfigIntent without callback BUT undo on → constructed (settings gated off)', () => {
    const sources = buildSourcesFromConfig(emptyConfig, undefined, {
      ...defaultOptions,
      enableConfigIntent: true,
      enableUndoActions: true,
    });
    assert.strictEqual(hasConfigIntent(sources), true);
  });
});

describe('buildSourcesFromConfig — contradiction-cues engine selection (TDZ ordering regression)', () => {
  const emptyConfig = mkConfig({ sources: {} });
  const cx = (sources: readonly unknown[]) =>
    sources.find(s => (s as { id?: string }).id === 'contradiction-cues') as { constructor: { name: string } } | undefined;

  // Zero-key expectations in this suite must model a SPECIFIC machine,
  // not the developer's real PATH: pickAutoProvider's subscription-CLI
  // rung (claude-code-cli) fires whenever a `claude` binary exists,
  // which is true on every dev box and false on CI runners — the
  // July 2026 "red on CI, green everywhere else" incident. Same
  // pattern as llm-provider.test.ts.
  before(() => {
    for (const id of SUBSCRIPTION_AUTO_FALLBACK) setCliAvailabilityForTests(id, false);
  });
  after(() => {
    resetCliAvailabilityCacheForTests();
  });

  it('picks the LLM engine when a provider/key resolves (must NOT throw or fall back)', () => {
    // Regression: the contradiction block once ran BEFORE apiKeys/cuesTier were
    // initialized, so resolveFor() hit a temporal-dead-zone — a ReferenceError
    // in native Node, and a silent null → deterministic fallback under esbuild's
    // const→var lowering (chrome). Both are wrong: with a key present the robust
    // LLM engine MUST be chosen. This pins the block's ordering after the tiers.
    const sources = buildSourcesFromConfig(emptyConfig, undefined, {
      ...defaultOptions,
      enableContradictionCues: true,
    });
    assert.equal(cx(sources)?.constructor.name, 'ContradictionLlmSource');
  });

  it('never throws with no keys and no subscription CLI (bare machine → cue silently absent)', () => {
    // The TDZ bug threw here regardless of keys — doesNotThrow is the
    // regression pin. On a truly bare machine (no API keys, no claude/
    // codex binary) resolveLLM returns null for keyless cerebras, so the
    // cue is silently absent: the documented "OpenCues without an LLM is
    // fine" mode, same as more-formal. (The original version of this test
    // asserted a source was ALWAYS present — true only on machines where
    // the claude binary rescued it, which is why it was red on CI and
    // green on every dev box for seven straight runs.)
    let sources: readonly unknown[] = [];
    assert.doesNotThrow(() => {
      sources = buildSourcesFromConfig(emptyConfig, undefined, {
        httpAdapter: stubAdapter,
        apiKeys: {},
        enableContradictionCues: true,
      });
    });
    assert.equal(cx(sources), undefined, 'bare machine: cue absent, no throw');
  });

  it('keyless machine WITH an authenticated claude CLI → subscription rung rescues the cue', () => {
    // Models the CC-fork user with zero API keys: pickAutoProvider's
    // subscription-CLI rung resolves claude-code-cli (transport: cli,
    // no key check) and the LLM engine is constructed.
    setCliAvailabilityForTests('claude-code-cli', true);
    try {
      const sources = buildSourcesFromConfig(emptyConfig, undefined, {
        httpAdapter: stubAdapter,
        apiKeys: {},
        enableContradictionCues: true,
      });
      assert.equal(cx(sources)?.constructor.name, 'ContradictionLlmSource');
    } finally {
      setCliAvailabilityForTests('claude-code-cli', false);
    }
  });

  it('is SKIPPED (not deterministic) when the cue provider trains on input (opencode-zen refused)', () => {
    // resolveFor refuses a cue-class source routed through a trainsOnInput
    // provider → returns null → the cue simply does not run (LLM-only; the
    // deterministic fallback was removed July 2026).
    const sources = buildSourcesFromConfig(emptyConfig, undefined, {
      ...defaultOptions,
      globalProvider: 'opencode-zen',
      apiKeys: { OPENCODE_ZEN_API_KEY: 'k' },
      enableContradictionCues: true,
    });
    assert.equal(cx(sources), undefined);
  });

  it('is absent when the feature is off', () => {
    const sources = buildSourcesFromConfig(emptyConfig, undefined, { ...defaultOptions });
    assert.equal(cx(sources), undefined);
  });
});
