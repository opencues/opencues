import { describe, it, expect, vi } from 'vitest';
import { WeatherControl } from './weather';

interface FetchPlan {
  geo?: unknown;
  weather?: unknown;
  geoFails?: boolean;
  weatherFails?: boolean;
}

function makeFetch(plan: FetchPlan): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('geocoding-api')) {
      if (plan.geoFails) throw new Error('geo down');
      return {
        ok: true,
        json: async () => plan.geo ?? { results: [{ latitude: 51.5, longitude: -0.13 }] },
      } as Response;
    }
    if (u.includes('api.open-meteo')) {
      if (plan.weatherFails) throw new Error('wx down');
      return {
        ok: true,
        json: async () => plan.weather ?? { current: { temperature_2m: 13.6, weather_code: 2 } },
      } as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe('WeatherControl', () => {
  it('returns "<temp>°C <desc>" for the resolved location', async () => {
    const ctl = new WeatherControl({ fetchFn: makeFetch({}) });
    expect(await ctl.get('weather', ['weather', 'london'])).toBe('14°C Partly cloudy');
  });

  it("strips trigger/time words and uses the last meaningful token as location", async () => {
    const fetchFn = makeFetch({});
    const ctl = new WeatherControl({ fetchFn });
    await ctl.get('weather', ['weather', 'tomorrow', 'tokyo', 'today']);
    // Geocode call must have asked about tokyo (last non-skip word).
    const calls = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(calls[0][0]).toContain('name=tokyo');
  });

  it('falls back to defaultLocation when context is all skip-words', async () => {
    const fetchFn = makeFetch({});
    const ctl = new WeatherControl({ fetchFn, defaultLocation: 'Berlin' });
    await ctl.get('weather', ['weather', 'today', 'now']);
    const calls = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(calls[0][0]).toContain('name=Berlin');
  });

  it('returns "Unknown location: <name>" when geocode has no results', async () => {
    const ctl = new WeatherControl({ fetchFn: makeFetch({ geo: { results: [] } }) });
    expect(await ctl.get('weather', ['weather', 'narnia'])).toBe('Unknown location: narnia');
  });

  it('caches subsequent lookups for the same city within TTL', async () => {
    const fetchFn = makeFetch({});
    const ctl = new WeatherControl({ fetchFn });
    await ctl.get('weather', ['paris']);
    await ctl.get('weather', ['Paris']); // case-insensitive cache
    const calls = (fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls;
    // Only the first lookup hits geocode + weather endpoints.
    expect(calls.length).toBe(2);
  });

  it('returns "Weather: error for <loc>" on geocode throw', async () => {
    const ctl = new WeatherControl({ fetchFn: makeFetch({ geoFails: true }) });
    expect(await ctl.get('weather', ['lisbon'])).toBe('Weather: error for lisbon');
  });

  it('returns "Weather: error for <loc>" on weather throw', async () => {
    const ctl = new WeatherControl({ fetchFn: makeFetch({ weatherFails: true }) });
    expect(await ctl.get('weather', ['lisbon'])).toBe('Weather: error for lisbon');
  });
});
