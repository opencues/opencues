// LocationBlank — place / address lookup via OpenStreetMap Nominatim
// (free, no API key). Read-only. 24h cache per query — places don't
// churn, and Nominatim's usage policy asks callers to cache results.
//
// TWO output modes, selected by the trigger keyword:
//   * location / address → the terse one-line address (display_name).
//   * map                → a rich "location card": name, address, opening
//     hours, phone, website (from OSM `extratags`) + a Google Maps link
//     built from the coordinates ("east finchley iceland map _"). OSM has
//     no ratings/reviews/photos (those are Google-proprietary) — the card
//     is everything the free OSM data gives, formatted for a text buffer,
//     and the Maps link is the one-click bridge to the rest.
//
// Query extraction: the shape's captured arg arrives as the context
// words; the keyword (location / address / map) is the trigger, not part
// of the query. Leading filler is stripped so `address of buckingham
// palace _` queries "buckingham palace".
//
// Misses and failures return `[err] …` — BlankFill treats that prefix as
// feedback (fills only the `_`, never consumes the typed command), so the
// user can fix the query and re-fire instead of retyping.

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

// Trigger keywords that select the RICH card instead of the terse address.
const RICH_KEYWORDS: ReadonlySet<string> = new Set(['map']);

// One line, status-line friendly. display_name can run long
// (full admin hierarchy); keep the head — name + street lead it.
const MAX_LEN = 140;

interface NominatimHit {
  display_name?: string;
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  namedetails?: { name?: string } | null;
  extratags?: Record<string, string> | null;
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
  // Cache the raw hit (not a formatted string) so the terse + map modes
  // share one fetch per query.
  private readonly _cache = new Map<string, { hit: NominatimHit; ts: number }>();

  constructor(opts: LocationBlankOptions = {}) {
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  }

  async get(keyword?: string, context?: string[]): Promise<string> {
    const rich = RICH_KEYWORDS.has((keyword ?? '').toLowerCase());
    const label = rich ? 'map' : 'location';
    const query = buildQuery(context);
    if (!query) {
      return rich
        ? '[err] map: add a place (e.g. "british museum map _")'
        : '[err] location: add a place (e.g. "east finchley iceland location _")';
    }

    const cacheKey = query.toLowerCase();
    const cached = this._cache.get(cacheKey);
    let hit = cached && Date.now() - cached.ts < this._ttl ? cached.hit : null;

    if (!hit) {
      try {
        const resp = await this._fetch(
          `${ENDPOINT}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1` +
            '&extratags=1&namedetails=1&addressdetails=1',
          { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } },
        );
        if (!resp.ok) return `[err] ${label}: HTTP ${resp.status}`;
        const hits = (await resp.json()) as NominatimHit[];
        const first = hits?.[0];
        if (!first?.display_name) return `[err] ${label}: no match for "${query}"`;
        hit = first;
        this._cache.set(cacheKey, { hit, ts: Date.now() });
      } catch {
        return `[err] ${label}: lookup failed`;
      }
    }

    return rich ? formatCard(hit, query) : formatTerse(hit);
  }
}

/** Terse one-line address (the `location` / `address` mode). */
function formatTerse(hit: NominatimHit): string {
  const name = hit.display_name ?? '';
  return name.length > MAX_LEN ? `${name.slice(0, MAX_LEN - 3).trimEnd()}...` : name;
}

/** A "Google Maps style" card from OSM data (the `map` mode). Only lines
 *  with data are included; the Google Maps link (from coordinates, or the
 *  query if OSM gave none) is ALWAYS present — the one-click bridge to the
 *  map / photos / reviews OSM can't provide. Exported for direct testing. */
export function formatCard(hit: NominatimHit, query: string): string {
  const et = hit.extratags ?? {};
  const full = (hit.display_name ?? '').trim();
  const name = (hit.namedetails?.name ?? '').trim();

  const lines: string[] = [];
  // Header = POI name; body = address (name prefix stripped to avoid the
  // repeat, since display_name for a POI leads with the name).
  if (name && full.toLowerCase().startsWith(name.toLowerCase())) {
    lines.push(name);
    const body = full.slice(name.length).replace(/^[\s,]+/, '');
    if (body) lines.push(body);
  } else if (name) {
    lines.push(name, full);
  } else {
    lines.push(full);
  }

  const hours = et['opening_hours'];
  if (hours) lines.push(`Hours: ${hours}`);

  const phone = et['contact:phone'] ?? et['phone'];
  const website = et['website'] ?? et['contact:website'];
  const contact = [phone, website].filter(Boolean).join(' · ');
  if (contact) lines.push(contact);

  const mapLink = hit.lat && hit.lon
    ? `https://www.google.com/maps/search/?api=1&query=${hit.lat},${hit.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  lines.push(`Map: ${mapLink}`);

  return lines.join('\n');
}

/** Join the captured-arg context words into the search query, dropping
 *  `_` and leading filler. Exported for direct testing. */
export function buildQuery(context?: string[]): string {
  const words = (context ?? []).filter(w => w && w !== '_');
  while (words.length && LEADING_FILLER.has(words[0].toLowerCase())) words.shift();
  return words.join(' ').trim();
}
