/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * countries — fetches country facts from restcountries.com.
 *
 * Triggered by phrases like `population of france _`, `capital of japan _`.
 * One blank covers many facts; the keyword phrase tells us which field
 * to surface. Cached for 24h per country in ctx.storage.
 *
 * Migrated from the TS class at
 * packages/opencues-runtime/src/blanks/countries.ts (May 2026).
 */

const ENDPOINT = 'https://restcountries.com/v3.1/name';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const FACT_PATTERNS = [
  [/population of|population/i, 'population'],
  [/capital of|capital/i, 'capital'],
  [/currenc(y|ies) of|currency/i, 'currency'],
  [/region of|region|continent of/i, 'region'],
  [/language(s)? of|language/i, 'languages'],
  [/area of|area|size of/i, 'area'],
];

const SKIP_WORDS = new Set([
  'of', 'the', 'a', 'an', 'is', '_',
  'population', 'capital', 'currency', 'currencies',
  'region', 'continent', 'language', 'languages',
  'area', 'size',
]);

function pickFact(keyword) {
  if (!keyword) return null;
  for (const [re, key] of FACT_PATTERNS) {
    if (re.test(keyword)) return key;
  }
  return null;
}

function pickCountry(keyword, context) {
  const all = [keyword, ...(context || [])]
    .filter(Boolean)
    .flatMap(s => s.toLowerCase().split(/\s+/))
    .filter(w => w && !SKIP_WORDS.has(w));
  return all.join(' ').trim();
}

function formatFact(fact, entry) {
  switch (fact) {
    case 'population': {
      const n = entry.population;
      if (n == null) return 'unknown';
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
      return String(n);
    }
    case 'capital': return (entry.capital && entry.capital[0]) || 'unknown';
    case 'region': return entry.region || 'unknown';
    case 'area': {
      const a = entry.area;
      if (a == null) return 'unknown';
      return a.toLocaleString('en-US') + ' km²';
    }
    case 'currency': {
      const cs = entry.currencies;
      if (!cs) return 'unknown';
      const code = Object.keys(cs)[0];
      const name = cs[code] && cs[code].name;
      return name ? `${name} (${code})` : code;
    }
    case 'languages': {
      const ls = entry.languages;
      if (!ls) return 'unknown';
      return Object.values(ls).slice(0, 3).join(', ');
    }
  }
  return 'unknown';
}

export default {
  async get(ctx, args) {
    // args = [keyword, ...contextWords]. Keyword is the matched
    // phrase (e.g. "population of"); the trailing words are the
    // surrounding text.
    const keyword = args[0];
    const context = args.slice(1);

    const fact = pickFact(keyword);
    const country = pickCountry(keyword, context);
    if (!fact) return '';
    if (!country) return `${fact}: no country`;

    // 24h cache per (country, fact) — country data is stable.
    const cacheKey = `country:${country}`;
    const tsKey = `ts:${country}`;
    const cachedRaw = await ctx.storage.get(cacheKey);
    const cacheTsStr = await ctx.storage.get(tsKey);
    const cacheTs = cacheTsStr ? parseInt(cacheTsStr, 10) : 0;
    let entry;
    if (cachedRaw && ctx.now() - cacheTs < CACHE_TTL_MS) {
      try { entry = JSON.parse(cachedRaw); } catch { entry = null; }
    }

    if (!entry) {
      let resp;
      try {
        resp = await ctx.fetch(`${ENDPOINT}/${encodeURIComponent(country)}`);
      } catch (e) {
        return `${country}: error`;
      }
      if (!resp.ok) {
        return resp.status === 404 ? `${country}: not found` : `${country}: HTTP ${resp.status}`;
      }
      const data = await resp.json();
      if (!data || !data.length) return `${country}: not found`;
      entry = data[0];
      await ctx.storage.set(cacheKey, JSON.stringify(entry));
      await ctx.storage.set(tsKey, String(ctx.now()));
    }

    // Embed (country, fact) in the answer so `blankReplace: auto`
    // produces self-contained output when the trigger is wiped
    // ("population of france _" → "France population: 66.4M").
    const prettyCountry = country
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return `${prettyCountry} ${fact}: ${formatFact(fact, entry)}`;
  },
};
