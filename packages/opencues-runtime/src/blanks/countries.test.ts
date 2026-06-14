import { describe, it, expect, vi } from 'vitest';
import { CountriesBlank } from './countries';

function fetchOk(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response)) as unknown as typeof fetch;
}

// V2-clone schema (countries-api-836d.onrender.com) — June 2026.
// name is a string, capital is a string, currencies + languages
// are arrays of objects. See countries.ts § Data source note.
const FRANCE = [{
  name: 'France',
  capital: 'Paris',
  population: 67750000,
  region: 'Europe',
  area: 551695,
  currencies: [{ code: 'EUR', name: 'Euro', symbol: '€' }],
  languages: [{ iso639_1: 'fr', iso639_2: 'fra', name: 'French', nativeName: 'français' }],
}];

describe('CountriesBlank', () => {
  it('returns "<fact>: no country" when keyword has no country context', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('population of', [])).toBe('population: no country');
  });

  it('extracts country from context + formats population in M', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('population of', ['france'])).toBe('France population: 67.8M');
  });

  it('extracts capital correctly', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('capital of', ['france'])).toBe('France capital: Paris');
  });

  it('formats currency as "<name> (<code>)"', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('currency of', ['france'])).toBe('France currency: Euro (EUR)');
  });

  it('formats area with km² suffix', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('area of', ['france'])).toBe('France area: 551,695 km²');
  });

  it('returns first 3 languages joined', async () => {
    const india = [{ ...FRANCE[0], languages: [
      { name: 'Hindi' },
      { name: 'English' },
      { name: 'Tamil' },
      { name: 'Telugu' },
    ] }];
    const ctl = new CountriesBlank({ fetchFn: fetchOk(india) });
    expect(await ctl.get('languages of', ['india'])).toBe('India languages: Hindi, English, Tamil');
  });

  it('caches on country (multiple facts → single fetch)', async () => {
    const fetchFn = vi.fn(fetchOk(FRANCE));
    const ctl = new CountriesBlank({ fetchFn: fetchFn as unknown as typeof fetch, cacheTtlMs: 60_000 });
    await ctl.get('population of', ['france']);
    await ctl.get('capital of', ['france']);
    await ctl.get('currency of', ['france']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('disambiguates multi-hit responses by exact name match first, shortest second', async () => {
    // The v2-clone returns multiple countries for ambiguous queries
    // (e.g. "india" → British Indian Ocean Territory + India; "united
    // states" → United States Minor Outlying Islands + United States
    // of America). pickBestMatch picks the right one.
    const indiaResponse = [
      { ...FRANCE[0], name: 'British Indian Ocean Territory', capital: 'Diego Garcia',
        languages: [{ name: 'English' }] },
      { ...FRANCE[0], name: 'India', capital: 'New Delhi',
        languages: [{ name: 'Hindi' }, { name: 'English' }] },
    ];
    const ctl = new CountriesBlank({ fetchFn: fetchOk(indiaResponse) });
    expect(await ctl.get('capital of', ['india'])).toBe('India capital: New Delhi');
    expect(await ctl.get('languages of', ['india'])).toBe('India languages: Hindi, English');
  });

  it('disambiguates multi-word query by shortest-name fallback when no exact match', async () => {
    // "united states" doesn't exactly match either result; shortest name wins.
    const usResponse = [
      { ...FRANCE[0], name: 'United States Minor Outlying Islands', capital: '' },
      { ...FRANCE[0], name: 'United States of America', capital: 'Washington, D.C.' },
    ];
    const ctl = new CountriesBlank({ fetchFn: fetchOk(usResponse) });
    // prettyCountry uses the QUERY string (the user typed "united
    // states"), not the API's longer name — so the prefix stays
    // "United States" even though the matched entry is "United
    // States of America".
    expect(await ctl.get('capital of', ['united states'])).toBe('United States capital: Washington, D.C.');
  });

  it('returns "<country>: not found" for HTTP 404', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk({}, 404) });
    expect(await ctl.get('population of', ['atlantis'])).toBe('atlantis: not found');
  });

  it('returns "<country>: error" on fetch throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const ctl = new CountriesBlank({ fetchFn });
    expect(await ctl.get('population of', ['france'])).toBe('france: error');
  });

  it('handles multi-word country names ("united states")', async () => {
    const fetchFn = vi.fn(fetchOk(FRANCE));
    const ctl = new CountriesBlank({ fetchFn: fetchFn as unknown as typeof fetch });
    await ctl.get('population of', ['united', 'states']);
    const url = String((fetchFn as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(url).toContain('united%20states');
  });

  it('formats population >= 1B as "X.YB"', async () => {
    const india = [{ ...FRANCE[0], population: 1428000000 }];
    const ctl = new CountriesBlank({ fetchFn: fetchOk(india) });
    expect(await ctl.get('population of', ['india'])).toBe('India population: 1.4B');
  });
});
