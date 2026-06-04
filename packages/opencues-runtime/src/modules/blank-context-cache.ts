/**
 * Blank-as-context snapshot cache.
 *
 * Holds per-(blank,slot) values fetched via the blank's existing
 * `Blank.get(slot)` method. Refresh is lazy on prompt-build — there is
 * no background cron. Idle cost is zero.
 *
 * Capacity cap mirrors the sentinels-validator chokepoint shape:
 * exceeding the cap silently evicts the oldest entries. Failed fetches
 * surface as `[STALE]` markers in the snapshot rather than blocking
 * the prompt build.
 *
 * Design: docs/architecture/blank-as-context.md.
 */

import type {
  BlankContextSlot,
  BlankContextSnapshot,
  ResolvedBlankContextField,
} from '@opencues/core';
import type { Blank } from '../blanks/types';

interface CacheEntry {
  /** Token (the key in the snapshot's catalog). */
  token: string;
  description: string;
  /** Cached fetched value, or null when last fetch errored. */
  value: string | null;
  /** Wall-clock ms of last fetch. */
  fetchedAt: number;
  /** TTL for this slot (per-blank config). */
  ttlMs: number;
}

export interface BlankContextCacheOptions {
  /** Hard cap on cached tuples. Defaults to 32 — matches the
   *  sentinels-validator chokepoint shape. */
  readonly capacity?: number;
  /** Override Date.now (test seam). */
  readonly now?: () => number;
}

export class BlankContextCache {
  private readonly _cache = new Map<string, CacheEntry>(); // key = token
  private readonly _capacity: number;
  private readonly _now: () => number;

  constructor(opts: BlankContextCacheOptions = {}) {
    this._capacity = opts.capacity ?? 32;
    this._now = opts.now ?? Date.now;
  }

  /**
   * Build a snapshot for the requested slots. Each slot whose cache
   * entry is fresh (within ttlMs of last fetch) is reused; the rest
   * are fetched via `blanks.get(blankName).get(slot)`. Errors surface
   * as `[STALE]` values; the snapshot is still produced.
   */
  async snapshot(
    plan: readonly BlankContextSlot[],
    blanks: ReadonlyMap<string, Blank>,
    perBlankTtlMs: ReadonlyMap<string, number>,
  ): Promise<BlankContextSnapshot> {
    const fields: ResolvedBlankContextField[] = [];
    const catalog = new Map<string, string>();

    for (const slot of plan) {
      const ttl = perBlankTtlMs.get(slot.blankName) ?? 60_000;
      let entry = this._cache.get(slot.token);
      if (!entry || this._now() - entry.fetchedAt > ttl || entry.value === null) {
        // Stale or absent — re-fetch.
        const blank = blanks.get(slot.blankName);
        let value: string | null = null;
        if (blank) {
          try {
            value = await blank.get(slot.slot);
          } catch {
            value = null;
          }
        }
        entry = {
          token: slot.token,
          description: slot.description,
          value,
          fetchedAt: this._now(),
          ttlMs: ttl,
        };
        this._cache.set(slot.token, entry);
        this._evictIfOver();
      }
      const resolved = entry.value ?? '[STALE]';
      fields.push({ token: slot.token, description: slot.description, value: resolved });
      catalog.set(slot.token, resolved);
    }

    return { fields, catalog };
  }

  /** Drop everything. Useful when sentinels change (so bound slots
   *  invalidate). */
  clear(): void {
    this._cache.clear();
  }

  /** For tests + diagnostics. */
  size(): number {
    return this._cache.size;
  }

  private _evictIfOver(): void {
    if (this._cache.size <= this._capacity) return;
    // Map preserves insertion order; oldest first. Drop until at cap.
    const overby = this._cache.size - this._capacity;
    let dropped = 0;
    for (const token of this._cache.keys()) {
      if (dropped >= overby) break;
      this._cache.delete(token);
      dropped++;
    }
  }
}
