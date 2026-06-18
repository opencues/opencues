/**
 * VariantCache — generic per-key LRU cache with internal cycling state
 * machine. Single primitive shared by every semantic-`_` source
 * (FluidBlankSource, ConfigIntentSource, TransformBlankSource).
 *
 * ## Why this exists
 *
 * Every semantic-`_` source faces the same problem: a user types `_`,
 * the LLM returns a response, the user re-types `_` on the same buffer
 * a moment later (or cycles via Up-arrow). Re-dispatching the LLM on
 * every re-trigger is wasteful — same buffer, same prompt, same
 * answer. But always serving the cached response is also wrong: real
 * providers don't return byte-identical output even at temperature=0,
 * and users rely on Up-arrow to "roll the dice" for a different
 * phrasing / rewrite / answer.
 *
 * The cache balances both: cache the first N fresh responses per
 * buffer, cycle through them on re-triggers (fast, no LLM cost), then
 * refresh with one fresh response once the cycle completes
 * (preserves variation).
 *
 * ## State machine per key
 *
 *   - building (entries.length < poolSize): every trigger is fresh,
 *     accumulates in the pool. No cache hits possible yet.
 *
 *   - cycling (entries.length == poolSize, cyclePos < poolSize):
 *     trigger serves entries[cyclePos] from cache, cyclePos++.
 *
 *   - refresh (entries.length == poolSize, cyclePos == poolSize):
 *     trigger generates fresh, FIFO-evicts oldest, cyclePos=0.
 *     Returns to cycling on the next trigger.
 *
 * Steady-state warmup result: poolSize fresh + poolSize cache hits +
 * 1 fresh + poolSize cache hits + 1 fresh + … — roughly
 * `poolSize / (poolSize + 1)` cache-hit rate during sustained
 * re-triggers. Defaults (poolSize=3): 75%.
 *
 * ## Outer LRU
 *
 * The cache is keyed by the source's `_computeCacheKey(context)` —
 * typically (buffer + provider + model + mode). The outer Map is
 * bounded by `keyCap` (default 32) with simple LRU eviction (delete +
 * re-insert on access). Switching providers / typing in many
 * different buffers naturally rolls older keys out.
 *
 * ## Lifecycle
 *
 * Instance state — the cache lives as a per-source static field, so it
 * SURVIVES across source-instance rebuilds (chrome flips
 * `supportsCycling()` per focused target; live config-sync triggers
 * reloads; without static state every cache would empty between
 * triggers). Tests MUST call `clear()` explicitly between cases
 * (`<Source>.resetVariantPoolForTest()` delegates to this).
 *
 * ## Why poolSize=3
 *
 * Picked empirically — 3 is enough cached variety that the user
 * doesn't notice repetition during normal use, small enough that the
 * cache doesn't store stale rewrites for long. Configurable per
 * source via the constructor if a specific source has different
 * needs; today every source uses the default.
 */
export class VariantCache<T> {
  private pool = new Map<string, { entries: T[]; cyclePos: number }>();

  constructor(
    private readonly poolSize: number = 3,
    private readonly keyCap: number = 32,
  ) {}

  /**
   * Decide whether to serve from the cache or dispatch fresh. Touches
   * the key's LRU recency on access. On cache-hit, advances
   * `cyclePos` so the next call moves to the next variant.
   *
   * On `kind: 'fresh'` the caller MUST `record()` the fresh value
   * after a successful dispatch so the pool keeps building.
   */
  select(key: string):
    | { kind: 'cache'; value: T; others: T[] }
    | { kind: 'fresh'; others: T[] }
  {
    let entry = this.pool.get(key);
    if (!entry) {
      entry = { entries: [], cyclePos: 0 };
      this.pool.set(key, entry);
    } else {
      // LRU recency — re-insert at the tail.
      this.pool.delete(key);
      this.pool.set(key, entry);
    }

    if (entry.entries.length < this.poolSize) {
      return { kind: 'fresh', others: entry.entries.slice() };
    }

    if (entry.cyclePos < entry.entries.length) {
      const value = entry.entries[entry.cyclePos];
      entry.cyclePos++;
      const others = entry.entries.filter((_, i) => i !== entry!.cyclePos - 1);
      return { kind: 'cache', value, others };
    }

    return { kind: 'fresh', others: entry.entries.slice() };
  }

  /**
   * Record a fresh value into the pool. Caller MUST call this after a
   * successful dispatch on the `kind: 'fresh'` branch. Handles FIFO
   * eviction at `poolSize` capacity + LRU eviction on the outer Map
   * at `keyCap`.
   */
  record(key: string, value: T): void {
    let entry = this.pool.get(key);
    if (!entry) {
      // Defensive — shouldn't happen since `select` always creates
      // the entry. Fall through gracefully.
      entry = { entries: [], cyclePos: 0 };
      this.pool.set(key, entry);
    }

    if (entry.entries.length >= this.poolSize) {
      entry.entries.shift();
    }
    entry.entries.push(value);
    entry.cyclePos = 0;

    while (this.pool.size > this.keyCap) {
      const oldest = this.pool.keys().next().value;
      if (oldest === undefined) break;
      this.pool.delete(oldest);
    }
  }

  /** Number of cached entries for a key (for telemetry + tests). */
  size(key: string): number {
    return this.pool.get(key)?.entries.length ?? 0;
  }

  /** Read-only snapshot of the cached entries for a key. */
  entries(key: string): readonly T[] {
    return this.pool.get(key)?.entries ?? [];
  }

  /** Test-only: empty the cache. Production code must NEVER call this. */
  clear(): void {
    this.pool.clear();
  }
}
