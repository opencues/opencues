/**
 * Tests for RoutedWordSourceGroup — per-word routing of word-alts to one
 * of N child ConfigSources via match/keywords/priority/default.
 *
 * Run with: node --test dist/sources/routed-word-source-group.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { RoutedWordSourceGroup } from './routed-word-source-group';
import { ConfigSource } from './config-source';
import { CueContext, CueSourceResult, HttpAdapter } from '../types';
import { SourceConfig } from '../cues-md';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
// Routing — domain vs default precedence
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: classification', () => {
  it('routes domain match (regex) over default', () => {
    const grammar = mkSource('grammar', { priority: 50 });                          // default
    const sync = mkSource('sync', { match: '\\b(synced|bundled)\\b', priority: 80 }); // domain
    const group = new RoutedWordSourceGroup({ sources: [grammar, sync] });
    assert.strictEqual(group.classify('synced')?.id, 'sync');
    assert.strictEqual(group.classify('happy')?.id, 'grammar'); // falls through to default
  });

  it('routes domain match (keywords) over default', () => {
    const grammar = mkSource('grammar', { priority: 50 });
    const legal = mkSource('legal', { keywords: 'contract, plaintiff, tort', priority: 70 });
    const group = new RoutedWordSourceGroup({ sources: [grammar, legal] });
    assert.strictEqual(group.classify('contract')?.id, 'legal');
    assert.strictEqual(group.classify('plaintiff')?.id, 'legal');
    assert.strictEqual(group.classify('happy')?.id, 'grammar');
  });

  it('keyword matching is case-insensitive', () => {
    const legal = mkSource('legal', { keywords: 'Contract, Plaintiff' });
    const grammar = mkSource('grammar');
    const group = new RoutedWordSourceGroup({ sources: [grammar, legal] });
    assert.strictEqual(group.classify('contract')?.id, 'legal');
    assert.strictEqual(group.classify('CONTRACT')?.id, 'legal');
  });

  it('priority breaks ties between two matching domains', () => {
    const a = mkSource('a', { keywords: 'word', priority: 60 });
    const b = mkSource('b', { keywords: 'word', priority: 90 });   // wins
    const c = mkSource('c', { keywords: 'word', priority: 50 });
    const group = new RoutedWordSourceGroup({ sources: [a, b, c] });
    assert.strictEqual(group.classify('word')?.id, 'b');
  });

  it('falls through to default when no domain matches', () => {
    const grammar = mkSource('grammar', { priority: 50 });
    const legal = mkSource('legal', { keywords: 'contract', priority: 70 });
    const group = new RoutedWordSourceGroup({ sources: [grammar, legal] });
    assert.strictEqual(group.classify('happy')?.id, 'grammar');
  });

  it('returns null when no domain matches AND no default exists', () => {
    // No catch-all — opt-in projects (e.g. only legal terms get cues).
    const legal = mkSource('legal', { keywords: 'contract' });
    const group = new RoutedWordSourceGroup({ sources: [legal] });
    assert.strictEqual(group.classify('contract')?.id, 'legal');
    assert.strictEqual(group.classify('happy'), null);
  });

  it('picks highest-priority default when multiple defaults exist', () => {
    const grammar = mkSource('grammar', { priority: 50 });
    const myStyle = mkSource('my-style', { priority: 60 });    // wins
    const group = new RoutedWordSourceGroup({ sources: [grammar, myStyle] });
    assert.strictEqual(group.classify('happy')?.id, 'my-style');
  });

  it('classifies a source with both match AND keywords as a domain', () => {
    // Either rule can fire it.
    const both = mkSource('both', {
      match: '\\bfoo\\b',
      keywords: 'bar, baz',
    });
    const grammar = mkSource('grammar');
    const group = new RoutedWordSourceGroup({ sources: [grammar, both] });
    assert.strictEqual(group.classify('foo')?.id, 'both');     // regex hit
    assert.strictEqual(group.classify('bar')?.id, 'both');     // keyword hit
    assert.strictEqual(group.classify('happy')?.id, 'grammar'); // neither → default
  });

  it('handles malformed match regex gracefully (skips that entry)', () => {
    const bad = mkSource('bad', { match: '[invalid' });        // unbalanced bracket
    const grammar = mkSource('grammar');
    const group = new RoutedWordSourceGroup({ sources: [grammar, bad] });
    // 'bad' has no usable matchRe and no keywords → treated as a SECOND default,
    // grammar (priority tie) — first registered wins by sort stability when equal.
    // Either default returning is acceptable; what matters is no throw.
    const r = group.classify('anything');
    assert.ok(r !== null);
  });
});

// ---------------------------------------------------------------------------
// supports() — gates whether the group runs at all
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: supports()', () => {
  const group = new RoutedWordSourceGroup({ sources: [mkSource('grammar')] });

  it('supports a context with at least one cycleable word', () => {
    assert.strictEqual(group.supports(mkContext(['happy'])), true);
    assert.strictEqual(group.supports(mkContext(['the', 'happy', 'cat'])), true);
  });

  it('rejects an empty word list', () => {
    assert.strictEqual(group.supports(mkContext([])), false);
  });

  it('rejects when only blanks are present (those go through ClassifiedSourceGroup)', () => {
    assert.strictEqual(group.supports(mkContext(['_'])), false);
  });

  it('rejects mixed text + blank — blank handlers (fluid-blank, control) own the slot', () => {
    // Word-alts skip when `_` is present so the blank-fill handler can
    // take over without competing word-alt LLM calls. See
    // routed-word-source-group.ts supports() rationale.
    assert.strictEqual(group.supports(mkContext(['happy', '_'])), false);
  });
});

// ---------------------------------------------------------------------------
// routingStats — debug accessor
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: routingStats', () => {
  it('counts domain vs default sources', () => {
    const sources = [
      mkSource('grammar'),                                            // default
      mkSource('legal', { keywords: 'contract' }),                    // domain
      mkSource('medical', { match: '\\b(diagnosis|prescription)\\b' }), // domain
      mkSource('my-style'),                                           // default
    ];
    const group = new RoutedWordSourceGroup({ sources });
    assert.deepStrictEqual(group.routingStats, { domains: 2, defaults: 2 });
  });
});

// ---------------------------------------------------------------------------
// getCues — multi-word grouping & dispatch
// ---------------------------------------------------------------------------

describe('RoutedWordSourceGroup: getCues()', () => {
  // A fake ConfigSource that records the sub-context it received and
  // returns canned alts. Lets us verify grouping + index-remapping
  // without standing up an LLM.
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
      // Return one alt per word, indexed by the SUB-context's positions.
      // RoutedWordSourceGroup must remap these to original indices.
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
    const grammar = new RecordingSource('grammar');                                   // default
    const legal = new RecordingSource('legal', { keywords: 'contract, plaintiff' });  // domain
    const group = new RoutedWordSourceGroup({ sources: [grammar as any, legal as any] });

    // 4 words: 2 default → grammar, 2 domain → legal.
    const ctx = mkContext(['happy', 'contract', 'sad', 'plaintiff']);
    const out = await group.getCues(ctx);

    assert.strictEqual(grammar.received.length, 1, 'grammar called once');
    assert.strictEqual(legal.received.length, 1, 'legal called once');
    assert.deepStrictEqual(grammar.received[0].words, ['happy', 'sad']);
    assert.deepStrictEqual(legal.received[0].words, ['contract', 'plaintiff']);

    // Verify index remap: each result's wordIndex is the position in the
    // ORIGINAL context, not the sub-context.
    const byOriginal = new Map(out.results.map(r => [r.wordIndex, r.source]));
    assert.strictEqual(byOriginal.get(0), 'grammar');  // happy
    assert.strictEqual(byOriginal.get(1), 'legal');    // contract
    assert.strictEqual(byOriginal.get(2), 'grammar');  // sad
    assert.strictEqual(byOriginal.get(3), 'legal');    // plaintiff
  });

  it('skips blank ("_") words and zero-length entries', async () => {
    const grammar = new RecordingSource('grammar');
    const group = new RoutedWordSourceGroup({ sources: [grammar as any] });
    const out = await group.getCues(mkContext(['happy', '_', 'sad', '']));

    assert.strictEqual(grammar.received.length, 1);
    assert.deepStrictEqual(grammar.received[0].words, ['happy', 'sad']);
    assert.strictEqual(out.results.length, 2);
    assert.deepStrictEqual(
      out.results.map(r => r.wordIndex).sort(),
      [0, 2],
    );
  });

  it('returns no results when no source can handle any word', async () => {
    // Domain-only config (no default). Words that don't match are silently dropped.
    const legal = new RecordingSource('legal', { keywords: 'contract' });
    const group = new RoutedWordSourceGroup({ sources: [legal as any] });
    const out = await group.getCues(mkContext(['happy', 'sad', 'angry']));
    assert.strictEqual(out.results.length, 0);
    assert.strictEqual(legal.received.length, 0, 'no dispatch when nothing routed');
  });

  it('partial routing: some words route, others drop', async () => {
    const legal = new RecordingSource('legal', { keywords: 'contract' });
    const group = new RoutedWordSourceGroup({ sources: [legal as any] });
    const out = await group.getCues(mkContext(['happy', 'contract', 'sad']));
    assert.strictEqual(legal.received.length, 1);
    assert.deepStrictEqual(legal.received[0].words, ['contract']);
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].wordIndex, 1);  // original index of 'contract'
  });

  it('priority is the max across child sources', () => {
    const a = mkSource('a', { priority: 30 });
    const b = mkSource('b', { priority: 90 });
    const c = mkSource('c', { priority: 60 });
    const group = new RoutedWordSourceGroup({ sources: [a, b, c] });
    assert.strictEqual(group.priority, 90);
  });
});
