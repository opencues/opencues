/**
 * opencues-core/sources/routed-word-source-group.ts
 *
 * Wraps multiple word-cue ConfigSource children and dispatches each
 * highlighted word to ONE of them based on per-source `match:` /
 * `keywords:` rules + priority. Routing is purely fast-path — no LLM
 * classifier is consulted.
 *
 * Why not "combine all sources into one giant prompt" (the previous
 * approach in build-sources.ts):
 *
 * - Cross-contamination: a sloppy or hijacking prompt in one source
 *   could affect ALL words. (See sync-demo class of bug.)
 * - Scaling: combined prompts grow linearly with source count and
 *   start confusing the LLM at ~5+ domains.
 *
 * Routing rules (per word):
 *
 *   - Try each source in priority-descending order.
 *   - First source whose `match:` regex hits the word OR whose
 *     `keywords:` list contains it wins.
 *   - No match → no cue. The word is not navigable. Sources without
 *     `match:`/`keywords:` are rejected by the constructor; every
 *     cue source must declare its scope.
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
} from '../types';
import { ConfigSource } from './config-source';

export interface RoutedWordSourceGroupConfig {
  /** Group identifier (default: 'word-cues'). */
  id?: string;
  /** Child sources — one per ### alternatives section, scope: words. */
  sources: ConfigSource[];
}

interface RouteEntry {
  source: ConfigSource;
  matchRe?: RegExp;
  keywords?: string[];
  priority: number;
}

export class RoutedWordSourceGroup implements CueSource {
  readonly id: string;
  readonly priority: number;

  /** Sources with `match:` or `keywords:` — checked priority desc. */
  private readonly entries: readonly RouteEntry[];

  constructor(config: RoutedWordSourceGroupConfig) {
    this.id = config.id ?? 'word-cues';
    this.priority = config.sources.reduce((m, s) => Math.max(m, s.priority), 0);

    const entries: RouteEntry[] = [];
    for (const source of config.sources) {
      const cfg = source.sourceConfig;
      const entry: RouteEntry = { source, priority: source.priority };
      if (cfg.match) {
        try { entry.matchRe = new RegExp(cfg.match, 'i'); } catch { /* skip bad regex */ }
      }
      if (cfg.keywords) {
        entry.keywords = cfg.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
      }
      // Reject sources with neither match nor keywords — every cue source
      // must declare what it cares about. Catch-all "default" sources
      // were removed; use an explicit `match: .*` or a keyword list.
      if (!entry.matchRe && (!entry.keywords || entry.keywords.length === 0)) continue;
      entries.push(entry);
    }
    this.entries = [...entries].sort((a, b) => b.priority - a.priority);
  }

  /** Word-cues apply when there's plain text to alt. Skip:
   *   - empty inputs
   *   - inputs containing a `_` blank — the user is invoking a lookup,
   *     not asking for synonyms on surrounding words. Fluid-blank or
   *     keyword-bound blank handlers own that resolve; word-cue LLM
   *     calls just add latency without contributing to the answer. */
  supports(context: CueContext): boolean {
    if (!context.words || context.words.length === 0) return false;
    if (context.words.some(w => w === '_')) return false;
    return context.words.some(w => w.length > 0);
  }

  /**
   * Route every highlighted word to one source, group, dispatch one
   * LLM call per group in parallel, then map indices back.
   */
  async getCues(context: CueContext): Promise<CueSourceResult> {
    const t0 = Date.now();

    // Collect (word, originalIndex) for every cycleable word in the input.
    const items = context.words
      .map((word, idx) => ({ word, idx }))
      .filter(({ word }) => word !== '_' && word.length > 0);

    // Route each word. Words with no matching source are silently dropped
    // (= no cue / not navigable). That's the user's choice when they don't
    // configure a source that covers the word.
    const groups = new Map<ConfigSource, { word: string; idx: number }[]>();
    for (const item of items) {
      const dest = this.classify(item.word);
      if (!dest) continue;
      let bucket = groups.get(dest);
      if (!bucket) { bucket = []; groups.set(dest, bucket); }
      bucket.push(item);
    }

    if (groups.size === 0) return { results: [], timing: Date.now() - t0 };

    // One LLM call per source, parallel. Each call gets a sub-context
    // containing only THAT source's words, renumbered 0..k. We remember
    // the original indices to remap the response.
    const dispatches = Array.from(groups.entries()).map(async ([source, bucket]) => {
      const subContext: CueContext = {
        ...context,
        words: bucket.map(b => b.word),
        text: bucket.map((b, i) => `${i}=${b.word}`).join(' '),
      };
      const result = await source.getCues(subContext);
      // Map sub-context indices back to original context indices.
      return result.results.map<CueResult>(res => ({
        ...res,
        wordIndex: bucket[res.wordIndex]?.idx ?? res.wordIndex,
      }));
    });

    const settled = await Promise.all(dispatches);
    return {
      results: settled.flat(),
      timing: Date.now() - t0,
    };
  }

  /**
   * Pick the destination source for one word. Public for testability.
   * Highest-priority source whose match/keywords cover the word wins;
   * null if no source claims it.
   */
  classify(word: string): ConfigSource | null {
    const lower = word.toLowerCase();
    for (const entry of this.entries) {
      if (entry.matchRe && entry.matchRe.test(word)) return entry.source;
      if (entry.keywords && entry.keywords.includes(lower)) return entry.source;
    }
    return null;
  }

  /** Public for tests / debug — count of routed sources. */
  get routingStats(): { sources: number } {
    return { sources: this.entries.length };
  }
}
