/**
 * opencues-core/sources/routed-word-source-group.ts
 *
 * Wraps multiple word-alts ConfigSource children and dispatches each
 * highlighted word to ONE of them based on per-source `match:` /
 * `keywords:` rules + priority. Mirrors `ClassifiedSourceGroup` (used
 * for blanks) but the routing is purely fast-path — no LLM classifier
 * is consulted.
 *
 * Why not "combine all sources into one giant prompt" (the previous
 * approach in build-sources.ts):
 *
 * - Cross-contamination: a sloppy or hijacking prompt in one source
 *   could affect ALL words. (See sync-demo class of bug.)
 * - Scaling: combined prompts grow linearly with source count and
 *   start confusing the LLM at ~5+ domains.
 * - Symmetry: blanks already use a classified-source-group; word-alts
 *   should follow the same model.
 *
 * Routing rules (per word):
 *
 * 1. Domain sources (have `match:` OR `keywords:`):
 *      - Try each entry in priority-descending order
 *      - First entry whose match-regex hits the word OR whose keyword
 *        list contains the word wins
 *
 * 2. Default sources (have NEITHER `match:` NOR `keywords:`):
 *      - Highest priority default catches everything else
 *
 * 3. No source matched + no default exists:
 *      - Word produces no cue (not navigable; correct for opt-in projects)
 *
 * Multi-word dispatch:
 *
 *   For a text with N highlighted words, route each one, GROUP by
 *   destination source, and dispatch ONE LLM call per group with a
 *   sub-context containing only that group's words (renumbered 0..k).
 *   Results are mapped back to the original word indices before
 *   returning. Calls run in parallel (Promise.all).
 */

import {
  CueSource,
  CueContext,
  CueSourceResult,
  CueResult,
} from '../types';
import { ConfigSource } from './config-source';

export interface RoutedWordSourceGroupConfig {
  /** Group identifier (default: 'word-alts'). */
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

  /** Sources with `match:` or `keywords:` — checked first, priority desc. */
  private readonly domainEntries: readonly RouteEntry[];
  /** Sources with NEITHER `match:` nor `keywords:` — fallback, priority desc. */
  private readonly defaultEntries: readonly RouteEntry[];

  constructor(config: RoutedWordSourceGroupConfig) {
    this.id = config.id ?? 'word-alts';
    this.priority = config.sources.reduce((m, s) => Math.max(m, s.priority), 0);

    const domain: RouteEntry[] = [];
    const defaults: RouteEntry[] = [];
    for (const source of config.sources) {
      const cfg = source.sourceConfig;
      const entry: RouteEntry = { source, priority: source.priority };
      if (cfg.match) {
        try { entry.matchRe = new RegExp(cfg.match, 'i'); } catch { /* skip bad regex */ }
      }
      if (cfg.keywords) {
        entry.keywords = cfg.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
      }
      if (entry.matchRe || (entry.keywords && entry.keywords.length > 0)) {
        domain.push(entry);
      } else {
        defaults.push(entry);
      }
    }
    // Highest priority first — first match wins.
    this.domainEntries = [...domain].sort((a, b) => b.priority - a.priority);
    this.defaultEntries = [...defaults].sort((a, b) => b.priority - a.priority);
  }

  /** Word-alts apply when there's plain text to alt. Skip pure-blank inputs
   *  (those go through the blanks ClassifiedSourceGroup). */
  supports(context: CueContext): boolean {
    if (!context.words || context.words.length === 0) return false;
    return context.words.some(w => w !== '_' && w.length > 0);
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
    // (= no cue / not navigable). That's the user's choice when they opt
    // out of having a default source.
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
   * Order: highest-priority domain match > highest-priority default >
   * null (no source).
   */
  classify(word: string): ConfigSource | null {
    const lower = word.toLowerCase();
    for (const entry of this.domainEntries) {
      if (entry.matchRe && entry.matchRe.test(word)) return entry.source;
      if (entry.keywords && entry.keywords.includes(lower)) return entry.source;
    }
    return this.defaultEntries[0]?.source ?? null;
  }

  /** Public for tests / debug — counts of domain vs default sources. */
  get routingStats(): { domains: number; defaults: number } {
    return { domains: this.domainEntries.length, defaults: this.defaultEntries.length };
  }
}
