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

const FRANCE = [{
  name: { common: 'France' },
  capital: ['Paris'],
  population: 67750000,
  region: 'Europe',
  area: 551695,
  currencies: { EUR: { name: 'Euro', symbol: '€' } },
  languages: { fra: 'French' },
}];

describe('CountriesBlank', () => {
  it('returns "<fact>: no country" when keyword has no country context', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('population of', [])).toBe('population: no country');
  });

  it('extracts country from context + formats population in M', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('population of', ['france'])).toBe('67.8M');
  });

  it('extracts capital correctly', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('capital of', ['france'])).toBe('Paris');
  });

  it('formats currency as "<name> (<code>)"', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('currency of', ['france'])).toBe('Euro (EUR)');
  });

  it('formats area with km² suffix', async () => {
    const ctl = new CountriesBlank({ fetchFn: fetchOk(FRANCE) });
    expect(await ctl.get('area of', ['france'])).toBe('551,695 km²');
  });

  it('returns first 3 languages joined', async () => {
    const india = [{ ...FRANCE[0], languages: { hin: 'Hindi', eng: 'English', tam: 'Tamil', tel: 'Telugu' } }];
    const ctl = new CountriesBlank({ fetchFn: fetchOk(india) });
    expect(await ctl.get('languages of', ['india'])).toBe('Hindi, English, Tamil');
  });

  it('caches on country (multiple facts → single fetch)', async () => {
    const fetchFn = vi.fn(fetchOk(FRANCE));
    const ctl = new CountriesBlank({ fetchFn: fetchFn as unknown as typeof fetch, cacheTtlMs: 60_000 });
    await ctl.get('population of', ['france']);
    await ctl.get('capital of', ['france']);
    await ctl.get('currency of', ['france']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
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
    expect(await ctl.get('population of', ['india'])).toBe('1.4B');
  });
});
