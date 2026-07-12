// LocationBlank — place / address lookup via OpenStreetMap Nominatim
// (free, no API key). Read-only. 24h cache per query — places don't
// churn, and Nominatim's usage policy asks callers to cache results.
// One-step fetch: free-form search, first hit's display_name is the
// answer ("east finchley iceland location _" → "Iceland, High Road,
// Finchley, London Borough of Barnet, …, N2 8AQ, United Kingdom").
//
// Query extraction: the shape's captured arg arrives as the context
// words; the keyword ("location" / "address" / "where is") is the
// trigger, not part of the query. Leading filler is stripped so
// `address of buckingham palace _` queries "buckingham palace".
//
// Misses and failures return `[err] …` — BlankFill treats that prefix
// as feedback (fills only the `_`, never consumes the typed command),
// so the user can fix the query and re-fire instead of retyping.

import type { Blank } from './types';

const CACHE_TTL_MS = 86_400_000; // 24h
const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
// Nominatim's usage policy requires an identifying User-Agent (native
// hosts). Browsers own their UA header and silently drop this one —
// there the extension's Origin/Referer identifies the traffic instead.
const USER_AGENT = 'OpenCues (+https://github.com/opencues/opencues)';

// Filler that can lead the captured arg without being part of the
// place ("address of buckingham palace _", "location for the office _").
const LEADING_FILLER: ReadonlySet<string> = new Set([
  'of', 'for', 'the', 'a', 'an', 'in', 'at', 'near', 'to', 'is',
]);

// One line, status-line friendly. display_name can run long
// (full admin hierarchy); keep the head — name + street lead it.
const MAX_LEN = 140;

interface NominatimHit {
  display_name?: string;
}

export interface LocationBlankOptions {
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
  /** Override TTL for testing (default 24h). */
  readonly cacheTtlMs?: number;
}

export class LocationBlank implements Blank {
  readonly name = 'location';
  readonly readOnly = true;
  private readonly _fetch: typeof fetch;
  private readonly _ttl: number;
  private readonly _cache = new Map<string, { value: string; ts: number }>();

  constructor(opts: LocationBlankOptions = {}) {
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  }

  async get(_keyword?: string, context?: string[]): Promise<string> {
    const query = buildQuery(context);
    if (!query) return '[err] location: add a place (e.g. "east finchley iceland location _")';

    const cacheKey = query.toLowerCase();
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._ttl) return cached.value;

    try {
      const resp = await this._fetch(
        `${ENDPOINT}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1`,
        { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } },
      );
      if (!resp.ok) return `[err] location: HTTP ${resp.status}`;
      const hits = (await resp.json()) as NominatimHit[];
      const displayName = hits?.[0]?.display_name;
      if (!displayName) return `[err] location: no match for "${query}"`;

      const value = displayName.length > MAX_LEN
        ? `${displayName.slice(0, MAX_LEN - 3).trimEnd()}...`
        : displayName;
      this._cache.set(cacheKey, { value, ts: Date.now() });
      return value;
    } catch {
      return '[err] location: lookup failed';
    }
  }
}

/** Join the captured-arg context words into the search query, dropping
 *  `_` and leading filler. Exported for direct testing. */
export function buildQuery(context?: string[]): string {
  const words = (context ?? []).filter(w => w && w !== '_');
  while (words.length && LEADING_FILLER.has(words[0].toLowerCase())) words.shift();
  return words.join(' ').trim();
}
