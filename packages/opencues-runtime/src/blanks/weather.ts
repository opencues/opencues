// WeatherControl — current weather for a city via Open-Meteo (free, no
// API key). Read-only. 5-minute cache per city. Two-step fetch:
// geocode the location name → pull current temperature + WMO weather
// code at the resolved lat/lon. Output: "<temp>°C <description>"
// (e.g. "13°C Partly cloudy").
//
// Location detection: keyword is the trigger ("weather"); the city is
// extracted from the surrounding context words (everything except a
// short skip-list of trigger / time / determiner words). Mirrors the
// behaviour of the legacy weather-blank.sh.

import type { Blank } from './types';

const WMO_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Hail thunderstorm', 99: 'Heavy hail',
};

const SKIP_WORDS: ReadonlySet<string> = new Set([
  'weather', 'forecast', 'temp', 'temperature',
  'current', 'today', 'tonight', 'tomorrow', 'weekend',
  'weekly', '7day', '7days', 'week', 'day', 'days', 'next', 'now', '_',
]);

const CACHE_TTL_MS = 300_000;
const DEFAULT_LOCATION = 'London';

export interface WeatherControlOptions {
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
  /** Default city to use when no location can be extracted from context. */
  readonly defaultLocation?: string;
}

export class WeatherControl implements Blank {
  readonly name = 'weather';
  readonly readOnly = true;
  private readonly _fetch: typeof fetch;
  private readonly _defaultLocation: string;
  private readonly _cache = new Map<string, { result: string; ts: number }>();

  constructor(opts: WeatherControlOptions = {}) {
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._defaultLocation = opts.defaultLocation ?? DEFAULT_LOCATION;
  }

  async get(_keyword?: string, context?: string[]): Promise<string> {
    const location = this.extractLocation(context) ?? this._defaultLocation;
    const cacheKey = location.toLowerCase();

    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

    try {
      const geoResp = await this._fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
      );
      const geoData = (await geoResp.json()) as { results?: { latitude: number; longitude: number }[] };
      if (!geoData.results?.length) return `Unknown location: ${location}`;
      const { latitude, longitude } = geoData.results[0];

      const wxResp = await this._fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`,
      );
      const wxData = (await wxResp.json()) as { current?: { temperature_2m: number; weather_code: number } };
      const current = wxData.current;
      if (!current) return `Weather: error for ${location}`;

      const temp = `${Math.round(current.temperature_2m)}°C`;
      const desc = WMO_CODES[current.weather_code] ?? '';
      const display = `${temp} ${desc}`.trim();

      this._cache.set(cacheKey, { result: display, ts: Date.now() });
      return display;
    } catch {
      return `Weather: error for ${location}`;
    }
  }

  /** Walk the context list from the end picking the first non-skip word. */
  private extractLocation(context?: string[]): string | null {
    if (!context?.length) return null;
    for (let i = context.length - 1; i >= 0; i -= 1) {
      if (!SKIP_WORDS.has(context[i].toLowerCase())) return context[i];
    }
    return null;
  }
}
