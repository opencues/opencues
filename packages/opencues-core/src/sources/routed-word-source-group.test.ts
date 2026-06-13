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
import { getProvider } from '../llm-provider';

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
    provider: getProvider('groq')!,
    endpoint: 'https://example.test',
    apiKey: 'k',
    model: 'm',
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

// ---------------------------------------------------------------------------
// getCues — result cache
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: result cache', () => {
  /** Records every dispatch call. Returns predictable results so the
   *  test can distinguish cache hits (mapped output) from misses
   *  (LLM-call simulated by `received.push`). */
  class CountingSource {
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
      // Pretend NO misspellings for 'cat'/'sat'/'mat'; ONE for 'teh'.
      const results = context.words.flatMap((w, i) =>
        w === 'teh'
          ? [{ wordIndex: i, word: w, alternatives: ['teh', 'the'], source: this.id, priority: this.priority }]
          : []
      );
      return { results, timing: 0 };
    }
  }

  it('zero-result responses are cached — second call with identical words skips dispatch', async () => {
    const spelling = new CountingSource('spelling', { match: '.*' });
    const group = new RoutedWordSourceGroup({ sources: [spelling as any] });

    await group.getCues(mkContext(['cat', 'sat', 'mat']));
    assert.strictEqual(spelling.received.length, 1, 'first call dispatches');

    await group.getCues(mkContext(['cat', 'sat', 'mat']));
    assert.strictEqual(spelling.received.length, 1, 'second call hits cache, no dispatch');

    // Sanity: cache populated.
    const sizes = Array.from(group.cacheSizes().values());
    assert.strictEqual(sizes[0], 1, 'one cache entry');
  });

  it('positive results are cached AND remapped to current buffer positions', async () => {
    const spelling = new CountingSource('spelling', { match: '.*' });
    const group = new RoutedWordSourceGroup({ sources: [spelling as any] });

    // First call: 'teh' is at original index 1.
    const out1 = await group.getCues(mkContext(['cat', 'teh', 'mat']));
    assert.strictEqual(spelling.received.length, 1);
    assert.strictEqual(out1.results.length, 1);
    assert.strictEqual(out1.results[0].wordIndex, 1);

    // Second call: same word set, but surrounded by other prose. 'teh'
    // is at original index 4 now. Sub-context is the same → cache hit,
    // but wordIndex must be remapped to 4 (not the stale 1).
    const out2 = await group.getCues(mkContext(['a', 'b', 'c', 'd', 'teh', 'e']));
    // Note 'a','b','c','d','e' all match `.*` too, so they all route to
    // spelling — the bucket is ['a','b','c','d','teh','e']. The sub-
    // context text differs (more words). Expect a miss here, not a hit.
    assert.strictEqual(spelling.received.length, 2, 'different word set → miss');
    assert.strictEqual(out2.results.length, 1);
    assert.strictEqual(out2.results[0].wordIndex, 4, 'remapped to original index');

    // Third call: SAME word set as the first call. Cache hit; remap
    // pins teh to its current original index (still 1 here).
    const out3 = await group.getCues(mkContext(['cat', 'teh', 'mat']));
    assert.strictEqual(spelling.received.length, 2, 'same word set as call 1 → cache hit');
    assert.strictEqual(out3.results[0].wordIndex, 1);
  });

  it('different sub-context per source — each source has its own cache', async () => {
    const legal = new CountingSource('legal', { keywords: 'contract' });
    const spelling = new CountingSource('spelling', { match: '.*', priority: 10 });
    const group = new RoutedWordSourceGroup({ sources: [legal as any, spelling as any] });

    await group.getCues(mkContext(['the', 'contract', 'is']));
    assert.strictEqual(legal.received.length, 1);
    assert.strictEqual(spelling.received.length, 1);

    await group.getCues(mkContext(['the', 'contract', 'is']));
    assert.strictEqual(legal.received.length, 1, 'legal cache hit');
    assert.strictEqual(spelling.received.length, 1, 'spelling cache hit');
  });

  it('LRU eviction drops oldest entries past CACHE_SIZE_PER_SOURCE', async () => {
    const spelling = new CountingSource('spelling', { match: '.*' });
    const group = new RoutedWordSourceGroup({ sources: [spelling as any] });

    // Fill cache with 65 distinct word sets (size cap is 64).
    for (let i = 0; i < 65; i++) {
      await group.getCues(mkContext([`word${i}`]));
    }
    assert.strictEqual(spelling.received.length, 65);
    assert.strictEqual(group.cacheSizes().values().next().value, 64, 'cache stays at cap');

    // First-inserted entry (`word0`) should have been evicted.
    await group.getCues(mkContext(['word0']));
    assert.strictEqual(spelling.received.length, 66, 'word0 evicted → re-dispatched');

    // Most-recent entry (`word64`) should still be cached.
    await group.getCues(mkContext(['word64']));
    assert.strictEqual(spelling.received.length, 66, 'word64 still cached');
  });

  it('LRU recency — hit reorders entry to most-recent', async () => {
    const spelling = new CountingSource('spelling', { match: '.*' });
    const group = new RoutedWordSourceGroup({ sources: [spelling as any] });

    // Insert entries A and B.
    await group.getCues(mkContext(['A']));
    await group.getCues(mkContext(['B']));
    // Hit A — moves it to most-recent.
    await group.getCues(mkContext(['A']));
    assert.strictEqual(spelling.received.length, 2);

    // Now fill 63 more entries. B was second-oldest → should evict
    // BEFORE A on overflow.
    for (let i = 0; i < 63; i++) {
      await group.getCues(mkContext([`fill${i}`]));
    }
    // Cache should be at cap (64). B should have been evicted; A should remain.
    assert.strictEqual(spelling.received.length, 65);

    await group.getCues(mkContext(['A']));
    assert.strictEqual(spelling.received.length, 65, 'A still cached after recency promotion');

    await group.getCues(mkContext(['B']));
    assert.strictEqual(spelling.received.length, 66, 'B evicted → re-dispatched');
  });
});
