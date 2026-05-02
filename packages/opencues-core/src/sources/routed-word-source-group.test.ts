/**
 * Tests for RoutedWordSourceGroup — per-word routing of word-cues to one
 * of N child ConfigSources via match/keywords/priority. Catch-all
 * defaults are not supported; every source must declare its scope.
 *
 * Run with: node --test dist/sources/routed-word-source-group.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { ConfigSource } from './config-source';
import { CueContext, CueSourceResult, HttpAdapter } from '../types';
import { SourceConfig } from '../cues-md';

const stubAdapter: HttpAdapter = { post: async () => '{"choices":[{"message":{"content":""}}]}' };

function mkSource(name: string, partial: Partial<SourceConfig> = {}): ConfigSource {
  const cfg: SourceConfig = {
    name,
    promptText: `prompt for ${name}`,
    priority: 50,
    parser: 'alternatives',
    scope: 'words',
    ...partial,
  };
  return new ConfigSource({
    sourceConfig: cfg,
    httpAdapter: stubAdapter,
    endpoint: 'https://example.test',
    apiKey: 'k',
    defaultModel: 'm',
  });
}

function mkContext(words: string[]): CueContext {
  return { text: words.join(' '), words };
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: classification', () => {
  it('routes by regex match', () => {
    const sync = mkSource('sync', { match: '\\b(synced|bundled)\\b', priority: 80 });
    const legal = mkSource('legal', { keywords: 'contract', priority: 70 });
    const group = new RoutedWordSourceGroup({ sources: [sync, legal] });
    assert.strictEqual(group.classify('synced')?.id, 'sync');
    assert.strictEqual(group.classify('contract')?.id, 'legal');
  });

  it('routes by keywords (case-insensitive)', () => {
    const legal = mkSource('legal', { keywords: 'Contract, Plaintiff' });
    const group = new RoutedWordSourceGroup({ sources: [legal] });
    assert.strictEqual(group.classify('contract')?.id, 'legal');
    assert.strictEqual(group.classify('CONTRACT')?.id, 'legal');
  });

  it('priority breaks ties between two matching sources', () => {
    const a = mkSource('a', { keywords: 'word', priority: 60 });
    const b = mkSource('b', { keywords: 'word', priority: 90 });
    const c = mkSource('c', { keywords: 'word', priority: 50 });
    const group = new RoutedWordSourceGroup({ sources: [a, b, c] });
    assert.strictEqual(group.classify('word')?.id, 'b');
  });

  it('returns null when no source matches', () => {
    const legal = mkSource('legal', { keywords: 'contract' });
    const group = new RoutedWordSourceGroup({ sources: [legal] });
    assert.strictEqual(group.classify('contract')?.id, 'legal');
    assert.strictEqual(group.classify('happy'), null);
  });

  it('a source with both match AND keywords is routable by either', () => {
    const both = mkSource('both', { match: '\\bfoo\\b', keywords: 'bar, baz' });
    const group = new RoutedWordSourceGroup({ sources: [both] });
    assert.strictEqual(group.classify('foo')?.id, 'both');
    assert.strictEqual(group.classify('bar')?.id, 'both');
    assert.strictEqual(group.classify('happy'), null);
  });

  it('drops sources with neither match: nor keywords:', () => {
    // Catch-all sources are no longer permitted — group rejects on construct.
    const catchAll = mkSource('catchAll', { priority: 50 });
    const legal = mkSource('legal', { keywords: 'contract', priority: 70 });
    const group = new RoutedWordSourceGroup({ sources: [catchAll, legal] });
    assert.strictEqual(group.routingStats.sources, 1);
    assert.strictEqual(group.classify('contract')?.id, 'legal');
    assert.strictEqual(group.classify('happy'), null);
  });

  it('handles malformed match regex gracefully (skips that entry)', () => {
    // Bad regex AND no keywords → entry has no usable rule, gets rejected.
    const bad = mkSource('bad', { match: '[invalid' });
    const legal = mkSource('legal', { keywords: 'contract' });
    const group = new RoutedWordSourceGroup({ sources: [bad, legal] });
    assert.strictEqual(group.routingStats.sources, 1);
    assert.strictEqual(group.classify('contract')?.id, 'legal');
  });
});

// ---------------------------------------------------------------------------
// supports() — gates whether the group runs at all
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: supports()', () => {
  const group = new RoutedWordSourceGroup({ sources: [mkSource('legal', { keywords: 'contract' })] });

  it('supports a context with at least one cycleable word', () => {
    assert.strictEqual(group.supports(mkContext(['happy'])), true);
    assert.strictEqual(group.supports(mkContext(['the', 'happy', 'cat'])), true);
  });

  it('rejects an empty word list', () => {
    assert.strictEqual(group.supports(mkContext([])), false);
  });

  it('rejects when only blanks are present', () => {
    assert.strictEqual(group.supports(mkContext(['_'])), false);
  });

  it('rejects mixed text + blank — blank handlers own the slot', () => {
    assert.strictEqual(group.supports(mkContext(['happy', '_'])), false);
  });
});

// ---------------------------------------------------------------------------
// routingStats — debug accessor
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: routingStats', () => {
  it('counts the routed sources', () => {
    const sources = [
      mkSource('legal', { keywords: 'contract' }),
      mkSource('medical', { match: '\\b(diagnosis|prescription)\\b' }),
      mkSource('financial', { keywords: 'stock,bond' }),
    ];
    const group = new RoutedWordSourceGroup({ sources });
    assert.deepStrictEqual(group.routingStats, { sources: 3 });
  });
});

// ---------------------------------------------------------------------------
// getCues — multi-word grouping & dispatch
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: getCues()', () => {
  class RecordingSource {
    readonly id: string;
    readonly priority: number;
    readonly sourceConfig: SourceConfig;
    readonly received: CueContext[] = [];
    constructor(name: string, partial: Partial<SourceConfig> = {}) {
      this.id = name;
      this.priority = partial.priority ?? 50;
      this.sourceConfig = { name, promptText: `p-${name}`, ...partial };
    }
    supports() { return true; }
    async getCues(context: CueContext): Promise<CueSourceResult> {
      this.received.push(context);
      return {
        results: context.words.map((w, i) => ({
          wordIndex: i,
          word: w,
          alternatives: [w, `${this.id}-alt-${w}`],
          source: this.id,
          priority: this.priority,
        })),
        timing: 0,
      };
    }
  }

  it('groups words by routed source and dispatches one call per group', async () => {
    const legal = new RecordingSource('legal', { keywords: 'contract, plaintiff' });
    const medical = new RecordingSource('medical', { keywords: 'diagnosis' });
    const group = new RoutedWordSourceGroup({ sources: [legal as any, medical as any] });

    const ctx = mkContext(['happy', 'contract', 'diagnosis', 'plaintiff']);
    const out = await group.getCues(ctx);

    assert.strictEqual(legal.received.length, 1, 'legal called once');
    assert.strictEqual(medical.received.length, 1, 'medical called once');
    assert.deepStrictEqual(legal.received[0].words, ['contract', 'plaintiff']);
    assert.deepStrictEqual(medical.received[0].words, ['diagnosis']);

    const byOriginal = new Map(out.results.map(r => [r.wordIndex, r.source]));
    assert.strictEqual(byOriginal.get(1), 'legal');
    assert.strictEqual(byOriginal.get(2), 'medical');
    assert.strictEqual(byOriginal.get(3), 'legal');
    assert.strictEqual(byOriginal.has(0), false); // happy → no source → dropped
  });

  it('skips blank ("_") words and zero-length entries', async () => {
    const legal = new RecordingSource('legal', { keywords: 'contract,plaintiff,happy' });
    const group = new RoutedWordSourceGroup({ sources: [legal as any] });
    const out = await group.getCues(mkContext(['happy', '_', 'plaintiff', '']));

    assert.strictEqual(legal.received.length, 1);
    assert.deepStrictEqual(legal.received[0].words, ['happy', 'plaintiff']);
    assert.strictEqual(out.results.length, 2);
    assert.deepStrictEqual(out.results.map(r => r.wordIndex).sort(), [0, 2]);
  });

  it('returns no results when no source can handle any word', async () => {
    const legal = new RecordingSource('legal', { keywords: 'contract' });
    const group = new RoutedWordSourceGroup({ sources: [legal as any] });
    const out = await group.getCues(mkContext(['happy', 'sad', 'angry']));
    assert.strictEqual(out.results.length, 0);
    assert.strictEqual(legal.received.length, 0);
  });

  it('partial routing: some words route, others drop', async () => {
    const legal = new RecordingSource('legal', { keywords: 'contract' });
    const group = new RoutedWordSourceGroup({ sources: [legal as any] });
    const out = await group.getCues(mkContext(['happy', 'contract', 'sad']));
    assert.strictEqual(legal.received.length, 1);
    assert.deepStrictEqual(legal.received[0].words, ['contract']);
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].wordIndex, 1);
  });

  it('priority is the max across child sources', () => {
    const a = mkSource('a', { keywords: 'foo', priority: 30 });
    const b = mkSource('b', { keywords: 'bar', priority: 90 });
    const c = mkSource('c', { keywords: 'baz', priority: 60 });
    const group = new RoutedWordSourceGroup({ sources: [a, b, c] });
    assert.strictEqual(group.priority, 90);
  });
});
