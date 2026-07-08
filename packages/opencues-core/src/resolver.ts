/**
 * opencues-core/resolver.ts
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
/**
 * Dedup-key base for sentence-cue results in the per-resolve merge map. Keeps
 * two sentences that share one whitespace-word (spaceless CJK) from collapsing
 * into a single cue. Offset far past any real word index; the result's own
 * `wordIndex` field is untouched (only the map key changes).
 */
export const SENTENCE_CUE_MERGE_KEY_BASE = 2_000_000;

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

    // Accumulated `_` slots that an upstream source CLAIMED but failed
    // to fill (TransformBlank EXTRACT=TRANSFORM, APPLY empty, etc.).
    // Forwarded to each subsequent source so they don't "vandalise" the
    // user's intent by substituting a slot the upstream was supposed to
    // own. See CueSourceResult.consumedBlankSlots.
    const consumedBlankSlots = new Set<number>(context.consumedBlankSlots ?? []);

    if (this.config.parallel) {
      // Query all sources in parallel. Each source still gets the same
      // starting `consumedBlankSlots`, so dispatch-time bail (e.g.
      // FluidBlank refusing to query when an upstream slot is already
      // claimed) only fires for slots the CALLER passed in — sibling
      // sources in this batch can't see each other's claims at
      // dispatch time. To preserve the claim-then-bail SEMANTIC
      // (TransformBlank claims slot, FluidBlank's lookup answer must
      // NOT vandalise it), we reconcile claims after the parallel
      // batch resolves: iterate sources in priority-descending order
      // (the constructor already sorted `applicableSources` that way),
      // accumulate `consumedBlankSlots` from each source's result as
      // we process it, and FILTER each source's results to drop any
      // CueResult whose `wordIndex` was claimed by a HIGHER-priority
      // source that already ran. A source's own results are never
      // suppressed by its own claim (it gets to fill the slot it
      // claimed). This way the wall-clock win of parallel dispatch
      // (max(source_time) instead of sum) is preserved while still
      // enforcing the higher-priority claim semantic.
      //
      // Sibling-abort: when a higher-priority source produces a
      // whole-buffer claim (`spanStart=0 && spanEnd>=text.length` — the
      // signature ConfigIntent + selector-satellite blanks emit, and
      // TransformBlank emits when it rewrites the full buffer), abort
      // all strictly-lower-priority in-flight siblings. Their results
      // would target spans inside the wiped buffer and be filtered
      // out anyway; aborting saves the LLM round-trip (typically the
      // slowest call in the batch — e.g. Claude Opus on the blanks
      // bucket while ConfigIntent's classifier runs on fast Cerebras).
      // Per-source AbortControllers chain off the context signal so
      // an outer generation-roll still cascades down.
      const controllers = applicableSources.map(() => new AbortController());
      const baseSignal = context.signal;
      if (baseSignal) {
        if (baseSignal.aborted) {
          for (const c of controllers) c.abort();
        } else {
          baseSignal.addEventListener('abort', () => {
            for (const c of controllers) c.abort();
          });
        }
      }
      const promises = applicableSources.map((source, i) =>
        this.querySourceWithTimeout(
          source,
          withConsumed({ ...context, signal: controllers[i].signal }, consumedBlankSlots),
        )
      );

      for (let i = 0; i < promises.length; i++) {
        const source = applicableSources[i];
        const result = await promises[i];

        // Filter results overlapping HIGHER-priority claims accumulated
        // so far. The first (highest-priority) source's results always
        // pass through; subsequent sources lose any wordIndex already
        // in the consumed set. Empty-result sources are unaffected;
        // the filter is a no-op for them.
        const filteredResults = result.results.length === 0 || consumedBlankSlots.size === 0
          ? result.results
          : result.results.filter(r => !consumedBlankSlots.has(r.wordIndex));
        const filteredSourceResult: CueSourceResult = filteredResults === result.results
          ? result
          : { ...result, results: filteredResults };

        // Accumulate this source's claims AFTER filtering — its own
        // consumedBlankSlots applies to siblings that come AFTER it
        // in priority order.
        if (result.consumedBlankSlots) {
          for (const idx of result.consumedBlankSlots) consumedBlankSlots.add(idx);
        }
        // Also treat THIS source's actual produced wordIndices as
        // claimed — a higher-priority source's content-bearing result
        // suppresses lower-priority results on the same slot. Without
        // this, the priority-tiebreak in processSourceResult could
        // still overwrite an upstream content claim with a downstream
        // result when their priorities matched.
        for (const r of filteredResults) consumedBlankSlots.add(r.wordIndex);

        // Whole-buffer claim → abort strictly-lower-priority siblings.
        // Their LLM calls' results would all be wiped by the splice
        // (spanStart=0/spanEnd=text.length replaces the entire buffer),
        // so the round-trips are pure waste. We use the survived
        // (filtered) results to make the decision — a higher-priority
        // result that itself got filtered out by an EVEN-higher
        // claim shouldn't trigger further aborts.
        const textLen = context.text.length;
        const wholeBufferClaim = filteredResults.some(
          r => r.spanStart === 0 && typeof r.spanEnd === 'number' && r.spanEnd >= textLen,
        );
        if (wholeBufferClaim) {
          const claimingPriority = source.priority;
          for (let j = i + 1; j < applicableSources.length; j++) {
            if (applicableSources[j].priority < claimingPriority) {
              controllers[j].abort();
            }
          }
        }

        this.processSourceResult(
          source,
          filteredSourceResult,
          resultsByIndex,
          metrics,
          errors
        );
      }
    } else {
      // Query sources sequentially in priority order — claim propagation
      // works as designed here: each source sees the slots upstream
      // sources have already consumed.
      for (const source of applicableSources) {
        const result = await this.querySourceWithTimeout(
          source,
          withConsumed(context, consumedBlankSlots),
        );
        if (result.consumedBlankSlots) {
          for (const idx of result.consumedBlankSlots) consumedBlankSlots.add(idx);
        }
        this.processSourceResult(
          source,
          result,
          resultsByIndex,
          metrics,
          errors
        );
      }
    }

    // Convert map to array, sorted by word index (span start as a stable
    // tiebreak so two same-word sentence-cues keep buffer order — the runtime
    // registers the first at the natural index, the second at a synthetic one).
    const results = Array.from(resultsByIndex.values()).sort(
      (a, b) => a.wordIndex - b.wordIndex || (a.spanStart ?? 0) - (b.spanStart ?? 0)
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

    // Merge results (higher priority wins on conflict). The dedup key is
    // normally the word index — one alt-set per word. SENTENCE-CUE results
    // are the exception: two sentences can share ONE whitespace-word
    // (spaceless CJK, a 。 with no following space), so keying them by word
    // index alone MERGES two distinct sentences' alternatives into one cue
    // and the second sentence vanishes. Key sentence-cues by their char span
    // instead so each survives as its own result (the runtime then re-keys
    // any same-word collision to a synthetic DynDef index).
    for (const cueResult of result.results) {
      const isSentenceCue = typeof cueResult.source === 'string'
        && cueResult.source.startsWith('sentence-cue:')
        && typeof cueResult.spanStart === 'number';
      const key = isSentenceCue
        ? SENTENCE_CUE_MERGE_KEY_BASE + (cueResult.spanStart as number)
        : cueResult.wordIndex;
      const existing = resultsByIndex.get(key);
      if (!existing || cueResult.priority > existing.priority) {
        resultsByIndex.set(key, cueResult);
      } else if (cueResult.priority === existing.priority) {
        // Same priority - merge alternatives
        const merged = this.mergeResults(existing, cueResult);
        resultsByIndex.set(key, merged);
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

    // Merge altCueTips
    const altCueTips = { ...existing.altCueTips, ...incoming.altCueTips };

    return {
      ...existing,
      alternatives: Array.from(altSet),
      altCueTips: Object.keys(altCueTips).length > 0 ? altCueTips : undefined,
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

/** Spread the accumulating consumed-slots set into the per-source
 *  context view. Pure function — doesn't mutate the input context. */
function withConsumed(context: CueContext, consumed: ReadonlySet<number>): CueContext {
  if (consumed.size === 0) return context;
  const previous = new Set<number>(context.consumedBlankSlots ?? []);
  for (const idx of consumed) previous.add(idx);
  return { ...context, consumedBlankSlots: Array.from(previous) };
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
