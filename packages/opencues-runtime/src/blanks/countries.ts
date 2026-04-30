// CountriesBlank — fetches country facts from restcountries.com
// (no auth, no rate limit beyond reasonable). Read-only. 24h cache
// per (country, fact) pair.
//
// Trigger phrases like "population of france", "capital of japan",
// "currency of brazil" → resolve <fact> + <country>, fetch the
// country, return the requested field.
//
// Design note: REST Countries returns a rich object per country,
// so a single control can surface multiple facts. The cue.md exposes
// it via several keywords (population of, capital of, currency of, ...)
// and the keyword tells us which field to extract.

import type { Blank } from './types';

const CACHE_TTL_MS = 86_400_000; // 24h — country data is stable
const ENDPOINT = 'https://restcountries.com/v3.1/name';

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

interface CountryApiEntry {
  name?: { common?: string };
  capital?: string[];
  population?: number;
  region?: string;
  area?: number;
  currencies?: Record<string, { name?: string; symbol?: string }>;
  languages?: Record<string, string>;
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
        entry = data[0];
        this._cache.set(country.toLowerCase(), { data: entry, ts: Date.now() });
      } catch {
        return `${country}: error`;
      }
    }

    return formatFact(fact, entry);
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
    case 'capital': return entry.capital?.[0] ?? 'unknown';
    case 'region':  return entry.region ?? 'unknown';
    case 'area': {
      const a = entry.area;
      if (a == null) return 'unknown';
      return `${a.toLocaleString('en-US')} km²`;
    }
    case 'currency': {
      const cs = entry.currencies;
      if (!cs) return 'unknown';
      const code = Object.keys(cs)[0];
      const name = cs[code]?.name;
      return name ? `${name} (${code})` : code;
    }
    case 'languages': {
      const ls = entry.languages;
      if (!ls) return 'unknown';
      return Object.values(ls).slice(0, 3).join(', ');
    }
  }
}
