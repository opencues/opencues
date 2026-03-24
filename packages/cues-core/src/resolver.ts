/**
 * cues-core/resolver.ts
 *
 * CueResolver - orchestrates multiple cue sources to produce merged results.
 */

import {
  CueSource,
  CueContext,
  CueResult,
  CueSourceResult,
  CueResolverConfig,
  CueMetrics,
} from './types';

/**
 * Result from the resolver including all metrics.
 */
export interface ResolverResult {
  /** Merged results from all sources */
  results: CueResult[];

  /** Per-source metrics */
  metrics: CueMetrics[];

  /** Total time taken */
  totalTime: number;

  /** Any errors encountered */
  errors: Array<{ sourceId: string; error: string }>;
}

/**
 * CueResolver - queries multiple sources and merges results.
 *
 * Sources are queried in priority order (highest first).
 * Results are merged with higher-priority sources winning conflicts.
 */
export class CueResolver {
  private sources: CueSource[];
  private config: CueResolverConfig;

  constructor(sources: CueSource[], config: CueResolverConfig = {}) {
    // Sort sources by priority (highest first)
    this.sources = [...sources].sort((a, b) => b.priority - a.priority);
    this.config = {
      parallel: false,
      timeout: 30000,
      continueOnError: true,
      ...config,
    };
  }

  /**
   * Resolve cues for the given context.
   *
   * @param context - The context to resolve cues for
   * @returns Merged results from all applicable sources
   */
  async resolve(context: CueContext): Promise<ResolverResult> {
    const startTime = Date.now();
    const metrics: CueMetrics[] = [];
    const errors: Array<{ sourceId: string; error: string }> = [];
    const resultsByIndex = new Map<number, CueResult>();

    // Filter to applicable sources
    const applicableSources = this.sources.filter((s) => s.supports(context));

    if (this.config.parallel) {
      // Query all sources in parallel
      const promises = applicableSources.map((source) =>
        this.querySourceWithTimeout(source, context)
      );
      const sourceResults = await Promise.all(promises);

      for (let i = 0; i < sourceResults.length; i++) {
        const source = applicableSources[i];
        const result = sourceResults[i];
        this.processSourceResult(
          source,
          result,
          resultsByIndex,
          metrics,
          errors
        );
      }
    } else {
      // Query sources sequentially in priority order
      for (const source of applicableSources) {
        const result = await this.querySourceWithTimeout(source, context);
        this.processSourceResult(
          source,
          result,
          resultsByIndex,
          metrics,
          errors
        );
      }
    }

    // Convert map to array, sorted by word index
    const results = Array.from(resultsByIndex.values()).sort(
      (a, b) => a.wordIndex - b.wordIndex
    );

    return {
      results,
      metrics,
      totalTime: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Query a source with timeout handling.
   */
  private async querySourceWithTimeout(
    source: CueSource,
    context: CueContext
  ): Promise<CueSourceResult> {
    const startTime = Date.now();

    try {
      const timeoutPromise = new Promise<CueSourceResult>((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), this.config.timeout);
      });

      const result = await Promise.race([
        source.getCues(context),
        timeoutPromise,
      ]);

      return result;
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  /**
   * Process a source result into the merged results map.
   */
  private processSourceResult(
    source: CueSource,
    result: CueSourceResult,
    resultsByIndex: Map<number, CueResult>,
    metrics: CueMetrics[],
    errors: Array<{ sourceId: string; error: string }>
  ): void {
    // Record metrics
    metrics.push({
      sourceId: source.id,
      latencyMs: result.timing ?? 0,
      resultCount: result.results.length,
      cacheHit: false,
      error: result.error,
    });

    // Record errors
    if (result.error) {
      errors.push({ sourceId: source.id, error: result.error });
      if (!this.config.continueOnError) {
        return;
      }
    }

    // Merge results (higher priority wins on conflict)
    for (const cueResult of result.results) {
      const existing = resultsByIndex.get(cueResult.wordIndex);
      if (!existing || cueResult.priority > existing.priority) {
        resultsByIndex.set(cueResult.wordIndex, cueResult);
      } else if (cueResult.priority === existing.priority) {
        // Same priority - merge alternatives
        const merged = this.mergeResults(existing, cueResult);
        resultsByIndex.set(cueResult.wordIndex, merged);
      }
    }
  }

  /**
   * Merge two results for the same word.
   */
  private mergeResults(existing: CueResult, incoming: CueResult): CueResult {
    // Merge alternatives (deduplicate)
    const altSet = new Set<string>(existing.alternatives);
    for (const alt of incoming.alternatives) {
      altSet.add(alt);
    }

    // Merge altTips
    const altTips = { ...existing.altTips, ...incoming.altTips };

    // Merge linked (deduplicate)
    const linkedSet = new Set<number>([
      ...(existing.linked || []),
      ...(incoming.linked || []),
    ]);

    return {
      ...existing,
      alternatives: Array.from(altSet),
      altTips: Object.keys(altTips).length > 0 ? altTips : undefined,
      linked: linkedSet.size > 0 ? Array.from(linkedSet) : undefined,
    };
  }

  /**
   * Add a source to the resolver.
   */
  addSource(source: CueSource): void {
    this.sources.push(source);
    this.sources.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a source by ID.
   */
  removeSource(id: string): boolean {
    const index = this.sources.findIndex((s) => s.id === id);
    if (index >= 0) {
      this.sources.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get all registered sources.
   */
  getSources(): CueSource[] {
    return [...this.sources];
  }
}

/**
 * Create a resolver with default configuration.
 */
export function createResolver(
  sources: CueSource[],
  config?: CueResolverConfig
): CueResolver {
  return new CueResolver(sources, config);
}
