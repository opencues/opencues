/**
 * Tests for build-sources.ts
 *
 * Run with: node --test dist/sources/build-sources.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildSourcesFromConfig, combineWordSources } from './build-sources';
import { ConfigSource } from './config-source';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { CuesMdConfig, SourceConfig, PromptConfig } from '../cues-md';
import { HttpAdapter } from '../types';

// Stub HTTP adapter (never called in these tests)
const stubAdapter: HttpAdapter = {
  post: async () => '{}',
};

const defaultOptions = {
  httpAdapter: stubAdapter,
  endpoint: 'https://api.example.com/v1/chat/completions',
  apiKey: 'test-key',
  defaultModel: 'test-model',
  enableWordCues: true,
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
          legal: { name: 'legal', promptText: 'Legal prompt.', priority: 70, match: 'contract' },
          medical: { name: 'medical', promptText: 'Medical prompt.', priority: 75, match: 'diagnosis' },
          financial: { name: 'financial', promptText: 'Financial prompt.', priority: 65, keywords: 'stock,bond' },
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
          legal: { name: 'legal', promptText: 'Legal.', priority: 70, match: 'contract' },
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
          legal: { name: 'legal', promptText: 'Legal.', priority: 70, match: 'contract' },
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
          legal: { name: 'legal', promptText: 'Legal.', priority: 70, match: 'contract' },
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
          legal: { name: 'legal', promptText: 'Legal.', priority: 70, match: 'contract' },
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
          legal: { name: 'legal', promptText: 'Legal.', match: 'contract' },
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
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), true);
  });

  it('words scope: does not support blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.', scope: 'words' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), false);
  });

  it('blanks scope: supports blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), true);
  });

  it('blanks scope: does not support non-blank text', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Fill.', scope: 'blanks' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), false);
  });

  it('all scope: supports both blank and non-blank', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'generic', promptText: 'Any.', scope: 'all' },
      ...defaultOptions,
    });
    assert.strictEqual(src.supports({ text: 'hello world', words: ['hello', 'world'] }), true);
    assert.strictEqual(src.supports({ text: 'hello _', words: ['hello', '_'] }), true);
  });

  it('default scope is words', () => {
    const src = new ConfigSource({
      sourceConfig: { name: 'grammar', promptText: 'Alts.' },
      ...defaultOptions,
    });
    assert.strictEqual(src.scope, 'words');
  });
});
