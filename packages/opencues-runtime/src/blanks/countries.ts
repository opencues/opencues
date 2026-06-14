// CountriesBlank — fetches country facts from a free v2-clone of
// REST Countries. Read-only. 24h cache per country.
//
// Trigger phrases like "population of france", "capital of japan",
// "currency of brazil" → resolve <fact> + <country>, fetch the
// country, return the requested field.
//
// Design note: a single blank can surface multiple facts. The BLANK.md
// exposes it via several keywords (population of, capital of, etc.)
// and the keyword tells us which field to extract.
//
// Data source note (June 2026): restcountries.com/v3.1 was deprecated
// in 2026, v5 requires an auth key. This blank uses a community-run
// v2 clone at countries-api-836d.onrender.com — same schema as the
// pre-deprecation REST Countries v2 API. The endpoint is free but
// hosted on Render's free tier, so the first request after ~15 min
// of inactivity may take 30-60s (cold start). Long-term path: bundle
// a static dataset (mledoze/countries) so the blank doesn't depend
// on any third-party API for read-only data that doesn't change
// frequently. Tracked in plan.md § Countries data source.

import type { Blank } from './types';

const CACHE_TTL_MS = 86_400_000; // 24h — country data is stable
const ENDPOINT = 'https://countries-api-836d.onrender.com/countries/name';

// Keyword phrase fragment → which field to surface.
// Order matters for partial matches (longest-first wins via sort).
const FACT_PATTERNS: Array<[RegExp, FactKey]> = [
  [/population of|population/i,   'population'],
  [/capital of|capital/i,         'capital'],
  [/currenc(y|ies) of|currency/i, 'currency'],
  [/region of|region|continent of/i, 'region'],
  [/language(s)? of|language/i,   'languages'],
  [/area of|area|size of/i,       'area'],
];

type FactKey = 'population' | 'capital' | 'currency' | 'region' | 'languages' | 'area';

// REST Countries v2-clone schema (countries-api-836d.onrender.com):
// flatter than v3.1 — name is a string, capital is a string, and
// currencies/languages are arrays of objects rather than keyed records.
interface CountryApiEntry {
  name?: string;
  capital?: string;
  population?: number;
  region?: string;
  area?: number;
  currencies?: Array<{ code?: string; name?: string; symbol?: string }>;
  languages?: Array<{ iso639_1?: string; iso639_2?: string; name?: string; nativeName?: string }>;
}

const SKIP_WORDS: ReadonlySet<string> = new Set([
  'of', 'the', 'a', 'an', 'is', '_',
  'population', 'capital', 'currency', 'currencies',
  'region', 'continent', 'language', 'languages',
  'area', 'size',
]);

export interface CountriesBlankOptions {
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
  /** Override TTL for testing (default 24h). */
  readonly cacheTtlMs?: number;
}

export class CountriesBlank implements Blank {
  readonly name = 'countries';
  readonly readOnly = true;
  private readonly _fetch: typeof fetch;
  private readonly _ttl: number;
  // Cache the full country object — multiple fact-keys can read from one fetch.
  private readonly _cache = new Map<string, { data: CountryApiEntry; ts: number }>();

  constructor(opts: CountriesBlankOptions = {}) {
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  }

  async get(keyword?: string, context?: string[]): Promise<string> {
    // Fact comes from the keyword phrase ("population of"), country
    // comes from the surrounding context.
    const fact = pickFact(keyword);
    const country = pickCountry(keyword, context);
    if (!fact) return '';
    if (!country) return `${fact}: no country`;

    let entry = this._cached(country);
    if (!entry) {
      try {
        const resp = await this._fetch(`${ENDPOINT}/${encodeURIComponent(country)}`);
        if (!resp.ok) {
          return resp.status === 404 ? `${country}: not found` : `${country}: HTTP ${resp.status}`;
        }
        const data = (await resp.json()) as CountryApiEntry[];
        if (!data?.length) return `${country}: not found`;
        entry = pickBestMatch(country, data);
        this._cache.set(country.toLowerCase(), { data: entry, ts: Date.now() });
      } catch {
        return `${country}: error`;
      }
    }

    const prettyCountry = country
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return `${prettyCountry} ${fact}: ${formatFact(fact, entry)}`;
  }

  private _cached(country: string): CountryApiEntry | undefined {
    const c = this._cache.get(country.toLowerCase());
    return c && Date.now() - c.ts < this._ttl ? c.data : undefined;
  }
}

function pickFact(keyword?: string): FactKey | null {
  if (!keyword) return null;
  for (const [re, key] of FACT_PATTERNS) {
    if (re.test(keyword)) return key;
  }
  return null;
}

function pickCountry(keyword?: string, context?: string[]): string {
  // Strip the fact phrase from the keyword + concat with context, then
  // remove skip-words. The remaining content word is the country name.
  const all = [keyword, ...(context ?? [])]
    .filter(Boolean)
    .flatMap(s => s!.toLowerCase().split(/\s+/))
    .filter(w => w && !SKIP_WORDS.has(w));
  // Country names can be multi-word ("united states", "south africa") —
  // just join the remaining words. REST Countries handles the search.
  return all.join(' ').trim();
}

/**
 * The v2-clone returns multiple hits for ambiguous queries — "india"
 * returns both "British Indian Ocean Territory" + "India"; "united
 * states" returns "United States Minor Outlying Islands" before "United
 * States of America". `data[0]` picks the wrong one. Two-pass rank:
 *   1. exact case-insensitive name match (best);
 *   2. shortest name (works for both cases — "India" beats "British
 *      Indian Ocean Territory", "United States of America" beats
 *      "United States Minor Outlying Islands" by length).
 */
function pickBestMatch(query: string, data: CountryApiEntry[]): CountryApiEntry {
  const q = query.toLowerCase().trim();
  for (const c of data) {
    if ((c.name ?? '').toLowerCase() === q) return c;
  }
  let best = data[0];
  let bestLen = (best.name ?? '').length || Infinity;
  for (const c of data) {
    const len = (c.name ?? '').length;
    if (len && len < bestLen) {
      best = c;
      bestLen = len;
    }
  }
  return best;
}

function formatFact(fact: FactKey, entry: CountryApiEntry): string {
  switch (fact) {
    case 'population': {
      const n = entry.population;
      if (n == null) return 'unknown';
      // Pretty print: "67.7M" / "1.4B" / commas
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
      return String(n);
    }
    case 'capital': return entry.capital ?? 'unknown';
    case 'region':  return entry.region ?? 'unknown';
    case 'area': {
      const a = entry.area;
      if (a == null) return 'unknown';
      return `${a.toLocaleString('en-US')} km²`;
    }
    case 'currency': {
      const cs = entry.currencies;
      if (!cs?.length) return 'unknown';
      const first = cs[0];
      const code = first.code ?? '';
      const name = first.name ?? '';
      if (name && code) return `${name} (${code})`;
      return name || code || 'unknown';
    }
    case 'languages': {
      const ls = entry.languages;
      if (!ls?.length) return 'unknown';
      return ls.slice(0, 3).map(l => l.name).filter(Boolean).join(', ');
    }
  }
}
